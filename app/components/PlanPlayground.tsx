import React from 'react';

type ScaffoldCourse = {
    code: string;
    title: string;
    credits: number;
    source: string;
    requirementId?: string;
    requirementDescription?: string;
    programName?: string;
};

type ScaffoldTerm = {
    term: string;
    courses: ScaffoldCourse[];
    credits_planned: number;
};

type ScaffoldMilestone = {
    id: string;
    type: string;
    title: string;
    afterTerm: string;
};

interface PlanPlaygroundProps {
    planData: { plan: ScaffoldTerm[]; milestones?: ScaffoldMilestone[] } | null;
    isBuilding?: boolean;
    preferences?: {
        maxCreditsPerTerm?: number;
        minCreditsPerTerm?: number;
        genEdStrategy?: string;
        graduationPace?: string;
    };
}

type PlaygroundPreferences = PlanPlaygroundProps['preferences'];

const CourseItem = ({ course }: { course: ScaffoldCourse }) => {
    return (
        <div className="flex items-center justify-between p-3 mb-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm text-sm group transition-all hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-md">
            <div className="flex flex-col overflow-hidden">
                <span className="font-bold text-zinc-900 dark:text-zinc-100">{course.code}</span>
                <span className="text-xs text-zinc-500 truncate">{course.title}</span>
            </div>
            <div className="shrink-0 text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 rounded text-zinc-700 dark:text-zinc-300 ml-3">
                {course.credits} cr
            </div>
        </div>
    );
};

const MilestoneCard = ({ milestone }: { milestone: ScaffoldMilestone }) => (
    <div className="w-full rounded-xl border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/30 px-4 py-3 shadow-sm">
        <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-sky-600 dark:text-sky-400">
            Milestone
        </div>
        <div className="mt-1 text-sm font-semibold text-sky-900 dark:text-sky-200">
            {milestone.title}
        </div>
    </div>
);

const TermCard = ({ termData, preferences }: { termData: ScaffoldTerm, preferences?: PlaygroundPreferences }) => {
    const actualCredits = termData.courses.reduce((sum, c) => sum + (c.credits || 0), 0);

    const isHalfTerm = termData.term.toLowerCase().includes('spring') || termData.term.toLowerCase().includes('summer');
    const maxCredits = preferences?.maxCreditsPerTerm ?? 15;
    const minCredits = preferences?.minCreditsPerTerm ?? 12;

    const currentMax = isHalfTerm ? Math.ceil(maxCredits / 2) : maxCredits;
    const currentMin = isHalfTerm ? Math.ceil(minCredits / 2) : minCredits;

    const isOver = actualCredits > currentMax;
    const isUnder = actualCredits > 0 && actualCredits < currentMin;

    let headerColor = "bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border-b border-zinc-300 dark:border-zinc-700";
    let borderColor = "border-zinc-300 dark:border-zinc-700";

    if (isOver) {
        headerColor = "bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-300 border-b border-red-300 dark:border-red-800";
        borderColor = "border-red-300 dark:border-red-800 ring-1 ring-red-300 dark:ring-red-800";
    } else if (isUnder) {
        headerColor = "bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-300 border-b border-orange-300 dark:border-orange-800";
        borderColor = "border-orange-300 dark:border-orange-800 ring-1 ring-orange-300 dark:ring-orange-800";
    }

    return (
        <div className={`flex flex-col rounded-xl border ${borderColor} bg-zinc-50 dark:bg-zinc-950 w-full shadow-sm`}>
            <header className={`flex items-center justify-between px-4 py-3 ${headerColor} rounded-t-xl`}>
                <h3 className="font-semibold text-sm tracking-tight">{termData.term}</h3>
                <span className="text-xs font-bold tracking-tight bg-white/50 dark:bg-black/20 px-2 py-0.5 rounded-full">{actualCredits} / {currentMax} cr</span>
            </header>
            <div className="p-3">
                {termData.courses.length > 0 ? (
                    termData.courses.map((course, idx) => (
                        <CourseItem key={`${course.code}-${idx}`} course={course} />
                    ))
                ) : (
                    <div className="text-xs text-zinc-400 italic text-center py-8">No courses planned</div>
                )}
            </div>
            {(isOver || isUnder) && (
                <div className={`px-4 py-2 text-xs font-medium border-t rounded-b-xl ${isOver ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-900/50' : 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900/50'}`}>
                    {isOver ? `Exceeds max of ${currentMax} credits!` : `Below min of ${currentMin} credits!`}
                </div>
            )}
        </div>
    );
};

export default function PlanPlayground({ planData, preferences, isBuilding }: PlanPlaygroundProps) {
    if (!planData || !planData.plan || planData.plan.length === 0) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-4 p-8 bg-zinc-50 dark:bg-zinc-950 relative">
                {isBuilding && (
                    <div className="absolute top-6 right-6 flex items-center gap-2 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-full text-xs font-medium border border-indigo-100 dark:border-indigo-800/50 shadow-sm animate-pulse">
                        <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Agent is generating plan...
                    </div>
                )}
                <div className="w-20 h-20 border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-2xl flex items-center justify-center bg-white dark:bg-zinc-900 shadow-sm">
                    <span className="text-3xl opacity-50">🎓</span>
                </div>
                <p className="text-sm font-medium">Agentic Playground not populated yet.</p>
                <p className="text-xs text-zinc-500 max-w-xs text-center">The agent will build the graduation plan here visually as you proceed.</p>
            </div>
        );
    }

    const milestonesByAfterTerm = (planData.milestones ?? []).reduce<Record<string, ScaffoldMilestone[]>>((acc, milestone) => {
        if (!acc[milestone.afterTerm]) acc[milestone.afterTerm] = [];
        acc[milestone.afterTerm].push(milestone);
        return acc;
    }, {});

    return (
        <div className="flex flex-col h-full w-full overflow-y-auto p-6 gap-4 bg-zinc-100/50 dark:bg-zinc-900/20">
            {planData.plan.map((term) => (
                <React.Fragment key={term.term}>
                    <TermCard termData={term} preferences={preferences} />
                    {(milestonesByAfterTerm[term.term] ?? []).map((milestone) => (
                        <MilestoneCard key={milestone.id} milestone={milestone} />
                    ))}
                </React.Fragment>
            ))}

            {isBuilding && (
                <div className="flex flex-col rounded-xl border border-dashed border-indigo-300 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-900/10 w-full shadow-sm items-center justify-center min-h-[180px]">
                    <div className="flex flex-col items-center gap-3 p-6 text-indigo-500 dark:text-indigo-400">
                        <svg className="animate-spin h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span className="text-sm font-medium animate-pulse">Agent is thinking...</span>
                        <span className="text-xs text-center opacity-70">Running heuristics constraints</span>
                    </div>
                </div>
            )}
        </div>
    );
}
