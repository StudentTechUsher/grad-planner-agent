import React, { useState, useMemo, useEffect } from "react";
import { CheckCircle2 } from "lucide-react";

export interface ProgramReq {
    requirementId: number | string;
    description: string;
    notes?: string;
    courses?: {
        code: string;
        title: string;
        credits: number;
        prerequisite?: string;
        status?: string;
    }[];
    subRequirements?: {
        requirementId: string;
        description: string;
        courses: {
            code: string;
            title: string;
            credits: number;
            prerequisite?: string;
            status?: string;
        }[];
    }[];
    otherRequirement?: string;
}

export function ProgramCourseSelectionForm({
    tool,
    addToolOutput,
    sendMessage,
    type,
    transcriptCourses: transcriptCoursesProp,
    mockRequirements,
}: {
    tool: any;
    addToolOutput: any;
    sendMessage: any;
    type: "major" | "minor";
    transcriptCourses: any[];
    mockRequirements?: ProgramReq[];
}) {
    const programName: string = tool.args?.programName ?? "";
    const [requirements, setRequirements] = useState<ProgramReq[]>([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [selections, setSelections] = useState<Record<string, string[]>>({});
    const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
    const [searchQ, setSearchQ] = useState<Record<string, string>>({});
    const [submitted, setSubmitted] = useState(false);

    const transcriptCodes = useMemo(
        () =>
            new Set(
                transcriptCoursesProp.map((c: any) =>
                    `${c.subject}${c.number}`.replace(/\s+/g, "").toUpperCase()
                )
            ),
        [transcriptCoursesProp]
    );

    const [stableProgramName, setStableProgramName] = useState("");
    useEffect(() => {
        if (!programName) return;
        const timer = setTimeout(() => setStableProgramName(programName), 300);
        return () => clearTimeout(timer);
    }, [programName]);

    function parseSlotInfo(
        desc: string,
        courseCount: number
    ): { required: number; total: number } {
        const xOfY = desc.match(/Complete\s+(\d+)\s+of\s+(\d+)\s+Course/i);
        if (xOfY) return { required: parseInt(xOfY[1]), total: parseInt(xOfY[2]) };
        const nCourses = desc.match(/Complete\s+(\d+)\s+Course/i);
        if (nCourses) return { required: parseInt(nCourses[1]), total: courseCount };
        return { required: 1, total: courseCount };
    }

    function normCode(code: string): string {
        return code.replace(/\s+/g, "").toUpperCase();
    }

    function isCourseCompleted(code: string): boolean {
        return transcriptCodes.has(normCode(code));
    }

    useEffect(() => {
        if (!stableProgramName && !mockRequirements) return;
        let cancelled = false;
        setLoading(true);
        setFetchError(null);
        (async () => {
            try {
                let reqs: ProgramReq[] = [];
                if (mockRequirements) {
                    await new Promise((r) => setTimeout(r, 400));
                    reqs = mockRequirements;
                } else {
                    const res = await fetch(
                        `/api/program-requirements?program=${encodeURIComponent(
                            stableProgramName
                        )}&type=${type}`
                    );
                    if (cancelled) return;
                    if (!res.ok) throw new Error("Failed to load requirements");
                    const data = await res.json();
                    reqs = data.programRequirements ?? [];
                }

                if (cancelled) return;
                setRequirements(reqs);
                if (reqs.length > 0)
                    setExpandedIds({ [String(reqs[0].requirementId)]: true });

                const autoSelections: Record<string, string[]> = {};
                for (const req of reqs) {
                    for (const slot of getSlots(req)) {
                        const activeCourses = slot.courses.filter(
                            (c) => !c.status || c.status === "active"
                        );
                        const info = parseSlotInfo(slot.label, activeCourses.length);

                        const transcriptMatches = activeCourses.filter((c) =>
                            transcriptCodes.has(normCode(c.code))
                        );

                        if (info.required === activeCourses.length) {
                            autoSelections[slot.id] = activeCourses.map((c) => c.code);
                        } else if (transcriptMatches.length >= info.required) {
                            autoSelections[slot.id] = transcriptMatches
                                .slice(0, info.required)
                                .map((c) => c.code);
                        } else if (transcriptMatches.length > 0) {
                            autoSelections[slot.id] = transcriptMatches.map((c) => c.code);
                        }
                    }
                }
                if (Object.keys(autoSelections).length > 0 && !cancelled) {
                    setSelections(autoSelections);
                }
            } catch (e: any) {
                if (!cancelled) setFetchError(e.message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stableProgramName, transcriptCodes, mockRequirements]);

    function getSlots(req: ProgramReq) {
        const slots: {
            id: string;
            label: string;
            courses: NonNullable<ProgramReq["courses"]>;
        }[] = [];
        if (req.courses?.length)
            slots.push({
                id: String(req.requirementId),
                label: req.description,
                courses: req.courses,
            });
        if (req.subRequirements) {
            for (const sub of req.subRequirements) {
                if (sub.courses?.length)
                    slots.push({
                        id: sub.requirementId,
                        label: sub.description,
                        courses: sub.courses,
                    });
            }
        }
        return slots;
    }

    function toggleCourse(slotId: string, code: string, maxSelect: number) {
        setSelections((prev) => {
            const current = prev[slotId] ?? [];
            if (current.includes(code)) {
                return { ...prev, [slotId]: current.filter((c) => c !== code) };
            }
            if (current.length >= maxSelect) {
                return { ...prev, [slotId]: [...current.slice(1), code] };
            }
            return { ...prev, [slotId]: [...current, code] };
        });
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitted) return;
        setSubmitted(true);

        const selectedCourses: any[] = [];
        for (const req of requirements) {
            for (const slot of getSlots(req)) {
                const codes = selections[slot.id] ?? [];
                for (const code of codes) {
                    const c = slot.courses.find((x) => x.code === code);
                    if (c)
                        selectedCourses.push({
                            ...c,
                            source: type,
                            requirementId: slot.id,
                            requirementDescription: slot.label,
                            fromTranscript: isCourseCompleted(c.code),
                        });
                }
            }
        }

        const planId =
            (typeof window !== "undefined" && sessionStorage.getItem("gradPlanId")) ||
            crypto.randomUUID();
        if (typeof window !== "undefined")
            sessionStorage.setItem("gradPlanId", planId);
        fetch("/api/scaffold", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId, phase: type, courses: selectedCourses }),
        }).catch(console.error);

        addToolOutput({
            tool: tool.toolName,
            toolCallId: tool.toolCallId,
            output: {
                programName,
                selectedCourses,
                courseCount: selectedCourses.length,
            },
        });

        const next =
            type === "major"
                ? "[System: Major course selections submitted. Now immediately call requestMinorSelection - do not ask the user, just invoke the tool.]"
                : "[System: Minor course selections submitted. Now immediately call selectGenEdCourses - do not ask the user, just invoke the tool.]";
        sendMessage({ text: next });
    };

    const filledCount = Object.values(selections)
        .flat()
        .filter(Boolean).length;
    const totalSlots = requirements.reduce(
        (n, r) => n + getSlots(r).length,
        0
    );

    const unsatisfiedCount = requirements.reduce((n, req) => {
        for (const slot of getSlots(req)) {
            const activeCourses = slot.courses.filter(
                (c) => !c.status || c.status === "active"
            );
            const { required } = parseSlotInfo(slot.label, activeCourses.length);
            const selected = (selections[slot.id] ?? []).length;
            if (selected < required) n++;
        }
        return n;
    }, 0);
    const isFormComplete = requirements.length > 0 && unsatisfiedCount === 0;

    if (submitted) {
        return (
            <div className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
                <CheckCircle2 size={14} />
                {type === "major" ? "Major" : "Minor"} course selections submitted (
                {filledCount} courses)
            </div>
        );
    }

    if (loading)
        return (
            <div className="mt-4 w-[460px] rounded-2xl border border-zinc-200 dark:border-zinc-800 px-5 py-6 text-sm text-zinc-400">
                Loading {programName} requirements...
            </div>
        );
    if (fetchError)
        return (
            <div className="mt-4 w-[460px] rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 px-5 py-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-red-600 dark:text-red-400">
                        Failed to load requirements
                    </p>
                    <p className="text-xs text-red-400 dark:text-red-500 mt-0.5 truncate">
                        {fetchError}
                    </p>
                </div>
                <button
                    onClick={() => {
                        setFetchError(null);
                        setStableProgramName("");
                        setTimeout(() => setStableProgramName(programName), 50);
                    }}
                    className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-800/40 transition-colors border border-red-200 dark:border-red-700"
                >
                    Retry
                </button>
            </div>
        );

    return (
        <div className="mt-4 w-[500px] overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 shadow-md">
            <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-5 py-4">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                    Select {type === "major" ? "Major" : "Minor"} Courses
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                    {programName} &middot; {filledCount} courses selected
                </p>
                <div className="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                        className="h-1.5 rounded-full bg-black dark:bg-white transition-all"
                        style={{
                            width: `${totalSlots > 0
                                    ? Math.min(100, (filledCount / totalSlots) * 100)
                                    : 0
                                }%`,
                        }}
                    />
                </div>
            </div>

            <form onSubmit={handleSubmit}>
                <div className="max-h-[500px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
                    {requirements.map((req) => {
                        const id = String(req.requirementId);
                        const isOpen = !!expandedIds[id];
                        const slots = getSlots(req);

                        return (
                            <div key={id}>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setExpandedIds((p) => ({ ...p, [id]: !p[id] }))
                                    }
                                    className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
                                >
                                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                                        {req.description}
                                    </span>
                                    <span className="text-zinc-400 text-xs ml-2">
                                        {isOpen ? "▲" : "▼"}
                                    </span>
                                </button>

                                {isOpen && (
                                    <div className="px-5 pb-4 space-y-4">
                                        {req.otherRequirement && (
                                            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800">
                                                {req.otherRequirement}
                                            </p>
                                        )}
                                        {req.notes && (
                                            <p className="text-xs text-zinc-500 italic">
                                                {typeof req.notes === "string" ? req.notes : ""}
                                            </p>
                                        )}

                                        {slots.map((slot) => {
                                            const activeCourses = slot.courses.filter(
                                                (c) => !c.status || c.status === "active"
                                            );
                                            const info = parseSlotInfo(
                                                slot.label,
                                                activeCourses.length
                                            );
                                            const q = searchQ[slot.id] ?? "";
                                            const vis = q
                                                ? activeCourses.filter(
                                                    (c) =>
                                                        c.code
                                                            .toLowerCase()
                                                            .includes(q.toLowerCase()) ||
                                                        c.title
                                                            .toLowerCase()
                                                            .includes(q.toLowerCase())
                                                )
                                                : activeCourses;
                                            const sel = selections[slot.id] ?? [];
                                            const isAutoAll = info.required === activeCourses.length;

                                            const transcriptMatches = activeCourses.filter((c) =>
                                                isCourseCompleted(c.code)
                                            );
                                            const isFulfilledByTranscript =
                                                transcriptMatches.length >= info.required;

                                            return (
                                                <div key={slot.id} className="space-y-2">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                                            {slot.label}
                                                        </p>
                                                        {isAutoAll && (
                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 font-medium">
                                                                All required
                                                            </span>
                                                        )}
                                                        {isFulfilledByTranscript && (
                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-medium flex items-center gap-1">
                                                                <CheckCircle2 size={10} /> Requirement fulfilled
                                                            </span>
                                                        )}
                                                        {!isAutoAll && info.required > 1 && (
                                                            <span className="text-[10px] text-zinc-400">
                                                                ({sel.length}/{info.required} selected)
                                                            </span>
                                                        )}
                                                    </div>

                                                    {activeCourses.length > 5 && (
                                                        <input
                                                            type="text"
                                                            placeholder="Search courses..."
                                                            value={q}
                                                            onChange={(e) =>
                                                                setSearchQ((p) => ({
                                                                    ...p,
                                                                    [slot.id]: e.target.value,
                                                                }))
                                                            }
                                                            className="w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-black dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-white"
                                                        />
                                                    )}
                                                    <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                                        {vis.map((c) => {
                                                            const isSelected = sel.includes(c.code);
                                                            const isFromTranscript = isCourseCompleted(
                                                                c.code
                                                            );
                                                            const isDisabled = isAutoAll;

                                                            return (
                                                                <label
                                                                    key={`${slot.id}-${c.code}`}
                                                                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all text-xs ${isDisabled
                                                                            ? "cursor-default"
                                                                            : "cursor-pointer"
                                                                        } ${isSelected
                                                                            ? "border-black bg-zinc-50 dark:border-white dark:bg-zinc-900"
                                                                            : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                                                                        }`}
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={isSelected}
                                                                        disabled={isDisabled}
                                                                        onChange={() => {
                                                                            if (isDisabled) return;
                                                                            if (info.required === 1) {
                                                                                setSelections((p) => ({
                                                                                    ...p,
                                                                                    [slot.id]: isSelected ? [] : [c.code],
                                                                                }));
                                                                            } else {
                                                                                toggleCourse(
                                                                                    slot.id,
                                                                                    c.code,
                                                                                    info.required
                                                                                );
                                                                            }
                                                                        }}
                                                                        className="w-3.5 h-3.5 accent-black dark:accent-white shrink-0"
                                                                    />
                                                                    <span className="font-mono text-zinc-400 shrink-0">
                                                                        {c.code}
                                                                    </span>
                                                                    <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                                                                        {c.title}
                                                                    </span>
                                                                    <span className="ml-auto text-zinc-400 shrink-0">
                                                                        {c.credits} cr
                                                                    </span>
                                                                    {isFromTranscript && (
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-700 shrink-0 font-medium">
                                                                            ✓ Completed
                                                                        </span>
                                                                    )}
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                    {sel.length > 0 && !isAutoAll && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setSelections((p) => ({ ...p, [slot.id]: [] }))
                                                            }
                                                            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 underline"
                                                        >
                                                            Clear
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                <div className="border-t border-zinc-200 dark:border-zinc-800 px-5 py-4 space-y-2">
                    <button
                        type="submit"
                        disabled={!isFormComplete}
                        className={`w-full rounded-xl py-3 text-sm font-medium transition-all shadow-sm ${isFormComplete
                                ? "bg-black text-white dark:bg-white dark:text-black hover:scale-[1.02]"
                                : "bg-zinc-200 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600 cursor-not-allowed"
                            }`}
                    >
                        {isFormComplete
                            ? `Submit ${filledCount} Course${filledCount !== 1 ? "s" : ""
                            }`
                            : `${unsatisfiedCount} requirement${unsatisfiedCount !== 1 ? "s" : ""
                            } left to fill`}
                    </button>

                    <button
                        type="button"
                        onClick={() => {
                            setSubmitted(true);
                            addToolOutput({
                                tool: tool.toolName,
                                toolCallId: tool.toolCallId,
                                output: { action: "skipped" },
                            });
                            sendMessage({
                                text: `[System: User chose to skip selecting courses for ${type === "major" ? "Major" : "Minor"
                                    }. Check with them on how they want to proceed or move to the next step.]`,
                            });
                        }}
                        className="w-full rounded-xl py-3 text-sm font-medium transition-all text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                        Skip / Choose Something Else
                    </button>
                </div>
            </form>
        </div>
    );
}
