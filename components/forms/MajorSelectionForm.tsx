import React, { useState } from "react";

export function MajorSelectionForm({
    tool,
    addToolOutput,
    sendMessage,
    mockPrograms,
    studentType = "undergrad",
}: {
    tool: any;
    addToolOutput: any;
    sendMessage: any;
    mockPrograms?: { name: string }[];
    studentType?: "undergrad" | "honors" | "graduate";
}) {
    const [query, setQuery] = useState("");
    const [programs, setPrograms] = useState<{ name: string }[]>([]);
    const [filtered, setFiltered] = useState<{ name: string }[]>([]);
    const [selected, setSelected] = useState("");
    const [loading, setLoading] = useState(false);
    const [fetched, setFetched] = useState(false);
    const isGraduate = studentType === "graduate";
    const programType = isGraduate ? "graduate_no_gen_ed" : "major";

    // Lazy-load on first focus or when switching to "I know" path
    const fetchPrograms = async () => {
        if (fetched) return;
        setLoading(true);
        try {
            if (mockPrograms) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                setPrograms(mockPrograms);
                setFiltered(mockPrograms);
                return;
            }
            const res = await fetch(`/api/programs?type=${programType}`);
            const data = await res.json();
            setPrograms(data.programs ?? []);
            setFiltered(data.programs ?? []);
        } finally {
            setLoading(false);
            setFetched(true);
        }
    };

    const handleSearch = (val: string) => {
        setQuery(val);
        setSelected("");
        setFiltered(
            programs.filter((p) => p.name.toLowerCase().includes(val.toLowerCase()))
        );
    };

    const handleKnowSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!selected) return;
        addToolOutput({
            tool: tool.toolName,
            toolCallId: tool.toolCallId,
            output: { selectedProgram: selected, programType },
        });
        sendMessage({
            text: isGraduate
                ? "[System: Graduate program confirmed as '" +
                selected +
                "'. Now immediately call selectMajorCourses with programName='" +
                selected +
                "' and programType='graduate_no_gen_ed' - do not ask the user, just invoke the tool.]"
                : "[System: Major confirmed as '" +
                selected +
                "'. Now immediately call selectMajorCourses with programName='" +
                selected +
                "' - do not ask the user, just invoke the tool.]",
        });
    };

    const handleNeedHelp = () => {
        addToolOutput({
            tool: tool.toolName,
            toolCallId: tool.toolCallId,
            output: { action: "needsHelp", programType },
        });
        sendMessage({
            text: isGraduate
                ? "[System: The user doesn't know their graduate program yet. Please ask the 6 career-discovery questions, then use queryPrograms with programType='graduate_no_gen_ed'.]"
                : "[System: The user doesn't know their major yet. Please ask the 6 career-discovery questions.]",
        });
    };

    return (
        <div className="mt-4 w-[380px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
            <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {isGraduate ? "Select Your Graduate Program" : "Select Your Major"}
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                    {isGraduate
                        ? "Already know your graduate program? Search for it below. Or let us help you decide."
                        : "Already know your major? Search for it below. Or let us help you decide."}
                </p>
            </div>

            <div className="p-5 space-y-4">
                {/* Autocomplete search */}
                <form onSubmit={handleKnowSubmit} className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                            Search Programs
                        </label>
                        <input
                            type="text"
                            placeholder="e.g. Information Systems..."
                            value={query}
                            onFocus={fetchPrograms}
                            onChange={(e) => handleSearch(e.target.value)}
                            className="w-full rounded-xl border border-zinc-300 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm"
                        />
                        {loading && (
                            <p className="text-xs text-zinc-400 px-1">Loading programs...</p>
                        )}
                    </div>

                    {/* Filtered results list */}
                    {fetched && filtered.length > 0 && (
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                            {filtered.map((p) => (
                                <label
                                    key={p.name}
                                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all text-sm ${selected === p.name
                                        ? "border-black bg-zinc-50 dark:border-white dark:bg-zinc-900"
                                        : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                                        }`}
                                >
                                    <input
                                        type="radio"
                                        name="major"
                                        value={p.name}
                                        checked={selected === p.name}
                                        onChange={() => setSelected(p.name)}
                                        className="w-4 h-4 accent-black dark:accent-white shrink-0"
                                    />
                                    <span className="font-medium">{p.name}</span>
                                </label>
                            ))}
                        </div>
                    )}
                    {fetched && filtered.length === 0 && query && (
                        <p className="text-xs text-zinc-400 px-1">
                            No programs match your search.
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={!selected}
                        className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
                    >
                        {isGraduate ? "Confirm Graduate Program" : "Confirm Major"}
                    </button>
                </form>

                <div className="relative flex items-center">
                    <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
                    <span className="mx-3 text-xs text-zinc-400">or</span>
                    <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
                </div>

                <button
                    type="button"
                    onClick={handleNeedHelp}
                    className="w-full rounded-xl bg-zinc-100 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                    {isGraduate ? "Help me choose a graduate program" : "Help me choose a major"}
                </button>
            </div>
        </div>
    );
}
