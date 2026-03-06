export interface ScaffoldCourse {
    code: string;
    title: string;
    credits: number;
    source: 'major' | 'minor' | 'genEd' | 'placeholder';
    programName?: string;
    programId?: string;
    requirementId?: string;
    requirementDescription?: string;
    prerequisite?: string;
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
    userId: string;
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
    selectedProgramIds: string[];
    completedCourseCodes?: string[];
}

// Global in-memory store for dev. In prod, use Redis/DB.
type GlobalWithGradStore = typeof globalThis & {
    gradStore?: Map<string, ScaffoldState>;
};

const globalWithGradStore = globalThis as GlobalWithGradStore;
const globalStore = globalWithGradStore.gradStore ?? new Map<string, ScaffoldState>();
if (!globalWithGradStore.gradStore) {
    globalWithGradStore.gradStore = globalStore;
}

export const store = globalStore;
