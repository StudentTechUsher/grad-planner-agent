import { ScaffoldCourse, ScaffoldState, StudentType } from '../store';

type GenericObject = Record<string, unknown>;

type UIMessageToolInvocation = {
    state?: string;
    toolName?: string;
    result?: unknown;
};

const isObject = (value: unknown): value is GenericObject =>
    typeof value === 'object' && value !== null;

const isToolResultState = (state: unknown): boolean =>
    state === 'result' || state === 'output-available';

const hasToolResultPayload = (candidate: GenericObject): boolean =>
    isToolResultState(candidate.state) || candidate.result !== undefined || candidate.output !== undefined;

export const safeCourse = (candidate: unknown, source: ScaffoldCourse['source']): ScaffoldCourse | null => {
    if (!isObject(candidate) || typeof candidate.code !== 'string') return null;
    return {
        code: candidate.code,
        title: typeof candidate.title === 'string' ? candidate.title : candidate.code,
        credits: typeof candidate.credits === 'number' ? candidate.credits : 3,
        source,
        requirementId: typeof candidate.requirementId === 'string' ? candidate.requirementId : undefined,
        requirementDescription: typeof candidate.requirementDescription === 'string' ? candidate.requirementDescription : undefined,
        programName: typeof candidate.programName === 'string' ? candidate.programName : undefined,
        programId: typeof candidate.programId === 'string'
            ? candidate.programId
            : typeof candidate.programId === 'number'
                ? String(candidate.programId)
                : undefined,
        prerequisite: typeof candidate.prerequisite === 'string'
            ? candidate.prerequisite
            : typeof candidate.prerequisites === 'string'
                ? candidate.prerequisites
                : undefined,
    };
};

export const normalizeCourseCode = (value: string): string =>
    value.replace(/\s+/g, '').toUpperCase();

export const getTranscriptCourseCode = (candidate: unknown): string | null => {
    if (!isObject(candidate)) return null;

    if (typeof candidate.code === 'string' && candidate.code.trim().length > 0) {
        return normalizeCourseCode(candidate.code);
    }

    const subject = typeof candidate.subject === 'string' ? candidate.subject.trim() : '';
    const numberCandidate = candidate.number;
    const number = typeof numberCandidate === 'string'
        ? numberCandidate.trim()
        : typeof numberCandidate === 'number'
            ? String(numberCandidate)
            : '';

    if (!subject || !number) return null;
    return normalizeCourseCode(`${subject}${number}`);
};

export const normalizeStudentType = (value: unknown): StudentType => {
    if (value === 'honors') return 'honors';
    if (value === 'graduate' || value === 'grad') return 'graduate';
    return 'undergrad';
};

export const extractToolInvocations = (message: unknown): UIMessageToolInvocation[] => {
    if (!isObject(message)) return [];

    const messageToolInvocations = message.toolInvocations;
    if (Array.isArray(messageToolInvocations) && messageToolInvocations.length > 0) {
        return messageToolInvocations as UIMessageToolInvocation[];
    }

    if (!Array.isArray(message.parts)) return [];

    return message.parts.flatMap((part): UIMessageToolInvocation[] => {
        if (!isObject(part) || typeof part.type !== 'string') return [];
        if (!part.type.startsWith('tool-') && part.type !== 'tool-call') return [];

        return [{
            state: part.state === 'output-available' || part.state === 'result' ? 'result' : 'call',
            toolName: typeof part.toolName === 'string'
                ? part.toolName
                : part.type.replace('tool-', ''),
            result: part.result ?? part.output,
        }];
    });
};

export const normalizePlanTerms = (candidatePlan: unknown): ScaffoldState['terms'] | null => {
    if (!Array.isArray(candidatePlan)) return null;

    return candidatePlan.map((term): ScaffoldState['terms'][number] => {
        const termObj = isObject(term) ? term : {};
        const courses = Array.isArray(termObj.courses) ? (termObj.courses as ScaffoldState['terms'][number]['courses']) : [];
        const actualCredits = courses.reduce((sum: number, c) => sum + (c?.credits || 0), 0);

        return {
            term: typeof termObj.term === 'string' ? termObj.term : 'Untitled Term',
            courses,
            credits_planned: typeof termObj.credits_planned === 'number' ? termObj.credits_planned : actualCredits,
        };
    });
};

export const normalizeMilestones = (candidateMilestones: unknown): ScaffoldState['milestones'] | null => {
    if (!Array.isArray(candidateMilestones)) return null;
    return candidateMilestones
        .map((milestone, index): ScaffoldState['milestones'][number] | null => {
            if (!isObject(milestone)) return null;
            const title = typeof milestone.title === 'string'
                ? milestone.title
                : typeof milestone.type === 'string'
                    ? milestone.type
                    : 'Milestone';
            const afterTerm = typeof milestone.afterTerm === 'string' ? milestone.afterTerm : '';
            if (!afterTerm) return null;

            return {
                id: typeof milestone.id === 'string' ? milestone.id : `milestone-${index}`,
                type: typeof milestone.type === 'string' ? milestone.type : title,
                title,
                afterTerm,
            };
        })
        .filter((milestone): milestone is ScaffoldState['milestones'][number] => milestone !== null);
};

export const addProgramIdCandidate = (target: Set<string>, candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
        target.add(candidate.trim());
        return;
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        target.add(String(candidate));
    }
};

export const createInitialState = (planId: string, userId: string): ScaffoldState => ({
    planId,
    userId,
    createdAt: Date.now(),
    hasPreferencesSet: false,
    preferences: {
        maxCreditsPerTerm: 15,
        minCreditsPerTerm: 12,
        genEdStrategy: 'balance',
        graduationPace: 'sustainable',
        studentType: 'undergrad',
        transcriptCredits: 0,
    },
    phases: [],
    terms: [],
    milestones: [],
    allCourses: [],
    selectedProgramIds: [],
    completedCourseCodes: [],
});

/**
 * Rebuilds ScaffoldState from a list of chat messages by replaying tool results.
 * This is the same logic used in the chat route to hydrate state on each request.
 * It makes message history the primary source of truth, eliminating reliance on
 * in-memory state surviving across serverless invocations.
 */
export const hydrateStateFromMessages = (
    planId: string,
    userId: string,
    messages: unknown[],
): ScaffoldState => {
    const state = createInitialState(planId, userId);

    const discoveredCourses: ScaffoldState['allCourses'] = [];
    const discoveredCompletedCourseCodes = new Set<string>();
    const discoveredProgramIds = new Set<string>();
    let latestPlanFromHistory: ScaffoldState['terms'] | null = null;
    let latestMilestonesFromHistory: ScaffoldState['milestones'] | null = null;

    for (const msg of messages) {
        const toolInvocations = extractToolInvocations(msg);
        for (const t of toolInvocations) {
            if (t.state !== 'result') continue;

            if ((t.toolName === 'requestUserPreferences' || t.toolName === 'updateUserPreferences') && isObject(t.result)) {
                state.hasPreferencesSet = true;
                const preferencePatch = { ...(t.result as Partial<ScaffoldState['preferences']>) };
                preferencePatch.studentType = normalizeStudentType(preferencePatch.studentType);
                state.preferences = { ...state.preferences, ...preferencePatch };
                if (Array.isArray(t.result.transcriptCourses)) {
                    for (const c of t.result.transcriptCourses) {
                        const completedCourseCode = getTranscriptCourseCode(c);
                        if (completedCourseCode) {
                            discoveredCompletedCourseCodes.add(completedCourseCode);
                        }
                    }
                }
            }
            if (isObject(t.result)) {
                addProgramIdCandidate(discoveredProgramIds, t.result.programId);
                addProgramIdCandidate(discoveredProgramIds, t.result.selectedProgramId);

                if (Array.isArray(t.result.programIds)) {
                    for (const programId of t.result.programIds) {
                        addProgramIdCandidate(discoveredProgramIds, programId);
                    }
                }

                if (Array.isArray(t.result.selectedProgramIds)) {
                    for (const programId of t.result.selectedProgramIds) {
                        addProgramIdCandidate(discoveredProgramIds, programId);
                    }
                }

                if (Array.isArray(t.result.selectedCourses)) {
                    for (const selectedCourse of t.result.selectedCourses) {
                        if (!isObject(selectedCourse)) continue;
                        addProgramIdCandidate(discoveredProgramIds, selectedCourse.programId);
                    }
                }
            }
            if (t.toolName === 'selectMajorCourses' && isObject(t.result) && Array.isArray(t.result.selectedCourses)) {
                for (const c of t.result.selectedCourses) {
                    const parsedCourse = safeCourse(c, 'major');
                    if (parsedCourse) discoveredCourses.push(parsedCourse);
                }
            }
            if (t.toolName === 'selectMinorCourses' && isObject(t.result) && Array.isArray(t.result.selectedCourses)) {
                for (const c of t.result.selectedCourses) {
                    const parsedCourse = safeCourse(c, 'minor');
                    if (parsedCourse) discoveredCourses.push(parsedCourse);
                }
            }
            if (t.toolName === 'selectGenEdCourses') {
                if (isObject(t.result) && isObject(t.result.genEdSelections)) {
                    for (const codes of Object.values(t.result.genEdSelections)) {
                        if (!Array.isArray(codes)) continue;
                        for (const code of codes) {
                            if (typeof code !== 'string') continue;
                            discoveredCourses.push({ code, title: code, credits: 3, source: 'genEd' });
                        }
                    }
                }
            }

            const normalizedPlan = normalizePlanTerms(isObject(t.result) ? t.result.plan : undefined);
            if (normalizedPlan) {
                latestPlanFromHistory = normalizedPlan;
            }

            const normalizedMilestones = normalizeMilestones(isObject(t.result) ? t.result.milestones : undefined);
            if (normalizedMilestones) {
                latestMilestonesFromHistory = normalizedMilestones;
            }
        }
    }

    const mergedCourseByCode = new Map<string, ScaffoldCourse>();
    for (const course of discoveredCourses) {
        if (!course || typeof course.code !== 'string') continue;
        mergedCourseByCode.set(normalizeCourseCode(course.code), course);
    }
    state.allCourses = Array.from(mergedCourseByCode.values());
    state.terms = latestPlanFromHistory ?? state.terms;
    state.milestones = latestMilestonesFromHistory ?? state.milestones;

    const mergedCompletedCodes = new Set<string>();
    for (const code of discoveredCompletedCourseCodes) {
        mergedCompletedCodes.add(code);
    }
    state.completedCourseCodes = Array.from(mergedCompletedCodes);

    const mergedProgramIds = new Set<string>();
    for (const programId of discoveredProgramIds) {
        mergedProgramIds.add(programId);
    }
    state.selectedProgramIds = Array.from(mergedProgramIds);

    if (!Array.isArray(state.milestones)) state.milestones = [];
    state.preferences.studentType = normalizeStudentType(state.preferences.studentType);

    return state;
};
