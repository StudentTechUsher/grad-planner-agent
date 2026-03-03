import { afterEach, describe, expect, it } from 'vitest';

import { evaluatePlanHeuristics, getAgentTools } from './tools';
import { ScaffoldCourse, ScaffoldState, store } from '../store';

const createdPlanIds: string[] = [];

const mkPlanId = (): string => `test-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const mkCourse = (
  code: string,
  credits = 3,
  overrides: Partial<ScaffoldCourse> = {},
): ScaffoldCourse => ({
  code,
  title: code,
  credits,
  source: 'major',
  ...overrides,
});

const mkState = (overrides: Partial<ScaffoldState> = {}): ScaffoldState => ({
  planId: overrides.planId ?? mkPlanId(),
  userId: overrides.userId ?? 'test-user-id',
  createdAt: Date.now(),
  hasPreferencesSet: true,
  preferences: {
    maxCreditsPerTerm: 15,
    minCreditsPerTerm: 12,
    genEdStrategy: 'balance',
    graduationPace: 'sustainable',
    studentType: 'undergrad',
    transcriptCredits: 0,
    ...(overrides.preferences ?? {}),
  },
  phases: overrides.phases ?? [],
  terms: overrides.terms ?? [],
  milestones: overrides.milestones ?? [],
  allCourses: overrides.allCourses ?? [],
  selectedProgramIds: overrides.selectedProgramIds ?? [],
  completedCourseCodes: overrides.completedCourseCodes ?? [],
});

const seedStore = (state: ScaffoldState): string => {
  store.set(state.planId, state);
  createdPlanIds.push(state.planId);
  return state.planId;
};

afterEach(() => {
  for (const id of createdPlanIds) {
    store.delete(id);
  }
  createdPlanIds.length = 0;
});

describe('evaluatePlanHeuristics', () => {
  it('flags over-max terms with structured violations', () => {
    const state = mkState({
      terms: [
        {
          term: 'Fall 2026',
          courses: [mkCourse('CS 101', 8), mkCourse('MATH 112', 8)],
          credits_planned: 16,
        },
      ],
      allCourses: [mkCourse('CS 101', 8), mkCourse('MATH 112', 8)],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.isPlanSound).toBe(false);
    expect(result.violations.some((v) => v.type === 'overMax' && v.termName === 'Fall 2026')).toBe(true);
  });

  it('flags under-min non-final terms', () => {
    const state = mkState({
      terms: [
        {
          term: 'Fall 2026',
          courses: [mkCourse('CS 111', 3), mkCourse('MATH 112', 3), mkCourse('ENG 150', 3)],
          credits_planned: 9,
        },
        {
          term: 'Winter 2027',
          courses: [mkCourse('IS 201', 3), mkCourse('IS 303', 3), mkCourse('STAT 201', 3), mkCourse('ECON 110', 3)],
          credits_planned: 12,
        },
      ],
      allCourses: [
        mkCourse('CS 111', 3),
        mkCourse('MATH 112', 3),
        mkCourse('ENG 150', 3),
        mkCourse('IS 201', 3),
        mkCourse('IS 303', 3),
        mkCourse('STAT 201', 3),
        mkCourse('ECON 110', 3),
      ],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'underMin' && v.termName === 'Fall 2026')).toBe(true);
  });

  it('allows under-min final graduating term when all courses are planned', () => {
    const state = mkState({
      terms: [
        {
          term: 'Fall 2026',
          courses: [mkCourse('IS 401', 3), mkCourse('IS 402', 3), mkCourse('IS 403', 3)],
          credits_planned: 9,
        },
      ],
      allCourses: [mkCourse('IS 401', 3), mkCourse('IS 402', 3), mkCourse('IS 403', 3)],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.totalUnplanned).toBe(0);
    expect(result.violations.some((v) => v.type === 'underMin')).toBe(false);
    expect(result.isPlanSound).toBe(true);
  });

  it('flags duplicate course placement across terms', () => {
    const dup = mkCourse('IS 350', 3);
    const state = mkState({
      terms: [
        { term: 'Fall 2026', courses: [dup], credits_planned: 3 },
        { term: 'Winter 2027', courses: [dup], credits_planned: 3 },
      ],
      allCourses: [dup],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'duplicateCourse' && v.courseCode === 'IS 350')).toBe(true);
  });

  it('reports totalUnplanned and per-course unplanned violations', () => {
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [mkCourse('IS 101', 3)], credits_planned: 3 }],
      allCourses: [mkCourse('IS 101', 3), mkCourse('IS 201', 3)],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.totalUnplanned).toBe(1);
    expect(result.violations.some((v) => v.type === 'unplannedCourse' && v.courseCode === 'IS 201')).toBe(true);
  });

  it('flags unmet prerequisites when prerequisite is not earlier and not on transcript', () => {
    const acc310 = mkCourse('ACC 310', 3);
    const acc401 = mkCourse('ACC 401', 3, { prerequisite: 'ACC 310' });
    const state = mkState({
      terms: [
        { term: 'Fall 2026', courses: [acc401], credits_planned: 3 },
        { term: 'Winter 2027', courses: [acc310], credits_planned: 3 },
      ],
      allCourses: [acc310, acc401],
      completedCourseCodes: [],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.isPlanSound).toBe(false);
    expect(result.violations.some((v) => v.type === 'missingPrerequisite' && v.courseCode === 'ACC 401')).toBe(true);
  });

  it('accepts prerequisite when satisfied from transcript history', () => {
    const acc401 = mkCourse('ACC 401', 3, { prerequisite: 'ACC 310' });
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [acc401], credits_planned: 3 }],
      allCourses: [acc401],
      completedCourseCodes: ['ACC310'],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'missingPrerequisite' && v.courseCode === 'ACC 401')).toBe(false);
  });

  it('accepts prerequisite when prerequisite course is in an earlier term', () => {
    const acc310 = mkCourse('ACC 310', 3);
    const acc401 = mkCourse('ACC 401', 3, { prerequisite: 'ACC 310' });
    const state = mkState({
      terms: [
        { term: 'Fall 2026', courses: [acc310], credits_planned: 3 },
        { term: 'Winter 2027', courses: [acc401], credits_planned: 3 },
      ],
      allCourses: [acc310, acc401],
      completedCourseCodes: [],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'missingPrerequisite' && v.courseCode === 'ACC 401')).toBe(false);
  });

  it('flags ASAP pace when terms are skipped while courses remain', () => {
    const state = mkState({
      preferences: {
        maxCreditsPerTerm: 15,
        minCreditsPerTerm: 12,
        genEdStrategy: 'balance',
        graduationPace: 'fast',
        studentType: 'undergrad',
        transcriptCredits: 0,
      },
      terms: [
        { term: 'Fall 2026', courses: [mkCourse('IS 101', 3)], credits_planned: 3 },
        { term: 'Fall 2027', courses: [mkCourse('IS 201', 3)], credits_planned: 3 },
      ],
      allCourses: [mkCourse('IS 101', 3), mkCourse('IS 201', 3)],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'paceRule')).toBe(true);
    expect(result.isPlanSound).toBe(false);
  });

  it('flags sustainable pace when short terms appear too early', () => {
    const state = mkState({
      preferences: {
        maxCreditsPerTerm: 15,
        minCreditsPerTerm: 12,
        genEdStrategy: 'balance',
        graduationPace: 'sustainable',
        studentType: 'undergrad',
        transcriptCredits: 0,
      },
      terms: [
        { term: 'Fall 2026', courses: [mkCourse('IS 101', 3), mkCourse('IS 102', 3), mkCourse('IS 103', 3), mkCourse('IS 104', 3)], credits_planned: 12 },
        { term: 'Spring 2027', courses: [mkCourse('IS 201', 3)], credits_planned: 3 },
        { term: 'Winter 2027', courses: [mkCourse('IS 202', 3), mkCourse('IS 203', 3), mkCourse('IS 204', 3), mkCourse('IS 205', 3)], credits_planned: 12 },
        { term: 'Fall 2027', courses: [mkCourse('IS 301', 3), mkCourse('IS 302', 3), mkCourse('IS 303', 3), mkCourse('IS 304', 3)], credits_planned: 12 },
      ],
      allCourses: [
        mkCourse('IS 101', 3), mkCourse('IS 102', 3), mkCourse('IS 103', 3), mkCourse('IS 104', 3),
        mkCourse('IS 201', 3), mkCourse('IS 202', 3), mkCourse('IS 203', 3), mkCourse('IS 204', 3), mkCourse('IS 205', 3),
        mkCourse('IS 301', 3), mkCourse('IS 302', 3), mkCourse('IS 303', 3), mkCourse('IS 304', 3),
      ],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'paceRule' && v.termName === 'Spring 2027')).toBe(true);
  });

  it('flags undecided pace when short terms are used before major is chosen', () => {
    const state = mkState({
      preferences: {
        maxCreditsPerTerm: 15,
        minCreditsPerTerm: 12,
        genEdStrategy: 'balance',
        graduationPace: 'undecided',
        studentType: 'undergrad',
        transcriptCredits: 0,
      },
      phases: ['genEd'],
      terms: [
        {
          term: 'Spring 2026',
          courses: [mkCourse('GE 101', 3, { source: 'genEd' })],
          credits_planned: 3,
        },
        {
          term: 'Fall 2026',
          courses: [mkCourse('GE 102', 3, { source: 'genEd' }), mkCourse('GE 103', 3, { source: 'genEd' }), mkCourse('GE 104', 3, { source: 'genEd' }), mkCourse('GE 105', 3, { source: 'genEd' })],
          credits_planned: 12,
        },
      ],
      allCourses: [
        mkCourse('GE 101', 3, { source: 'genEd' }),
        mkCourse('GE 102', 3, { source: 'genEd' }),
        mkCourse('GE 103', 3, { source: 'genEd' }),
        mkCourse('GE 104', 3, { source: 'genEd' }),
        mkCourse('GE 105', 3, { source: 'genEd' }),
      ],
    });

    const result = evaluatePlanHeuristics(state);

    expect(result.violations.some((v) => v.type === 'paceRule' && v.termName === 'Spring 2026')).toBe(true);
  });
});

describe('playground mutation tools', () => {
  it('rejects deleting non-empty terms', async () => {
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [mkCourse('CS 101', 3)], credits_planned: 3 }],
      allCourses: [mkCourse('CS 101', 3)],
    });
    const planId = seedStore(state);

    const tools = getAgentTools(planId);
    if (!tools.deleteTerm.execute) throw new Error('deleteTerm must have execute');
    const result = await tools.deleteTerm.execute({ termName: 'Fall 2026' });

    expect(result.error).toContain('not empty');
    expect(store.get(planId)?.terms.length).toBe(1);
  });

  it('does not expand selected-course universe when adding courses to terms', async () => {
    const baseCourse = mkCourse('IS 201', 3);
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [], credits_planned: 0 }],
      allCourses: [baseCourse],
    });
    const planId = seedStore(state);

    const tools = getAgentTools(planId);
    if (!tools.addCoursesToTerm.execute) throw new Error('addCoursesToTerm must have execute');
    const result = await tools.addCoursesToTerm.execute({
      termName: 'Fall 2026',
      courses: [baseCourse],
    });

    expect(result.needsHeuristicsRecheck).toBe(true);
    expect(store.get(planId)?.allCourses.length).toBe(1);
  });

  it('returns needsHeuristicsRecheck on successful mutations', async () => {
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [mkCourse('IS 101', 3)], credits_planned: 3 }],
      allCourses: [mkCourse('IS 101', 3), mkCourse('IS 201', 3)],
    });
    const planId = seedStore(state);
    const tools = getAgentTools(planId);
    if (!tools.createTerm.execute) throw new Error('createTerm must have execute');
    if (!tools.removeCourseFromTerm.execute) throw new Error('removeCourseFromTerm must have execute');
    if (!tools.deleteTerm.execute) throw new Error('deleteTerm must have execute');

    const createResult = await tools.createTerm.execute({ termName: 'Winter 2027' });
    const removeResult = await tools.removeCourseFromTerm.execute({ termName: 'Fall 2026', courseCode: 'IS 101' });
    const deleteResult = await tools.deleteTerm.execute({ termName: 'Winter 2027' });

    expect(createResult.needsHeuristicsRecheck).toBe(true);
    expect(removeResult.needsHeuristicsRecheck).toBe(true);
    expect(deleteResult.needsHeuristicsRecheck).toBe(true);
  });

  it('does not create a new term when no unplanned courses remain', async () => {
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [mkCourse('IS 101', 3)], credits_planned: 3 }],
      allCourses: [mkCourse('IS 101', 3)],
    });
    const planId = seedStore(state);
    const tools = getAgentTools(planId);
    if (!tools.createTerm.execute) throw new Error('createTerm must have execute');

    const result = await tools.createTerm.execute({ termName: 'Winter 2027' });

    expect(result.message).toContain('No term created');
    expect(result.totalUnplanned).toBe(0);
    expect(store.get(planId)?.terms.length).toBe(1);
  });

  it('inserts milestones between existing terms', async () => {
    const state = mkState({
      terms: [{ term: 'Fall 2026', courses: [mkCourse('IS 101', 3)], credits_planned: 3 }],
      allCourses: [mkCourse('IS 101', 3)],
      milestones: [],
    });
    const planId = seedStore(state);
    const tools = getAgentTools(planId);
    if (!tools.insertMilestone.execute) throw new Error('insertMilestone must have execute');

    const result = await tools.insertMilestone.execute({
      milestoneName: 'Apply For Graduation',
      targetTerm: 'Fall 2026',
    });

    const milestones = result.milestones ?? [];
    expect(result.success).toBe(true);
    expect(Array.isArray(milestones)).toBe(true);
    expect(milestones.some((m: any) => m.title === 'Apply For Graduation')).toBe(true);
  });
});
