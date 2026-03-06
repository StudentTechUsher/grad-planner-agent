import { NextRequest, NextResponse } from 'next/server';
import { streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { captureServerError, captureServerEvent } from '@/lib/posthogServer';
import {
    buildSessionSnapshotFromStoreState,
    saveSessionStateSnapshot,
    loadStateFromSessionSnapshot,
} from '@/lib/aiSessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const heuristicsContext = '';
const examplesContext = '';// ─── In-memory scaffold state ──────────────────────────────────────────
// Each plan has a planId (UUID generated client-side) and an evolving scaffold.
// Phases: major → minor → genEd → transcript
// Each phase adds courses into the term plan.

import { ScaffoldCourse, ScaffoldTerm, ScaffoldState, store } from '../store';

const termSchema = z.object({
    term: z.string().describe("The term label, e.g., 'Fall 2026', 'Winter 2027', 'Spring 2027', 'Summer 2027'"),
    courses: z.array(z.object({
        code: z.string(),
        title: z.string(),
        credits: z.number(),
        source: z.enum(['major', 'minor', 'genEd']),
        programName: z.string().optional(),
    })).describe("The courses assigned to this term."),
    credits_planned: z.number().describe("The total credits assigned to this term."),
});

// ─── POST handler – add courses from a phase ────────────────────────────
export async function POST(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const jsonWithSession = (body: unknown, init?: ResponseInit) =>
        withRefreshedAgentSession(NextResponse.json(body, init), session);

    let supabaseAdminForSessions: ReturnType<typeof getSupabaseAdminClient> | null = null;
    try {
        supabaseAdminForSessions = getSupabaseAdminClient();
    } catch {
        supabaseAdminForSessions = null;
    }

    const persistSessionState = async (stateToPersist: ScaffoldState): Promise<void> => {
        if (!supabaseAdminForSessions) return;
        try {
            await saveSessionStateSnapshot({
                supabaseAdmin: supabaseAdminForSessions,
                userId: session.userId,
                sessionId: stateToPersist.planId,
                stateSnapshot: buildSessionSnapshotFromStoreState(stateToPersist),
                createIfMissing: true,
            });
        } catch {
            void captureServerEvent('session_sync_failed', 'warn', {
                route: '/api/scaffold',
                request: req,
                distinctId: session.userId,
                properties: {
                    planId: stateToPersist.planId,
                    source: 'scaffold_state_snapshot',
                },
            });
        }
    };

    const body = await req.json();
    const { planId, phase, courses, preferences } = body as {
        planId: string;
        phase: 'major' | 'minor' | 'genEd';
        courses: (ScaffoldCourse & { programName?: string })[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        preferences?: { maxCreditsPerTerm?: number; minCreditsPerTerm?: number; genEdStrategy?: "prioritize" | "balance"; graduationPace?: "fast" | "sustainable" | "undecided"; studentType?: 'undergrad' | 'honors' | 'graduate' | 'grad'; anticipatedGraduation?: string; transcriptCourses?: any[] };
    };

    if (!planId || !phase || !Array.isArray(courses)) {
        return jsonWithSession({ error: 'Missing required fields: planId, phase, courses' }, { status: 400 });
    }

    let state = store.get(planId);

    // Attempt state recovery if not in memory
    if (!state && supabaseAdminForSessions) {
        try {
            const recoveredState = await loadStateFromSessionSnapshot({
                supabaseAdmin: supabaseAdminForSessions,
                userId: session.userId,
                sessionId: planId,
            });
            if (recoveredState) {
                if (!recoveredState.userId) {
                    recoveredState.userId = session.userId;
                }
                store.set(planId, recoveredState);
                state = recoveredState;
                void captureServerEvent('scaffold_state_recovered_from_ai_session', 'info', {
                    route: '/api/scaffold',
                    request: req,
                    distinctId: session.userId,
                    properties: { planId, phase },
                });
            }
        } catch {
            // Ignore recovery errors and fallback to creating new state if necessary
        }
    }

    if (state?.userId && state.userId !== session.userId) {
        return jsonWithSession({ error: 'Forbidden: plan ownership mismatch.' }, { status: 403 });
    }
    if (state && !state.userId) {
        state.userId = session.userId;
    }
    if (state && !Array.isArray(state.selectedProgramIds)) {
        state.selectedProgramIds = [];
    }

    if (!state) {
        console.log('--- TEST LOG: creating new state ---');
        state = {
            planId,
            userId: session.userId,
            createdAt: Date.now(),
            hasPreferencesSet: true,
            preferences: {
                maxCreditsPerTerm: preferences?.maxCreditsPerTerm ?? 15,
                minCreditsPerTerm: preferences?.minCreditsPerTerm ?? 12,
                genEdStrategy: preferences?.genEdStrategy ?? "prioritize",
                graduationPace: preferences?.graduationPace ?? "sustainable",
                studentType: preferences?.studentType === 'honors'
                    ? 'honors'
                    : preferences?.studentType === 'graduate' || preferences?.studentType === 'grad'
                        ? 'graduate'
                        : 'undergrad',
                anticipatedGraduation: preferences?.anticipatedGraduation,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                transcriptCredits: preferences?.transcriptCourses?.reduce((sum: number, c: any) => sum + (c.credits || 0), 0) ?? 0,
            },
            phases: [],
            terms: [],
            milestones: [],
            allCourses: [],
            selectedProgramIds: [],
        };
        store.set(planId, state);
    }

    if (!state) {
        console.log('--- TEST LOG: Failed to initialize state ---');
        return jsonWithSession({ error: 'Failed to initialize state' }, { status: 500 });
    }

    // Tag courses with source and program properties
    const taggedCourses: ScaffoldCourse[] = courses.map(c => ({
        ...c,
        source: phase,
        programName: c.programName,
    }));

    state.allCourses.push(...taggedCourses);
    state.phases.push(phase);

    // Leverage the AI SDK Background Agent to distribute courses
    console.log('--- TEST LOG: before streamText ---');
    try {
        const result = streamText({
            model: openai('gpt-5-mini'),
            maxRetries: 2,
            system: `You are a university academic graduation planner. Your job is to take a student's existing graduation plan and intelligently distribute NEW courses into it.
CRITICAL RULES:
1. You MUST include ALL existing courses in their exact terms. DO NOT remove or modify any existing courses.
2. Distribute the new courses into the plan, balancing the workload. 
3. EXTREMELY STRICT: The student's preferences dictate a maximum of ${state.preferences.maxCreditsPerTerm} credits per term. You MUST NOT exceed this limit under ANY circumstances!
3.5. General Education Strategy: ${state.preferences.genEdStrategy === 'prioritize' ? 'Push all Gen Ed courses to the earliest possible terms.' : 'Distribute Gen Ed courses evenly across the entire graduation plan.'}
3.6. Graduation Pace & Credit Targeting:
- If graduation pace is 'fast' (ASAP): Use EVERY available term in sequence (Fall, Winter, Spring, Summer) until graduation. Do not skip Spring/Summer when courses remain.
- If graduation pace is 'sustainable': Prioritize Fall/Winter as primary terms. Only use Spring/Summer at the END of the plan when it helps avoid waiting until the next school year.
- If graduation pace is 'undecided': Do not schedule Spring/Summer (8-week) terms until a major is decided.
3.6.5 Gen Ed Placeholders: You MUST actively invent and insert "Gen Ed Placeholder" courses (3 credits, code "GE 000", source 'genEd') depending on the gen-ed strategy:
- 'prioritize': Put 2-3 Gen Ed placeholders in the earliest terms.
- 'balance': Put about 1 Gen Ed placeholder in each primary term.
- If pace is 'undecided', keep placeholders in Fall/Winter first.
${state.preferences.anticipatedGraduation ? `3.7. Anticipated Graduation: The student wants to graduate around ${state.preferences.anticipatedGraduation}. Try to hit this target if credit constraints allow.` : ''}
4. The sequence of terms at BYU is Fall, Winter, Spring, Summer. Standard Fall/Winter term load is 12-16 credits. Spring/Summer is half-term (max 6-8 credits).
5. If an existing term has room below the max credits, you can add new courses to it.
6. CALCULATING SEMESTERS: A standard degree requires ~120 credits. The incoming transcript has ${state.preferences.transcriptCredits} credits. There are ${Math.max(0, 120 - state.preferences.transcriptCredits)} credits remaining. If they average ${(state.preferences.maxCreditsPerTerm + state.preferences.minCreditsPerTerm) / 2} credits per term, you MUST scaffold the roadmap out to explicitly produce around ${Math.ceil((120 - state.preferences.transcriptCredits) / ((state.preferences.maxCreditsPerTerm + state.preferences.minCreditsPerTerm) / 2))} future terms. Do NOT arbitrarily squish all courses into fewer terms!
7. YOU MUST GENERATE ENOUGH TERMS TO KEEP EVERY TERM BELOW ${state.preferences.maxCreditsPerTerm} CREDITS! Add as many new semesters as necessary. Follow the desired graduation pace.
8. You MUST call the 'updateGradPlan' tool to submit the COMPLETE merged plan (existing + new courses combined). DO NOT output plain text only.` + (heuristicsContext ?? '') + (examplesContext ?? ''),
            prompt: `EXISTING PLAN: \n${JSON.stringify(state.terms, null, 2)}\n\nNEW COURSES TO ADD: \n${JSON.stringify(taggedCourses, null, 2)}`,
            tools: {
                updateGradPlan: tool({
                    description: 'Submit the updated graduation plan scaffold containing all terms and courses.',
                    parameters: z.object({
                        terms: z.array(z.object({
                            term: z.string().describe("The term label, e.g., 'Fall 2026', 'Winter 2027', 'Spring 2027', 'Summer 2027'"),
                            courses: z.array(z.object({
                                code: z.string(),
                                title: z.string(),
                                credits: z.number(),
                                source: z.enum(['major', 'minor', 'genEd']),
                                programName: z.string().optional(),
                            })).describe("The courses assigned to this term."),
                            credits_planned: z.number().max(state.preferences.maxCreditsPerTerm + 3, `Wait! Too many credits! Max is ${state.preferences.maxCreditsPerTerm} credits / term. Regenerate plan with more spread out courses!`).describe("The total credits assigned to this term."),
                        })).describe("The chronological list of terms for the graduation plan. Make sure not to exceed max credits!"),
                    }),
                    // @ts-expect-error Types out of sync for execute plan function
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    execute: async (plan: any) => {
                        const { terms } = plan;
                        const checkErrors: string[] = [];

                        // Parse term string (e.g. "Fall 2026") and advance based on graduation pace.
                        const getNextTerm = (currentTerm: string) => {
                            const parts = currentTerm.trim().split(' ');
                            let sem = parts[0];
                            let year = parseInt(parts[1]) || new Date().getFullYear();

                            const pace = state!.preferences.graduationPace;
                            if (pace === 'sustainable') {
                                // Sustainable defaults to semester cadence (Fall/Winter).
                                if (sem.toLowerCase() === 'fall') {
                                    sem = 'Winter';
                                    year += 1;
                                } else if (sem.toLowerCase() === 'winter') {
                                    sem = 'Fall';
                                } else if (sem.toLowerCase() === 'spring') {
                                    sem = 'Summer';
                                } else {
                                    sem = 'Fall';
                                }
                                return `${sem} ${year}`;
                            }

                            // Fast and undecided use full term sequence when extending.
                            if (sem.toLowerCase() === 'fall') {
                                sem = 'Winter';
                                year += 1;
                            } else if (sem.toLowerCase() === 'winter') sem = 'Spring';
                            else if (sem.toLowerCase() === 'spring') sem = 'Summer';
                            else sem = 'Fall';
                            return `${sem} ${year}`;
                        };

                        const enforcedTerms: ScaffoldTerm[] = [];
                        let overflowCourses: ScaffoldCourse[] = [];

                        // We iterate through whatever terms the LLM generated PLUS any extra terms needed for overflow
                        let i = 0;
                        let currentTermStr = terms[0]?.term || "Fall 2026";

                        while (i < terms.length || overflowCourses.length > 0) {
                            const termObj = terms[i] || { term: currentTermStr, courses: [] };
                            currentTermStr = termObj.term; // Keep track of timeline

                            const isHalfTerm = currentTermStr.toLowerCase().includes('spring') || currentTermStr.toLowerCase().includes('summer');
                            const currentMax = isHalfTerm ? Math.ceil(state.preferences.maxCreditsPerTerm / 2) : state.preferences.maxCreditsPerTerm;

                            // Combine the term's original courses with any overflow from the previous term
                            const pool = [...overflowCourses, ...(termObj.courses as ScaffoldCourse[])];
                            overflowCourses = [];

                            const approvedCourses: ScaffoldCourse[] = [];
                            let termCredits = 0;

                            for (const course of pool) {
                                if (termCredits + (course.credits || 0) <= currentMax || approvedCourses.length === 0) {
                                    // Accept course if it fits (or if it's the very first course and somehow exceeds max on its own)
                                    approvedCourses.push(course);
                                    termCredits += (course.credits || 0);
                                } else {
                                    // Overflows to next term
                                    overflowCourses.push(course);
                                }
                            }

                            if (overflowCourses.length > 0) {
                                checkErrors.push(`Term ${currentTermStr} exceeded max credits (${currentMax}). Cascaded ${overflowCourses.length} courses to next term.`);
                            }

                            // Only save the term if it has courses, to avoid empty spacer terms unless it's strictly needed
                            if (approvedCourses.length > 0) {
                                enforcedTerms.push({
                                    term: currentTermStr,
                                    courses: approvedCourses,
                                    credits_planned: termCredits,
                                });
                            }

                            currentTermStr = getNextTerm(currentTermStr);
                            i++;
                        }

                        if (checkErrors.length > 0) {
                            void captureServerEvent('scaffold_heuristics_enforced', 'warn', {
                                route: '/api/scaffold',
                                request: req,
                                distinctId: session.userId,
                                properties: {
                                    planId,
                                    violationCount: checkErrors.length,
                                    violations: checkErrors,
                                },
                            });
                        }

                        state!.terms = enforcedTerms;
                        store.set(planId, state!);
                        await persistSessionState(state!);

                        return {
                            success: true,
                            planId,
                            phase,
                            coursesAdded: taggedCourses.length,
                            totalCourses: state!.allCourses.length,
                            termsCount: state!.terms.length,
                            heuristicsViolations: checkErrors,
                            plan: enforcedTerms // Return the corrected plan to the UI
                        };
                    }
                })
            },
        });

        return withRefreshedAgentSession(result.toUIMessageStreamResponse(), session);
    } catch (e) {
        console.error('--- TEST LOG: Catch block error ---', e);
        void captureServerError('scaffold_generation_failed', e, {
            route: '/api/scaffold',
            request: req,
            distinctId: session.userId,
        });
        return jsonWithSession({ error: 'Failed to generate plan scaffold with AI.' }, { status: 500 });
    }
}

// ─── GET handler – return the current state ──────────────────────────────
export async function GET(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const jsonWithSession = (body: unknown, init?: ResponseInit) =>
        withRefreshedAgentSession(NextResponse.json(body, init), session);

    const { searchParams } = new URL(req.url);
    const planId = searchParams.get('planId');

    if (!planId) {
        return jsonWithSession({ error: 'planId required' }, { status: 400 });
    }

    let state = store.get(planId);

    // Attempt state recovery if not in memory
    if (!state) {
        let supabaseAdminForSessions: ReturnType<typeof getSupabaseAdminClient> | null = null;
        try {
            supabaseAdminForSessions = getSupabaseAdminClient();
        } catch {
            supabaseAdminForSessions = null;
        }
        if (supabaseAdminForSessions) {
            try {
                const recoveredState = await loadStateFromSessionSnapshot({
                    supabaseAdmin: supabaseAdminForSessions,
                    userId: session.userId,
                    sessionId: planId,
                });
                if (recoveredState) {
                    if (!recoveredState.userId) {
                        recoveredState.userId = session.userId;
                    }
                    store.set(planId, recoveredState);
                    state = recoveredState;
                    void captureServerEvent('scaffold_state_recovered_from_ai_session_get', 'info', {
                        route: '/api/scaffold',
                        request: req,
                        distinctId: session.userId,
                        properties: { planId },
                    });
                }
            } catch {
                // Ignore recovery errors and fallback below
            }
        }
    }

    if (!state) {
        return jsonWithSession({ error: 'Scaffold not found' }, { status: 404 });
    }

    if (state.userId && state.userId !== session.userId) {
        return jsonWithSession({ error: 'Forbidden: plan ownership mismatch.' }, { status: 403 });
    }

    return jsonWithSession(state);
}
