import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { getAgentTools, evaluatePlanHeuristics, REQUIRED_MILESTONE_NAME } from './tools';
import fs from 'fs/promises';
import path from 'path';
import { store, ScaffoldCourse, ScaffoldState, StudentType } from '../store';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { captureServerEvent } from '@/lib/posthogServer';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

type AgentToolName = keyof ReturnType<typeof getAgentTools>;

const EDIT_TOOL_NAMES = new Set([
    'createTerm',
    'deleteTerm',
    'addCoursesToTerm',
    'removeCourseFromTerm',
]);

const MILESTONE_INSERT_TOOL_NAMES = new Set([
    'insertMilestone',
    'insertAcademicMilestone',
]);

const REPAIR_TOOL_NAMES = [
    'getRemainingCoursesToPlan',
    'createTerm',
    'deleteTerm',
    'addCoursesToTerm',
    'removeCourseFromTerm',
    'checkPlanHeuristics',
] as const satisfies readonly AgentToolName[];

const STALL_RECOVERY_TOOL_NAMES = [
    'getRemainingCoursesToPlan',
    'addCoursesToTerm',
    'removeCourseFromTerm',
    'deleteTerm',
    'checkPlanHeuristics',
] as const satisfies readonly AgentToolName[];

const MILESTONE_TOOL_NAMES = [
    'addMilestones',
    'insertMilestone',
    'insertAcademicMilestone',
] as const satisfies readonly AgentToolName[];

const FINALIZATION_TOOL_NAMES = [
    ...REPAIR_TOOL_NAMES,
    ...MILESTONE_TOOL_NAMES,
    'requestPlanReview',
] as const satisfies readonly AgentToolName[];

const BUILD_TOOL_NAMES = new Set<string>([
    ...FINALIZATION_TOOL_NAMES,
]);

type UIMessageToolInvocation = {
    state?: string;
    toolName?: string;
    result?: unknown;
};

type GenericObject = Record<string, unknown>;
type ConvertToModelMessagesInput = Parameters<typeof convertToModelMessages>[0];
type ToolCallDebugMeta = {
    toolCallId: string;
    toolName: string;
    messageIndex: number;
    hasResult: boolean;
};

const isObject = (value: unknown): value is GenericObject =>
    typeof value === 'object' && value !== null;

const isToolResultState = (state: unknown): boolean =>
    state === 'result' || state === 'output-available';

const hasToolResultPayload = (candidate: GenericObject): boolean =>
    isToolResultState(candidate.state) || candidate.result !== undefined || candidate.output !== undefined;

const safeCourse = (candidate: unknown, source: ScaffoldCourse['source']): ScaffoldCourse | null => {
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

const normalizeCourseCode = (value: string): string =>
    value.replace(/\s+/g, '').toUpperCase();

const getTranscriptCourseCode = (candidate: unknown): string | null => {
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

const normalizeStudentType = (value: unknown): StudentType => {
    if (value === 'honors') return 'honors';
    if (value === 'graduate' || value === 'grad') return 'graduate';
    return 'undergrad';
};

const extractToolInvocations = (message: unknown): UIMessageToolInvocation[] => {
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

const collectToolCallDebugMeta = (messages: unknown[]): Map<string, ToolCallDebugMeta> => {
    const byId = new Map<string, ToolCallDebugMeta>();

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex];
        if (!isObject(message)) continue;

        if (Array.isArray(message.toolInvocations)) {
            for (const invocation of message.toolInvocations) {
                if (!isObject(invocation) || typeof invocation.toolCallId !== 'string' || !invocation.toolCallId) continue;
                const toolCallId = invocation.toolCallId;
                const toolName = typeof invocation.toolName === 'string' && invocation.toolName.length > 0
                    ? invocation.toolName
                    : 'unknown';
                const hasResult = hasToolResultPayload(invocation);

                const existing = byId.get(toolCallId);
                if (!existing) {
                    byId.set(toolCallId, { toolCallId, toolName, messageIndex, hasResult });
                    continue;
                }

                if (!existing.hasResult && hasResult) existing.hasResult = true;
                if (existing.toolName === 'unknown' && toolName !== 'unknown') existing.toolName = toolName;
            }
        }

        if (!Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
            if (!isObject(part) || typeof part.toolCallId !== 'string' || !part.toolCallId) continue;
            if (typeof part.type !== 'string') continue;
            if (!part.type.startsWith('tool-') && part.type !== 'tool-call') continue;

            const toolCallId = part.toolCallId;
            const toolName = typeof part.toolName === 'string' && part.toolName.length > 0
                ? part.toolName
                : part.type.replace('tool-', '') || 'unknown';
            const hasResult = hasToolResultPayload(part);

            const existing = byId.get(toolCallId);
            if (!existing) {
                byId.set(toolCallId, { toolCallId, toolName, messageIndex, hasResult });
                continue;
            }

            if (!existing.hasResult && hasResult) existing.hasResult = true;
            if (existing.toolName === 'unknown' && toolName !== 'unknown') existing.toolName = toolName;
        }
    }

    return byId;
};

const hasUnresolvedToolCall = (message: GenericObject): boolean => {
    if (Array.isArray(message.toolInvocations)) {
        for (const invocation of message.toolInvocations) {
            if (!isObject(invocation)) continue;
            if (typeof invocation.toolCallId !== 'string' || !invocation.toolCallId) continue;
            if (!hasToolResultPayload(invocation)) return true;
        }
    }

    if (Array.isArray(message.parts)) {
        for (const part of message.parts) {
            if (!isObject(part) || typeof part.type !== 'string') continue;
            if (!part.type.startsWith('tool-') && part.type !== 'tool-call') continue;
            if (typeof part.toolCallId !== 'string' || !part.toolCallId) continue;
            if (!hasToolResultPayload(part)) return true;
        }
    }

    return false;
};

const sanitizeMessagesForModel = (
    messages: ConvertToModelMessagesInput,
): ConvertToModelMessagesInput =>
    (messages as unknown[])
        .flatMap((message) => {
            if (!isObject(message)) return [message];
            if (hasUnresolvedToolCall(message)) {
                // Drop the entire message when tool calls are unresolved.
                // Pruning individual parts can orphan OpenAI Responses `reasoning` items.
                return [];
            }
            return [message];
        }) as ConvertToModelMessagesInput;

const getMessageText = (message: unknown): string => {
    if (!isObject(message)) return '';
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.parts)) return '';

    return message.parts
        .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('');
};

const normalizePlanTerms = (candidatePlan: unknown): ScaffoldState['terms'] | null => {
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

const normalizeMilestones = (candidateMilestones: unknown): ScaffoldState['milestones'] | null => {
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

const getLatestHeuristicsFromSteps = (steps: unknown[]): { isPlanSound: boolean; totalUnplanned: number; warningsCount: number } | null => {
    let latest: { isPlanSound: boolean; totalUnplanned: number; warningsCount: number } | null = null;

    for (const step of steps) {
        if (!isObject(step)) continue;
        const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
        for (const toolResult of toolResults) {
            if (!isObject(toolResult)) continue;
            const toolName = typeof toolResult.toolName === 'string' ? toolResult.toolName : '';
            if (toolName !== 'checkPlanHeuristics') continue;

            const outputCandidate = isObject(toolResult.output)
                ? toolResult.output
                : isObject(toolResult.result)
                    ? toolResult.result
                    : {};
            const output = isObject(outputCandidate) ? outputCandidate : {};
            const warnings = Array.isArray(output.warnings) ? output.warnings : [];
            const totalUnplanned = typeof output.totalUnplanned === 'number' ? output.totalUnplanned : 0;
            const inferredSound = warnings.length === 0 && totalUnplanned === 0;
            const isPlanSound = typeof output.isPlanSound === 'boolean' ? output.isPlanSound : inferredSound;

            latest = {
                isPlanSound,
                totalUnplanned,
                warningsCount: warnings.length,
            };
        }
    }

    return latest;
};

const getPlanStats = (planCandidate: unknown): { termCount: number; trailingTermCourseCount: number } | null => {
    if (!Array.isArray(planCandidate)) return null;
    const termCount = planCandidate.length;
    if (termCount === 0) {
        return { termCount: 0, trailingTermCourseCount: 0 };
    }

    const trailingTerm = planCandidate[termCount - 1];
    if (!isObject(trailingTerm) || !Array.isArray(trailingTerm.courses)) {
        return { termCount, trailingTermCourseCount: 0 };
    }

    return {
        termCount,
        trailingTermCourseCount: trailingTerm.courses.length,
    };
};

const getRecentEditSnapshots = (
    steps: unknown[],
): Array<{ toolName: string; totalUnplanned: number; termCount: number; trailingTermCourseCount: number }> => {
    const snapshots: Array<{ toolName: string; totalUnplanned: number; termCount: number; trailingTermCourseCount: number }> = [];

    for (const step of steps) {
        if (!isObject(step)) continue;
        const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];

        for (const toolResult of toolResults) {
            if (!isObject(toolResult) || typeof toolResult.toolName !== 'string') continue;
            if (!EDIT_TOOL_NAMES.has(toolResult.toolName)) continue;

            const output = isObject(toolResult.output)
                ? toolResult.output
                : isObject(toolResult.result)
                    ? toolResult.result
                    : null;
            if (!output) continue;

            const totalUnplanned = typeof output.totalUnplanned === 'number'
                ? output.totalUnplanned
                : null;
            const stats = getPlanStats(output.plan);

            if (totalUnplanned === null || !stats) continue;

            snapshots.push({
                toolName: toolResult.toolName,
                totalUnplanned,
                termCount: stats.termCount,
                trailingTermCourseCount: stats.trailingTermCourseCount,
            });
        }
    }

    return snapshots;
};

const hasRequiredMilestone = (milestones: ScaffoldState['milestones']): boolean =>
    milestones.some((milestone) => milestone.title.toLowerCase() === REQUIRED_MILESTONE_NAME.toLowerCase());

const addProgramIdCandidate = (target: Set<string>, candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
        target.add(candidate.trim());
        return;
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        target.add(String(candidate));
    }
};

const createInitialState = (planId: string, userId: string): ScaffoldState => ({
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

// Load BYU institutional context lazily
let byuContext: string | null = null;

export async function POST(req: Request) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const jsonWithSession = (body: unknown, init?: ResponseInit) =>
        withRefreshedAgentSession(Response.json(body, init), session);

    if (byuContext === null) {
        try {
            const raw = await fs.readFile(path.join(process.cwd(), 'byu-context.json'), 'utf-8');
            byuContext = '\n\nINSTITUTION CONTEXT (BYU-specific rules — follow these strictly):\n' + raw;
        } catch {
            byuContext = ''; // File not found — continue without it
        }
    }

    const body = await req.json();
    const url = new URL(req.url);
    const planIdFromQuery = url.searchParams.get('planId');
    const bodyPlanId = isObject(body) && typeof body.planId === 'string' ? body.planId : null;
    const bodyChatId = isObject(body) && typeof body.id === 'string' ? body.id : null;
    const normalizedBodyChatId = bodyChatId
        ? bodyChatId.startsWith('chat-')
            ? bodyChatId.slice('chat-'.length)
            : bodyChatId
        : null;
    const planId = planIdFromQuery || bodyPlanId || normalizedBodyChatId;
    if (!planId) {
        return jsonWithSession({ error: 'planId is required (query ?planId=..., body.planId, or body.id).' }, { status: 400 });
    }
    const messages = (Array.isArray(body.messages) ? body.messages : []) as ConvertToModelMessagesInput;
    const latestUserMessage = [...messages].reverse().find((msg) => isObject(msg) && msg.role === 'user');
    const latestUserText = getMessageText(latestUserMessage).toLowerCase();
    const userRequestedPreferenceUpdate =
        latestUserText.includes('updateuserpreferences') ||
        (
            /(update|change|edit|modify)/.test(latestUserText) &&
            /(preference|preferences|credit|credits|pace|gen ed|gened)/.test(latestUserText)
        );
    const sanitizedMessages = sanitizeMessagesForModel(messages);
    let coreMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
    try {
        coreMessages = await convertToModelMessages(sanitizedMessages);
    } catch (error) {
        const errorWithIds = error as { toolCallIds?: unknown };
        const missingToolCallIds = Array.isArray(errorWithIds?.toolCallIds)
            ? errorWithIds.toolCallIds.filter((value): value is string => typeof value === 'string')
            : [];
        const toolCallMeta = collectToolCallDebugMeta(messages);
        const missingToolCalls = missingToolCallIds.map((toolCallId) => {
            const meta = toolCallMeta.get(toolCallId);
            return {
                toolCallId,
                toolName: meta?.toolName || 'unknown',
                messageIndex: meta?.messageIndex ?? -1,
            };
        });

        if (missingToolCallIds.length > 0) {
            void captureServerEvent('chat_missing_tool_results', 'warn', {
                route: '/api/chat',
                request: req,
                distinctId: session.userId,
                properties: { missingToolCalls },
            });
            return jsonWithSession(
                {
                    error: 'Tool result is missing for one or more tool calls.',
                    missingToolCalls,
                },
                { status: 400 },
            );
        }

        throw error;
    }
    const hasAnyToolHistory = messages.some((msg: unknown) => extractToolInvocations(msg).length > 0);

    // Hydrate the in-memory store from conversation history
    let state = store.get(planId);
    if (state?.userId && state.userId !== session.userId) {
        return jsonWithSession({ error: 'Forbidden: plan ownership mismatch.' }, { status: 403 });
    }
    if (state && !state.userId) {
        state.userId = session.userId;
    }

    if (!state || !hasAnyToolHistory) {
        state = createInitialState(planId, session.userId);
        store.set(planId, state);
    }

    if (!Array.isArray(state.milestones)) state.milestones = [];
    state.preferences.studentType = normalizeStudentType(state.preferences.studentType);

    const discoveredCourses: ScaffoldState['allCourses'] = [];
    const discoveredCompletedCourseCodes = new Set<string>();
    const discoveredProgramIds = new Set<string>();
    let hasGenEdSelections = false;
    let hasMilestoneSelections = false;
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
                hasGenEdSelections = true;
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
            if (t.toolName === 'addMilestones') {
                hasMilestoneSelections = true;
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

    // Merge discovered courses into existing course universe so we never drop courses
    // when message history is partial/truncated on later turns.
    const mergedCourseByCode = new Map<string, ScaffoldCourse>();
    const existingCourses = Array.isArray(state.allCourses) ? state.allCourses : [];
    for (const course of existingCourses) {
        if (!course || typeof course.code !== 'string') continue;
        mergedCourseByCode.set(normalizeCourseCode(course.code), course);
    }
    for (const course of discoveredCourses) {
        if (!course || typeof course.code !== 'string') continue;
        // Prefer latest discovered metadata (e.g., requirement/prerequisite tags).
        mergedCourseByCode.set(normalizeCourseCode(course.code), course);
    }
    state.allCourses = Array.from(mergedCourseByCode.values());
    state.terms = latestPlanFromHistory ?? state.terms;
    state.milestones = latestMilestonesFromHistory ?? state.milestones;
    const mergedCompletedCodes = new Set<string>(
        Array.isArray(state.completedCourseCodes)
            ? state.completedCourseCodes.map((code: string) => normalizeCourseCode(code))
            : [],
    );
    for (const code of discoveredCompletedCourseCodes) {
        mergedCompletedCodes.add(code);
    }
    state.completedCourseCodes = Array.from(mergedCompletedCodes);
    const mergedProgramIds = new Set<string>(
        Array.isArray(state.selectedProgramIds) ? state.selectedProgramIds : [],
    );
    for (const programId of discoveredProgramIds) {
        mergedProgramIds.add(programId);
    }
    state.selectedProgramIds = Array.from(mergedProgramIds);
    store.set(planId, state);

    const hydratedHeuristics = evaluatePlanHeuristics(state);
    const hasMilestoneConfiguration = hasMilestoneSelections || state.milestones.length > 0;
    const isBuildPhaseActive = hasGenEdSelections || state.terms.length > 0 || state.milestones.length > 0;

    const result = streamText({
        model: openai('gpt-5-mini'),
        stopWhen: stepCountIs(20),
        prepareStep: ({ steps }) => {
            const hasPreferenceUpdateActivity = steps.some((step) => {
                if (!isObject(step)) return false;
                const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
                const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
                const calledUpdate = toolCalls.some((toolCall) =>
                    isObject(toolCall) && toolCall.toolName === 'updateUserPreferences',
                );
                const completedUpdate = toolResults.some((toolResult) =>
                    isObject(toolResult) && toolResult.toolName === 'updateUserPreferences',
                );
                return calledUpdate || completedUpdate;
            });

            if (userRequestedPreferenceUpdate && !hasPreferenceUpdateActivity) {
                return {
                    activeTools: ['updateUserPreferences'],
                    toolChoice: 'required',
                };
            }

            const hasBuildActivity = steps.some((step) => {
                if (!isObject(step)) return false;
                const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
                const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
                return toolResults.some((result) =>
                    isObject(result) && typeof result.toolName === 'string' && BUILD_TOOL_NAMES.has(result.toolName),
                ) || toolCalls.some((result) =>
                    isObject(result) && typeof result.toolName === 'string' && BUILD_TOOL_NAMES.has(result.toolName),
                );
            });

            if (!isBuildPhaseActive && !hasBuildActivity) {
                return {};
            }

            // Always evaluate heuristics from current live store state to avoid stale
            // decisions based on an old checkPlanHeuristics result.
            const liveStateForHeuristics = store.get(planId) ?? state;
            const liveHeuristics = evaluatePlanHeuristics(liveStateForHeuristics);
            const effectiveHeuristics = {
                isPlanSound: liveHeuristics.isPlanSound,
                totalUnplanned: liveHeuristics.totalUnplanned,
                warningsCount: liveHeuristics.warnings.length,
            };
            const isHeuristicsClean = effectiveHeuristics.isPlanSound && effectiveHeuristics.totalUnplanned === 0;
            const liveTerms = Array.isArray(liveStateForHeuristics.terms) ? liveStateForHeuristics.terms : [];
            const trailingLiveTerm = liveTerms[liveTerms.length - 1];
            const trailingTermIsEmpty =
                !!trailingLiveTerm &&
                Array.isArray(trailingLiveTerm.courses) &&
                trailingLiveTerm.courses.length === 0;
            const recentEditSnapshots = getRecentEditSnapshots(steps);
            const latestEditSnapshot = recentEditSnapshots[recentEditSnapshots.length - 1];
            const previousEditSnapshot = recentEditSnapshots[recentEditSnapshots.length - 2];
            const stalledEditLoop =
                !!latestEditSnapshot &&
                !!previousEditSnapshot &&
                latestEditSnapshot.totalUnplanned >= previousEditSnapshot.totalUnplanned &&
                latestEditSnapshot.termCount === previousEditSnapshot.termCount &&
                latestEditSnapshot.trailingTermCourseCount === previousEditSnapshot.trailingTermCourseCount;

            if (effectiveHeuristics.totalUnplanned > 0 && trailingTermIsEmpty) {
                return {
                    activeTools: [...STALL_RECOVERY_TOOL_NAMES],
                    toolChoice: 'required',
                };
            }

            if (effectiveHeuristics.totalUnplanned > 0 && stalledEditLoop) {
                return {
                    activeTools: [...REPAIR_TOOL_NAMES],
                    toolChoice: 'required',
                };
            }

            const lastStep = steps[steps.length - 1];
            const lastStepHadEdit = isObject(lastStep) && Array.isArray(lastStep.toolResults)
                ? lastStep.toolResults.some((result) =>
                    isObject(result) && typeof result.toolName === 'string' && EDIT_TOOL_NAMES.has(result.toolName),
                )
                : false;

            if (lastStepHadEdit) {
                return {
                    activeTools: [...REPAIR_TOOL_NAMES],
                    toolChoice: 'required',
                };
            }

            if (!isHeuristicsClean) {
                return {
                    activeTools: [...REPAIR_TOOL_NAMES],
                    toolChoice: 'required',
                };
            }

            const milestoneConfigurationSeenInSteps = steps.some((step) => {
                if (!isObject(step)) return false;
                const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
                const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
                const calledAddMilestones = toolCalls.some((toolCall) =>
                    isObject(toolCall) && toolCall.toolName === 'addMilestones',
                );
                const completedAddMilestones = toolResults.some((toolResult) =>
                    isObject(toolResult) && toolResult.toolName === 'addMilestones',
                );
                return calledAddMilestones || completedAddMilestones;
            });

            const liveStateForMilestones = store.get(planId);
            const liveMilestones = liveStateForMilestones && Array.isArray(liveStateForMilestones.milestones)
                ? liveStateForMilestones.milestones
                : [];
            let stepMilestones: ScaffoldState['milestones'] | null = null;

            for (const step of steps) {
                if (!isObject(step)) continue;
                const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
                for (const toolResult of toolResults) {
                    if (!isObject(toolResult) || !MILESTONE_INSERT_TOOL_NAMES.has(String(toolResult.toolName))) continue;
                    const output = isObject(toolResult.output) ? toolResult.output : {};
                    const normalized = normalizeMilestones(output.milestones);
                    if (normalized && normalized.length > 0) {
                        stepMilestones = normalized;
                    }
                }
            }

            const effectiveMilestones = stepMilestones ?? liveMilestones;
            const requiredMilestonePlaced = hasRequiredMilestone(effectiveMilestones);
            const milestoneConfigurationReady =
                hasMilestoneConfiguration ||
                milestoneConfigurationSeenInSteps ||
                requiredMilestonePlaced;

            if (!milestoneConfigurationReady) {
                return {
                    activeTools: ['addMilestones'],
                    toolChoice: 'required',
                };
            }

            if (!requiredMilestonePlaced) {
                return {
                    activeTools: [...MILESTONE_TOOL_NAMES],
                    toolChoice: 'required',
                };
            }

            if (hasBuildActivity) {
                return {
                    activeTools: [...FINALIZATION_TOOL_NAMES],
                    toolChoice: 'required',
                };
            }

            return {
                activeTools: [...FINALIZATION_TOOL_NAMES],
                toolChoice: 'required',
            };
        },
        system:
            "You are the Grad Planner AI Agent. " +
            "Your purpose is to help university students create a graduation plan. " +
            "A grad plan is fundamentally a JSON record of the courses/actions a student needs to take. " +
            "CRITICAL RULE: You MUST use tools to advance the flow — never ask the user to choose which step is next. Just call the tools in order. " +
            "CRITICAL RULE: Never produce freeform text offering the user numbered choices like '1. do X, 2. do Y'. Pick the next step yourself and call the tool. " +
            "Follow this exact sequential flow: " +
            "STEP 1: Call requestUserPreferences. Wait for the user to submit. (The form may include an uploaded transcript with parsed courses.) ONLY do this ONCE per conversation. NEVER call it again. " +
            "SPECIAL RULE: If the user explicitly asks to change preferences at any point, call updateUserPreferences and wait for submission. Then continue the current workflow step with the updated constraints. " +
            "STEP 2: Call requestMajorSelection. Wait for the user. This step is also used for graduate students, but it should select a graduate program. " +
            "   - Read preferences.studentType from STEP 1. If studentType is 'graduate', use graduate programs only (program_type='graduate_no_gen_ed'). " +
            "   - requestMajorSelection may return selectedPrograms (up to 2). Always process them sequentially, one program at a time. " +
            "   - If result contains selectedProgram → program is set. Move immediately to STEP 3. " +
            "   - If result contains action='needsHelp' → call requestCareerQuestionnaire, wait for answers, " +
            "     then call queryPrograms with programType='graduate_no_gen_ed' when studentType='graduate', otherwise programType='major'. " +
            "     Then call presentMajorOptions with the 3 recommendedPrograms. Wait for the user to pick one. Then move to STEP 3. " +
            "STEP 3: Call selectMajorCourses with programName set to the selected program. If requestMajorSelection returns selectedPrograms (array), process them sequentially: start index 0, pass selectedPrograms/selectedProgramIds/currentIndex, and repeat until all are completed. If studentType='graduate', pass programType='graduate_no_gen_ed'. If selectMajorCourses result.action='change_major', immediately call requestMajorSelection again. Wait for each submission before continuing. " +
            "STEP 4: If studentType='graduate', skip STEPS 4-7 and go directly to STEP 8. Otherwise call requestMinorSelection and wait for submit/skip. " +
            "STEP 5: If minors were selected, call selectMinorCourses sequentially (same array/index pattern) until all selected minors are completed. Distinguish skip outcomes: if result.action='change_minor', immediately call requestMinorSelection again; if result.action='skip_minor', continue as no-minor; other skipped outcomes may continue. " +
            "STEP 6: If studentType='honors', call requestHonorsSelection and wait for acknowledgment. " +
            "STEP 7: For non-graduate students, call selectGenEdCourses and wait for GE selections. " +
            "STEP 8: Build the graduation plan visually in the Playground using `getRemainingCoursesToPlan`, `createTerm`, `addCoursesToTerm`, and `removeCourseFromTerm`. Do NOT use generateGradPlanScaffold. Pacing rules: if graduationPace='fast', use every term in sequence (Fall/Winter/Spring/Summer) with no skipped terms while courses remain; if graduationPace='sustainable', prefer Fall/Winter and only use Spring/Summer near the end to avoid waiting; if graduationPace='undecided', avoid Spring/Summer until a major is chosen. Run `checkPlanHeuristics`. If warnings exist or totalUnplanned > 0, perform minimal local fixes (move one course at a time; create the next chronological term only when needed), then run `checkPlanHeuristics` again. Repeat until `isPlanSound=true` and `totalUnplanned=0`. If progress stalls (e.g., empty term created but unplanned courses remain), immediately call `getRemainingCoursesToPlan` and then place courses into an existing term or remove the empty term before creating any new term. " +
            "STEP 9: After STEP 8 is clean, call addMilestones and wait for user input. Then call insertMilestone for each selected milestone. `Apply For Graduation` is required and must be placed before the final semester. " +
            "STEP 10: Only after heuristics are clean, all selected courses are placed, and `Apply For Graduation` is inserted, call requestPlanReview. " +
            "   If the user wants to iterate, refine using tools then call requestPlanReview again. " +
            "Never call multiple form-request tools in the same step. Always wait for the result before calling the next tool." +
            byuContext,
        messages: coreMessages,
        tools: getAgentTools(planId),
    });

    return withRefreshedAgentSession(result.toUIMessageStreamResponse(), session);
}
