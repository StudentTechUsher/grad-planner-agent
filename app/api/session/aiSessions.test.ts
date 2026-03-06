import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSessionSnapshotFromStoreState,
  enforcePayloadSize,
  isValidSessionId,
  mergeStateSnapshots,
} from '@/lib/aiSessions';
import type { ScaffoldState } from '@/app/api/store';

const originalMaxPayload = process.env.AI_SESSIONS_MAX_PAYLOAD_BYTES;

afterEach(() => {
  if (originalMaxPayload === undefined) {
    delete process.env.AI_SESSIONS_MAX_PAYLOAD_BYTES;
  } else {
    process.env.AI_SESSIONS_MAX_PAYLOAD_BYTES = originalMaxPayload;
  }
});

describe('aiSessions helpers', () => {
  it('validates UUID session ids', () => {
    expect(isValidSessionId('5f1ef7f8-7b1a-4c84-a5c6-a95f6a0af79f')).toBe(true);
    expect(isValidSessionId('not-a-uuid')).toBe(false);
  });

  it('deep merges state snapshots', () => {
    const merged = mergeStateSnapshots(
      {
        liveJson: { plan: [{ term: 'Fall 2026' }] },
        preferences: { maxCreditsPerTerm: 15, nested: { a: 1 } },
      },
      {
        preferences: { minCreditsPerTerm: 12, nested: { b: 2 } },
        transcriptSummary: 'Loaded transcript',
      },
    );

    expect(merged.preferences).toEqual({
      maxCreditsPerTerm: 15,
      minCreditsPerTerm: 12,
      nested: { a: 1, b: 2 },
    });
    expect(merged.transcriptSummary).toBe('Loaded transcript');
    expect(merged.liveJson?.plan).toEqual([{ term: 'Fall 2026' }]);
  });

  it('enforces payload size limits', () => {
    process.env.AI_SESSIONS_MAX_PAYLOAD_BYTES = '20';

    const okResult = enforcePayloadSize({ value: 'x' });
    expect(okResult.ok).toBe(true);

    const failResult = enforcePayloadSize({ value: 'this payload is definitely too large' });
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) {
      expect(failResult.maxBytes).toBe(20);
      expect(failResult.bytes).toBeGreaterThan(20);
    }
  });

  it('builds a session snapshot from scaffold state', () => {
    const state: ScaffoldState = {
      planId: '5f1ef7f8-7b1a-4c84-a5c6-a95f6a0af79f',
      userId: 'user-1',
      createdAt: Date.now(),
      hasPreferencesSet: true,
      preferences: {
        maxCreditsPerTerm: 15,
        minCreditsPerTerm: 12,
        genEdStrategy: 'balance',
        graduationPace: 'sustainable',
        studentType: 'undergrad',
        transcriptCredits: 6,
      },
      phases: ['major'],
      terms: [{ term: 'Fall 2026', courses: [], credits_planned: 0 }],
      milestones: [{ id: 'm1', type: 'apply', title: 'Apply For Graduation', afterTerm: 'Fall 2026' }],
      allCourses: [],
      selectedProgramIds: [],
      completedCourseCodes: [],
    };

    const snapshot = buildSessionSnapshotFromStoreState(state);
    expect(snapshot.storeState?.planId).toBe(state.planId);
    expect(snapshot.liveJson?.plan).toEqual(state.terms);
    expect(snapshot.liveJson?.milestones).toEqual(state.milestones);
    expect(snapshot.preferences).toEqual(state.preferences);
  });
});
