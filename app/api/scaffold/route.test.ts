import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
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

vi.mock('ai', () => ({
    streamText: vi.fn(),
    generateObject: vi.fn(),
    tool: vi.fn(),
}));

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
});
