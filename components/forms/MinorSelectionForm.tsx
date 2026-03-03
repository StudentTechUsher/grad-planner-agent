import React, { useState } from "react";

type SelectionTool = {
    toolName: string;
    toolCallId: string;
};

type ToolOutputPayload = {
    tool: string;
    toolCallId: string;
    output: Record<string, unknown>;
};

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesProgramQuery(programName: string, query: string): boolean {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return true;
    const normalizedProgramName = normalizeSearchText(programName);
    if (normalizedProgramName.includes(normalizedQuery)) return true;

    const compactQuery = normalizedQuery.replace(/\s+/g, "");
    const compactProgramName = normalizedProgramName.replace(/\s+/g, "");
    if (compactQuery && compactProgramName.includes(compactQuery)) return true;

    const queryTokens = normalizedQuery.split(" ").filter(Boolean);
    return queryTokens.length > 0 && queryTokens.every((token) => normalizedProgramName.includes(token));
}

export function MinorSelectionForm({
    tool,
    addToolOutput,
    sendMessage,
    studentType = "undergrad",
}: {
    tool: SelectionTool;
    addToolOutput: (payload: ToolOutputPayload) => void;
    sendMessage: (payload: { text: string }) => void;
    studentType?: "undergrad" | "honors" | "graduate";
}) {
    const [programs, setPrograms] = useState<{ id?: string | number; name: string }[]>([]);
    const [selectionCount, setSelectionCount] = useState<number>(0);
    const [selectedPrograms, setSelectedPrograms] = useState<string[]>([]);
    const [searchQueries, setSearchQueries] = useState<string[]>([]);
    const [openDropdownIndex, setOpenDropdownIndex] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [fetched, setFetched] = useState(false);

    const fetchPrograms = async () => {
        if (fetched) return;
        setLoading(true);
        try {
            const res = await fetch("/api/programs?type=minor");
            const data = await res.json();
            setPrograms(data.programs ?? []);
        } finally {
            setLoading(false);
            setFetched(true);
        }
    };

    const updateSelectionCount = (nextCount: number) => {
        setSelectionCount(nextCount);
        setSelectedPrograms((prev) => {
            const next = prev.slice(0, nextCount);
            while (next.length < nextCount) next.push("");
            return next;
        });
        setSearchQueries((prev) => {
            const next = prev.slice(0, nextCount);
            while (next.length < nextCount) next.push("");
            return next;
        });
    };

    const handleProgramChange = (index: number, value: string) => {
        setSelectedPrograms((prev) => {
            const next = [...prev];
            next[index] = value;
            return next;
        });
    };

    const handleSearchQueryChange = (index: number, value: string) => {
        setSearchQueries((prev) => {
            const next = [...prev];
            next[index] = value;
            return next;
        });
        setSelectedPrograms((prev) => {
            const next = [...prev];
            const selectedByOtherSlots = new Set(prev.filter((name, selectedIndex) => selectedIndex !== index && name));
            const exactMatch = programs.find(
                (program) => !selectedByOtherSlots.has(program.name) && program.name.toLowerCase() === value.trim().toLowerCase(),
            );
            next[index] = exactMatch?.name ?? "";
            return next;
        });
    };

    const handleProgramSelect = (index: number, value: string) => {
        handleProgramChange(index, value);
        setSearchQueries((prev) => {
            const next = [...prev];
            next[index] = value;
            return next;
        });
        setOpenDropdownIndex(null);
    };

    const sendNextStepAfterNoMinor = () => {
        sendMessage({
            text:
                studentType === "honors"
                    ? "[System: User chose not to add minors. This student is honors-track, so now immediately call requestHonorsSelection - do not ask the user, just invoke the tool.]"
                    : "[System: User chose not to add minors. Now immediately call selectGenEdCourses - do not ask the user, just invoke the tool.]",
        });
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (selectionCount === 0) {
            addToolOutput({
                tool: tool.toolName,
                toolCallId: tool.toolCallId,
                output: { selectedProgram: null, selectedPrograms: [], selectedProgramIds: [], skipped: true, selectionCount: 0 },
            });
            sendNextStepAfterNoMinor();
            return;
        }

        const trimmedSelections = selectedPrograms.map((value) => value.trim()).filter(Boolean);
        if (trimmedSelections.length !== selectionCount) return;
        const selectedProgramIds = trimmedSelections
            .map((name) => {
                const program = programs.find((candidate) => candidate.name === name);
                return program?.id != null ? String(program.id) : null;
            })
            .filter((value): value is string => Boolean(value));
        const firstProgram = trimmedSelections[0];
        const firstProgramId = selectedProgramIds[0];
        addToolOutput({
            tool: tool.toolName,
            toolCallId: tool.toolCallId,
            output: {
                selectedProgram: firstProgram,
                selectedProgramId: firstProgramId,
                selectedPrograms: trimmedSelections,
                selectedProgramIds,
                selectionCount: trimmedSelections.length,
                skipped: false,
            },
        });
        const selectedProgramsJson = JSON.stringify(trimmedSelections);
        const selectedProgramIdsJson = JSON.stringify(selectedProgramIds);
        sendMessage({
            text: `[System: Minor selections confirmed. Now immediately call selectMinorCourses with programName="${firstProgram}", currentIndex=0, selectedPrograms=${selectedProgramsJson}, selectedProgramIds=${selectedProgramIdsJson}. Process one minor at a time in order. After each submission, if another minor remains, call selectMinorCourses for the next index.]`,
        });
    };

    const isSelectionComplete =
        selectionCount === 0 || selectedPrograms.map((value) => value.trim()).filter(Boolean).length === selectionCount;

    return (
        <div className="mt-4 w-[380px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
            <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                    Select Minors
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                    Choose up to 3 minors. We will collect courses one program at a time.
                </p>
            </div>

            <div className="p-5 space-y-4">
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Number of Minors</label>
                        <div className="grid grid-cols-4 gap-2">
                            {[0, 1, 2, 3].map((count) => (
                                <button
                                    key={count}
                                    type="button"
                                    onClick={() => updateSelectionCount(count)}
                                    className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                                        selectionCount === count
                                            ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                                            : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                                    }`}
                                >
                                    {count}
                                </button>
                            ))}
                        </div>
                    </div>

                    {selectionCount > 0 && (
                        <div className="space-y-1">
                            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Minor Choices</label>
                            <div className="space-y-2">
                                {Array.from({ length: selectionCount }).map((_, index) => {
                                    const selectedByOtherSlots = new Set(
                                        selectedPrograms.filter((name, selectedIndex) => selectedIndex !== index && name),
                                    );
                                    const availablePrograms = programs.filter((program) => !selectedByOtherSlots.has(program.name));
                                    const query = (searchQueries[index] ?? "").trim().toLowerCase();
                                    let filteredPrograms = query
                                        ? availablePrograms.filter((program) => matchesProgramQuery(program.name, query))
                                        : availablePrograms;
                                    const currentSelection = selectedPrograms[index];
                                    if (
                                        currentSelection &&
                                        !filteredPrograms.some((program) => program.name === currentSelection)
                                    ) {
                                        const currentProgram = availablePrograms.find((program) => program.name === currentSelection)
                                            ?? programs.find((program) => program.name === currentSelection);
                                        if (currentProgram) {
                                            filteredPrograms = [currentProgram, ...filteredPrograms];
                                        }
                                    }
                                    return (
                                        <div key={`minor-slot-${index}`} className="space-y-1">
                                            <input
                                                type="text"
                                                value={searchQueries[index] ?? selectedPrograms[index] ?? ""}
                                                onFocus={() => {
                                                    fetchPrograms();
                                                    setOpenDropdownIndex(index);
                                                }}
                                                onChange={(event) => handleSearchQueryChange(index, event.target.value)}
                                                onBlur={() => {
                                                    window.setTimeout(() => setOpenDropdownIndex((prev) => (prev === index ? null : prev)), 100);
                                                }}
                                                placeholder="Search minors..."
                                                className="w-full rounded-xl border border-zinc-300 px-4 py-2 text-xs outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white transition-all shadow-sm"
                                            />
                                            {openDropdownIndex === index && (
                                                <div className="max-h-44 overflow-auto rounded-xl border border-zinc-300 bg-white p-1 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                                                    {filteredPrograms.length > 0 ? (
                                                        filteredPrograms.slice(0, 50).map((program) => (
                                                            <button
                                                                key={`${index}-${program.name}`}
                                                                type="button"
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault();
                                                                    handleProgramSelect(index, program.name);
                                                                }}
                                                                className="block w-full rounded-lg px-3 py-2 text-left text-xs text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                                            >
                                                                {program.name}
                                                            </button>
                                                        ))
                                                    ) : (
                                                        <p className="px-2 py-2 text-[11px] text-zinc-400">No minors match that search.</p>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {loading && <p className="text-xs text-zinc-400 px-1">Loading minors...</p>}

                    <button
                        type="submit"
                        disabled={!isSelectionComplete}
                        className="w-full rounded-xl bg-black py-3 text-sm font-medium text-white transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed dark:bg-white dark:text-black shadow-sm"
                    >
                        {selectionCount === 0 ? "Continue Without Minors" : `Confirm ${selectionCount} Minor${selectionCount > 1 ? "s" : ""}`}
                    </button>
                </form>
            </div>
        </div>
    );
}
