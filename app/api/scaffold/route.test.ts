import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { streamText } from 'ai';
import { POST, GET } from './route';
import * as agentAuth from '@/lib/agentAuth';
import * as aiSessions from '@/lib/aiSessions';
import { store } from '@/app/api/store';

// Mock the dependencies
vi.mock('@/lib/agentAuth', () => ({
    getAgentSessionFromRequest: vi.fn(),
    withRefreshedAgentSession: vi.fn((res) => res),
}));

vi.mock('@/lib/supabaseAdmin', () => ({
    getSupabaseAdminClient: vi.fn(() => ({
        // Mock supabase client if needed
    })),
}));

vi.mock('@/lib/posthogServer', () => ({
    captureServerError: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock('@/lib/aiSessions', () => ({
    buildSessionSnapshotFromStoreState: vi.fn(),
    saveSessionStateSnapshot: vi.fn(),
    loadStateFromSessionSnapshot: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
    const original = await importOriginal<typeof import('ai')>();
    return {
        ...original,
        streamText: vi.fn(),
    };
});

describe('Scaffold API Route', () => {
    const mockUserId = 'user-123';
    const mockPlanId = 'plan-456';

    beforeEach(() => {
        vi.clearAllMocks();
        // Clear the in-memory store before each test
        store.clear();

        // Setup default auth mock
        vi.mocked(agentAuth.getAgentSessionFromRequest).mockResolvedValue({
            userId: mockUserId,
            handoffId: 'test-handoff',
            handoffExtExpiresAt: Date.now() + 10000,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    });

    describe('POST handler', () => {
        it('should recover state from session snapshot if store is empty', async () => {
            // Arrange
            const req = new NextRequest('http://localhost/api/scaffold', {
                method: 'POST',
                body: JSON.stringify({
                    planId: mockPlanId,
                    phase: 'major',
                    courses: [{ code: 'CS 101', title: 'Intro', credits: 3, source: 'major' }],
                }),
            });

            const recoveredState = {
                planId: mockPlanId,
                userId: mockUserId,
                terms: [],
                allCourses: [],
                phases: [],
                preferences: { maxCreditsPerTerm: 15, minCreditsPerTerm: 12, genEdStrategy: 'prioritize', graduationPace: 'sustainable', transcriptCredits: 0, studentType: 'undergrad' }
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            vi.mocked(aiSessions.loadStateFromSessionSnapshot).mockResolvedValue(recoveredState as any);

            // Act
            await POST(req);

            // Assert
            expect(aiSessions.loadStateFromSessionSnapshot).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: mockUserId,
                    sessionId: mockPlanId,
                })
            );

            // Verify the state was set back into the store
            const stateInStore = store.get(mockPlanId);
            expect(stateInStore).toBeDefined();
            expect(stateInStore?.planId).toBe(mockPlanId);
        });

        it('should initialize empty state if recovery fails', async () => {
            // Arrange
            const req = new NextRequest('http://localhost/api/scaffold', {
                method: 'POST',
                body: JSON.stringify({
                    planId: mockPlanId,
                    phase: 'major',
                    courses: [],
                }),
            });

            // Simulate recovery failure (e.g. returning null)
            vi.mocked(aiSessions.loadStateFromSessionSnapshot).mockResolvedValue(null);

            // Act
            await POST(req);

            // Assert
            const stateInStore = store.get(mockPlanId);
            expect(stateInStore).toBeDefined();
            expect(stateInStore?.phases).toEqual(['major']); // It initializes empty, then immediately adds the incoming phase
        });
    });

    describe('GET handler', () => {
        it('should recover state from session snapshot if store is empty', async () => {
            // Arrange
            const req = new NextRequest(`http://localhost/api/scaffold?planId=${mockPlanId}`, {
                method: 'GET',
            });

            const recoveredState = {
                planId: mockPlanId,
                userId: mockUserId,
                terms: [],
                allCourses: [],
                phases: [],
                preferences: { maxCreditsPerTerm: 15, minCreditsPerTerm: 12, genEdStrategy: 'prioritize', graduationPace: 'sustainable', transcriptCredits: 0, studentType: 'undergrad' }
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            vi.mocked(aiSessions.loadStateFromSessionSnapshot).mockResolvedValue(recoveredState as any);

            // Act
            await GET(req);

            // Assert
            expect(aiSessions.loadStateFromSessionSnapshot).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: mockUserId,
                    sessionId: mockPlanId,
                })
            );

            const stateInStore = store.get(mockPlanId);
            expect(stateInStore).toBeDefined();
        });
    });

    describe('Vercel Deployment Behavior', () => {
        it('should enforce maxDuration of 10 seconds for Vercel Hobby tier', async () => {
            // We import maxDuration from the route to ensure it's exported correctly
            const { maxDuration } = await import('./route');
            expect(maxDuration).toBe(10);
        });

        it('should return stream immediately even if AI generation takes longer than Vercel timeout', async () => {
            // This test simulates Vercel's behavior where a function can run longer than
            // the maxDuration AS LONG AS it is actively returning a stream.

            vi.useFakeTimers();

            // Simulate the streamText taking 15 seconds (longer than the 10s maxDuration)
            console.log('--- SETTING UP MOCK ---');
            vi.mocked(streamText).mockImplementationOnce(() => {
                let isDone = false;

                // We mock the toUIMessageStreamResponse to just return a response
                // but we also verify it doesn't block the execution for the full 15s
                return {
                    toUIMessageStreamResponse: () => {
                        // In a real scenario, this response body would stream chunks
                        // We stagger the generation using setTimeout to simulate long AI response
                        setTimeout(() => {
                            isDone = true;
                        }, 15000);
                        console.log('--- EXECUTING MOCK ---');
                        return new Response('simulated-stream');
                    }
                } as any;
            });

            const req = new NextRequest('http://localhost/api/scaffold', {
                method: 'POST',
                body: JSON.stringify({
                    planId: mockPlanId,
                    phase: 'major',
                    courses: [{ code: 'CS 101', title: 'Intro', credits: 3, source: 'major' }],
                    preferences: {
                        maxCreditsPerTerm: 15,
                        minCreditsPerTerm: 12,
                        genEdStrategy: "prioritize",
                        graduationPace: "sustainable",
                        studentType: 'undergrad',
                        transcriptCredits: 0
                    }
                }),
            });

            // Start the request
            const responsePromise = POST(req);

            // We expect the POST handler to return the Response object IMMEDIATELY,
            // before the 15 seconds have elapsed. It should not await the full generation.

            // Advance time a little bit, but less than 15s (or 10s timeout)
            vi.advanceTimersByTime(100);

            // The response should be resolved already because streamText 
            // returns a stream instantly, it doesn't wait for completion.
            const response = await responsePromise;

            expect(response).toBeInstanceOf(Response);

            // To prove it didn't wait the full 15s (fake time) before returning,
            // we check the returned object. Since the mock streamText returns 'simulated-stream',
            // we can verify the stream logic works without triggering the timeout.
            const textResponse = await response.text();
            expect(textResponse).toBe('simulated-stream');

            // Cleanup
            vi.useRealTimers();
        });
    });
});
