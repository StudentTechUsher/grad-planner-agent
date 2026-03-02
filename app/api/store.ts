export interface ScaffoldCourse {
    code: string;
    title: string;
    credits: number;
    source: 'major' | 'minor' | 'genEd' | 'placeholder';
    programName?: string;
    requirementId?: string;
    requirementDescription?: string;
}

export type StudentType = 'undergrad' | 'honors' | 'graduate';

export interface ScaffoldMilestone {
    id: string;
    type: string;
    title: string;
    afterTerm: string;
}

export interface ScaffoldTerm {
    term: string;
    courses: ScaffoldCourse[];
    credits_planned: number;
}

export interface ScaffoldState {
    planId: string;
    createdAt: number;
    hasPreferencesSet: boolean;
    preferences: {
        maxCreditsPerTerm: number;
        minCreditsPerTerm: number;
        genEdStrategy: "prioritize" | "balance";
        graduationPace: "fast" | "sustainable" | "undecided";
        studentType: StudentType;
        anticipatedGraduation?: string;
        transcriptCredits: number;
    };
    phases: string[];
    terms: ScaffoldTerm[];
    milestones: ScaffoldMilestone[];
    allCourses: ScaffoldCourse[];
}

// Global in-memory store for dev. In prod, use Redis/DB.
const globalStore = (global as any).gradStore || new Map<string, ScaffoldState>();
if (!(global as any).gradStore) {
    (global as any).gradStore = globalStore;
}

export const store = globalStore;

// Cleanup old scaffolds after 2 hours
if (typeof setInterval !== 'undefined') {
    setInterval(() => {
        const cutoff = Date.now() - 2 * 60 * 60 * 1000;
        for (const [id, state] of store) {
            if (state.createdAt < cutoff) store.delete(id);
        }
    }, 10 * 60 * 1000);
}
