import React, { useState } from "react";

export function MinorSelectionForm({
    tool,
    addToolOutput,
    sendMessage,
}: {
    tool: any;
    addToolOutput: any;
    sendMessage: any;
}) {
    const [query, setQuery] = useState("");
    const [programs, setPrograms] = useState<{ name: string }[]>([]);
    const [filtered, setFiltered] = useState<{ name: string }[]>([]);
    const [selected, setSelected] = useState("");
    const [loading, setLoading] = useState(false);
    const [fetched, setFetched] = useState(false);

    const fetchPrograms = async () => {
        if (fetched) return;
        setLoading(true);
        try {
            const res = await fetch("/api/programs?type=minor");
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

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!selected) return;
        addToolOutput({
            tool: tool.toolName,
            toolCallId: tool.toolCallId,
            output: { selectedProgram: selected },
        });
        sendMessage({
            text:
                "[System: Minor confirmed. Now immediately call selectMinorCourses with programName='" +
                selected +
                "' — do not ask the user, just invoke the tool.]",
        });
    };

    const handleSkip = () => {
        addToolOutput({
            tool: tool.toolName,
            toolCallId: tool.toolCallId,
            output: { selectedProgram: null, skipped: true },
        });
        sendMessage({
            text:
                "[System: User chose not to add a minor. Now immediately call selectGenEdCourses — do not ask the user, just invoke the tool.]",
        });
    };

    return (
        <div className="mt-4 w-[380px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
            <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                    Select a Minor
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                    Search for a minor below, or skip if you don't want one.
                </p>
            </div>

            <div className="p-5 space-y-4">
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                            Search Minors
                        </label>
                        <input
                            type="text"
                            placeholder="e.g. Mathematics, Entrepreneurship..."
                            value={query}
                            onFocus={fetchPrograms}
                            onChange={(e) => handleSearch(e.target.value)}
                            className="w-full rounded-xl border border-zinc-300 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm"
                        />
                        {loading && (
                            <p className="text-xs text-zinc-400 px-1">Loading minors...</p>
                        )}
                    </div>

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
                                        name="minor"
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
                            No minors match your search.
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={!selected}
                        className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
                    >
                        Confirm Minor
                    </button>
                </form>

                <div className="relative flex items-center">
                    <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
                    <span className="mx-3 text-xs text-zinc-400">or</span>
                    <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
                </div>

                <button
                    type="button"
                    onClick={handleSkip}
                    className="w-full rounded-xl bg-zinc-100 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                    Skip — No Minor
                </button>
            </div>
        </div>
    );
}
