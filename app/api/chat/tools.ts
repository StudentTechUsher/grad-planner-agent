import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { supabase } from '@/lib/supabase';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { store, ScaffoldMilestone, ScaffoldState } from '../store';

export type HeuristicViolationType =
  | 'overMax'
  | 'underMin'
  | 'duplicateCourse'
  | 'unplannedCourse'
  | 'missingPrerequisite'
  | 'paceRule';

export interface HeuristicViolation {
  type: HeuristicViolationType;
  termName: string;
  actualCredits?: number;
  targetCredits?: number;
  deltaCredits?: number;
  courseCode?: string;
  prerequisite?: string;
  missingPrerequisites?: string[];
  paceRule?: string;
}

export interface PlanHeuristicsSummary {
  message: string;
  isPlanSound: boolean;
  warnings: string[];
  violations: HeuristicViolation[];
  totalUnplanned: number;
  plan: ScaffoldState['terms'];
}

export const REQUIRED_MILESTONE_NAME = 'Apply For Graduation';

type CoursePlacement = {
  count: number;
  terms: Set<string>;
};

const isHalfTerm = (termName: string): boolean =>
  termName.toLowerCase().includes('spring') || termName.toLowerCase().includes('summer');

const getTermCreditLimits = (
  termName: string,
  preferences: ScaffoldState['preferences'],
): { currentMin: number; currentMax: number } => {
  const maxCredits = preferences.maxCreditsPerTerm;
  const minCredits = preferences.minCreditsPerTerm;

  if (isHalfTerm(termName)) {
    return {
      currentMax: Math.ceil(maxCredits / 2),
      currentMin: Math.ceil(minCredits / 2),
    };
  }

  return {
    currentMax: maxCredits,
    currentMin: minCredits,
  };
};

const getActualTermCredits = (term: ScaffoldState['terms'][number]): number =>
  term.courses.reduce((sum, c) => sum + (c.credits || 0), 0);

export const getPlacedCourseMap = (terms: ScaffoldState['terms']): Map<string, CoursePlacement> => {
  const placements = new Map<string, CoursePlacement>();
  for (const term of terms) {
    for (const course of term.courses) {
      const existing = placements.get(course.code);
      if (existing) {
        existing.count += 1;
        existing.terms.add(term.term);
      } else {
        placements.set(course.code, { count: 1, terms: new Set([term.term]) });
      }
    }
  }
  return placements;
};

export const getRemainingCourses = (state: ScaffoldState): ScaffoldState['allCourses'] => {
  const placedCodes = new Set(state.terms.flatMap((t) => t.courses.map((c) => c.code)));
  return state.allCourses.filter((c) => !placedCodes.has(c.code));
};

export const getDuplicateCourseViolations = (terms: ScaffoldState['terms']): HeuristicViolation[] => {
  const placements = getPlacedCourseMap(terms);
  const violations: HeuristicViolation[] = [];

  for (const [courseCode, placement] of placements) {
    if (placement.count <= 1) continue;
    violations.push({
      type: 'duplicateCourse',
      termName: Array.from(placement.terms).join(', '),
      courseCode,
      deltaCredits: placement.count - 1,
    });
  }

  return violations;
};

const normalizeCourseCode = (code: string): string =>
  code.replace(/\s+/g, '').toUpperCase();

const extractCourseCodes = (text: string): string[] => {
  const matches = text.toUpperCase().match(/\b[A-Z]{2,}(?:\s+[A-Z]{1,4}){0,2}\s*\d{3}[A-Z]?\b/g) ?? [];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const match of matches) {
    const normalized = normalizeCourseCode(match);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
};

const parsePrerequisiteGroups = (prerequisite: string): string[][] => {
  const cleaned = prerequisite
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  const andSegments = cleaned.split(/\bAND\b|;|,/i).map((segment) => segment.trim()).filter(Boolean);
  const groups: string[][] = [];

  for (const segment of andSegments) {
    const codes = extractCourseCodes(segment);
    if (codes.length === 0) continue;

    const hasOr = /\bOR\b|\/|\|/i.test(segment);
    if (hasOr) {
      groups.push(codes);
      continue;
    }

    for (const code of codes) {
      groups.push([code]);
    }
  }

  return groups;
};

const getPrerequisiteViolations = (state: ScaffoldState): HeuristicViolation[] => {
  const violations: HeuristicViolation[] = [];
  const completedCourseCodes = new Set(
    (state.completedCourseCodes ?? []).map((code) => normalizeCourseCode(code)),
  );

  // Build a lookup so prerequisites can be read from either term courses or allCourses metadata.
  const courseMetadataByCode = new Map<string, ScaffoldState['allCourses'][number]>();
  for (const course of state.allCourses) {
    const key = normalizeCourseCode(course.code);
    if (!courseMetadataByCode.has(key)) {
      courseMetadataByCode.set(key, course);
    }
  }

  const earliestTermByCourseCode = new Map<string, number>();
  for (let termIndex = 0; termIndex < state.terms.length; termIndex++) {
    for (const course of state.terms[termIndex].courses) {
      const code = normalizeCourseCode(course.code);
      const existing = earliestTermByCourseCode.get(code);
      if (existing === undefined || termIndex < existing) {
        earliestTermByCourseCode.set(code, termIndex);
      }
    }
  }

  for (let termIndex = 0; termIndex < state.terms.length; termIndex++) {
    const term = state.terms[termIndex];
    for (const course of term.courses) {
      const courseCode = normalizeCourseCode(course.code);
      const metadata = courseMetadataByCode.get(courseCode);
      const prerequisite = typeof course.prerequisite === 'string'
        ? course.prerequisite
        : typeof metadata?.prerequisite === 'string'
          ? metadata.prerequisite
          : '';
      if (!prerequisite) continue;

      const prerequisiteGroups = parsePrerequisiteGroups(prerequisite);
      if (prerequisiteGroups.length === 0) continue;

      const unmetGroups = prerequisiteGroups.filter((group) => {
        const groupSatisfied = group.some((requiredCode) => {
          if (completedCourseCodes.has(requiredCode)) return true;

          const plannedTermIndex = earliestTermByCourseCode.get(requiredCode);
          return typeof plannedTermIndex === 'number' && plannedTermIndex < termIndex;
        });

        return !groupSatisfied;
      });

      if (unmetGroups.length === 0) continue;

      violations.push({
        type: 'missingPrerequisite',
        termName: term.term,
        courseCode: course.code,
        prerequisite,
        missingPrerequisites: unmetGroups.map((group) => group.join(' OR ')),
      });
    }
  }

  return violations;
};

type ParsedTerm = {
  raw: string;
  season: 'fall' | 'winter' | 'spring' | 'summer';
  year: number;
};

const parseTerm = (termName: string): ParsedTerm | null => {
  const normalized = termName.trim();
  const match = normalized.match(/\b(fall|winter|spring|summer)(?:\s+semester)?\s+(\d{4})\b/i);
  if (!match) return null;

  const season = match[1].toLowerCase() as ParsedTerm['season'];
  const year = Number(match[2]);
  if (!Number.isFinite(year)) return null;

  return { raw: termName, season, year };
};

const isShortTerm = (parsed: ParsedTerm): boolean =>
  parsed.season === 'spring' || parsed.season === 'summer';

const toTermOrdinal = (parsed: ParsedTerm): number => {
  // Calendar progression where Fall -> Winter(next year) is +1.
  const seasonOffset: Record<ParsedTerm['season'], number> = {
    winter: 0,
    spring: 1,
    summer: 2,
    fall: 3,
  };
  return parsed.year * 4 + seasonOffset[parsed.season];
};

const getPaceViolations = (state: ScaffoldState): HeuristicViolation[] => {
  const violations: HeuristicViolation[] = [];
  const pace = state.preferences.graduationPace;

  const nonEmptyTerms = state.terms
    .filter((term) => Array.isArray(term.courses) && term.courses.length > 0)
    .map((term) => ({ termName: term.term, parsed: parseTerm(term.term) }))
    .filter((entry): entry is { termName: string; parsed: ParsedTerm } => entry.parsed !== null);

  if (nonEmptyTerms.length < 2) return violations;

  if (pace === 'fast') {
    for (let i = 1; i < nonEmptyTerms.length; i++) {
      const prev = nonEmptyTerms[i - 1];
      const curr = nonEmptyTerms[i];
      const gap = toTermOrdinal(curr.parsed) - toTermOrdinal(prev.parsed) - 1;
      if (gap > 0) {
        violations.push({
          type: 'paceRule',
          termName: curr.termName,
          paceRule: `ASAP pace cannot skip terms. Gap detected between ${prev.termName} and ${curr.termName}.`,
        });
      }
    }
    return violations;
  }

  if (pace === 'sustainable') {
    const lastTwoStart = Math.max(0, nonEmptyTerms.length - 2);
    for (let i = 0; i < nonEmptyTerms.length; i++) {
      const entry = nonEmptyTerms[i];
      if (!isShortTerm(entry.parsed)) continue;
      if (i < lastTwoStart) {
        violations.push({
          type: 'paceRule',
          termName: entry.termName,
          paceRule: `Sustainable pace should prioritize Fall/Winter first. ${entry.termName} appears too early.`,
        });
      }
    }
    return violations;
  }

  if (pace === 'undecided') {
    const hasMajorDecision =
      state.phases.includes('major') || state.allCourses.some((course) => course.source === 'major');

    if (!hasMajorDecision) {
      for (const entry of nonEmptyTerms) {
        if (!isShortTerm(entry.parsed)) continue;
        violations.push({
          type: 'paceRule',
          termName: entry.termName,
          paceRule: `Undecided pace disallows Spring/Summer terms until a major is chosen.`,
        });
      }
    }
  }

  return violations;
};

export const evaluatePlanHeuristics = (state: ScaffoldState): PlanHeuristicsSummary => {
  const warnings: string[] = [];
  const violations: HeuristicViolation[] = [];
  const remainingCourses = getRemainingCourses(state);
  const totalUnplanned = remainingCourses.length;

  let lastNonEmptyTermIndex = -1;
  for (let i = 0; i < state.terms.length; i++) {
    if (state.terms[i].courses.length > 0) {
      lastNonEmptyTermIndex = i;
    }
  }

  for (let i = 0; i < state.terms.length; i++) {
    const term = state.terms[i];
    const actualCredits = getActualTermCredits(term);
    const { currentMax, currentMin } = getTermCreditLimits(term.term, state.preferences);
    const isFinalGraduatingTerm = i === lastNonEmptyTermIndex && totalUnplanned === 0;

    if (actualCredits > currentMax) {
      warnings.push(`Term ${term.term} exceeds max credits (${actualCredits} > ${currentMax}).`);
      violations.push({
        type: 'overMax',
        termName: term.term,
        actualCredits,
        targetCredits: currentMax,
        deltaCredits: actualCredits - currentMax,
      });
      continue;
    }

    if (actualCredits > 0 && actualCredits < currentMin && !isFinalGraduatingTerm) {
      warnings.push(`Term ${term.term} is below min credits (${actualCredits} < ${currentMin}).`);
      violations.push({
        type: 'underMin',
        termName: term.term,
        actualCredits,
        targetCredits: currentMin,
        deltaCredits: currentMin - actualCredits,
      });
    }
  }

  const duplicateViolations = getDuplicateCourseViolations(state.terms);
  for (const duplicate of duplicateViolations) {
    warnings.push(
      `Course ${duplicate.courseCode} is duplicated in terms: ${duplicate.termName}.`,
    );
    violations.push(duplicate);
  }

  const prerequisiteViolations = getPrerequisiteViolations(state);
  for (const prerequisiteViolation of prerequisiteViolations) {
    const missing = prerequisiteViolation.missingPrerequisites?.join('; ') ?? prerequisiteViolation.prerequisite ?? 'unknown prerequisite';
    warnings.push(
      `Course ${prerequisiteViolation.courseCode} in ${prerequisiteViolation.termName} has unmet prerequisite(s): ${missing}.`,
    );
    violations.push(prerequisiteViolation);
  }

  const paceViolations = getPaceViolations(state);
  for (const paceViolation of paceViolations) {
    warnings.push(paceViolation.paceRule ?? `Pace rule violated in ${paceViolation.termName}.`);
    violations.push(paceViolation);
  }

  if (totalUnplanned > 0) {
    warnings.push(`${totalUnplanned} selected course(s) are not placed in any term.`);
    for (const course of remainingCourses) {
      violations.push({
        type: 'unplannedCourse',
        termName: 'UNASSIGNED',
        courseCode: course.code,
      });
    }
  }

  const isPlanSound = warnings.length === 0 && totalUnplanned === 0;
  const message = isPlanSound
    ? 'All heuristic checks passed! The plan is structurally sound.'
    : `Heuristic checks found ${warnings.length} issue(s).`;

  return {
    message,
    isPlanSound,
    warnings,
    violations,
    totalUnplanned,
    plan: state.terms,
  };
};

export const getAgentTools = (planId: string) => {
  const state = store.get(planId);
  const ensureCollections = (nextState: ScaffoldState): ScaffoldState => {
    if (!Array.isArray(nextState.terms)) nextState.terms = [];
    if (!Array.isArray(nextState.allCourses)) nextState.allCourses = [];
    if (!Array.isArray(nextState.milestones)) nextState.milestones = [];
    if (!Array.isArray(nextState.selectedProgramIds)) nextState.selectedProgramIds = [];
    return nextState;
  };
  const insertMilestoneInState = (
    milestoneName: string,
    targetTerm: string,
  ) => {
    const nextStateRaw = store.get(planId);
    const nextState = nextStateRaw ? ensureCollections(nextStateRaw) : null;
    if (!nextState) return { error: 'Plan state not found.' as const };

    const normalizedTargetTerm = targetTerm.trim();
    if (!normalizedTargetTerm) {
      return { error: 'targetTerm is required.' as const, plan: nextState.terms, milestones: nextState.milestones };
    }

    const termExists = nextState.terms.some((term) => term.term === normalizedTargetTerm);
    if (!termExists) {
      return {
        error: `Cannot place milestone after unknown term "${normalizedTargetTerm}".`,
        plan: nextState.terms,
        milestones: nextState.milestones,
      };
    }

    const normalizedName = milestoneName.trim();
    if (!normalizedName) {
      return { error: 'milestoneName is required.' as const, plan: nextState.terms, milestones: nextState.milestones };
    }

    const alreadyExists = nextState.milestones.find((m) =>
      m.title.toLowerCase() === normalizedName.toLowerCase() && m.afterTerm === normalizedTargetTerm,
    );

    if (alreadyExists) {
      return {
        success: true,
        message: `Milestone "${normalizedName}" already exists after ${normalizedTargetTerm}.`,
        milestone: alreadyExists,
        plan: nextState.terms,
        milestones: nextState.milestones,
      };
    }

    const milestone: ScaffoldMilestone = {
      id: `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: normalizedName,
      title: normalizedName,
      afterTerm: normalizedTargetTerm,
    };
    nextState.milestones.push(milestone);
    store.set(planId, nextState);

    return {
      success: true,
      message: `Inserted milestone "${normalizedName}" after ${normalizedTargetTerm}.`,
      milestone,
      plan: nextState.terms,
      milestones: nextState.milestones,
    };
  };

  return {
    requestUserPreferences: {
      description: 'Ask the user for their graduation plan preferences (e.g., max credits per semester). This will render a form for them to fill out. You must wait for the client to return the form submission.',
      inputSchema: z.object({}),
      ...(state?.hasPreferencesSet ? {
        execute: async () => ({
          error: "You already have the user's preferences! Do not call this again.",
          message: "Preferences already saved previously.",
          preferences: state.preferences
        })
      } : {})
    },
    updateUserPreferences: {
      description: 'Re-open the graduation preferences form so the user can update previously saved values. Use this when the user explicitly asks to change preferences.',
      inputSchema: z.object({}),
    },
    requestMajorSelection: {
      description: 'Ask the user to select their desired major(s). The form supports up to 2 majors and returns selectedPrograms/selectedProgramIds for sequential processing. You must wait for the client to return the form submission.',
      inputSchema: z.object({}),
    },
    requestMinorSelection: {
      description: 'Ask the user to select their desired minor(s). The form supports 0-3 minors and returns selectedPrograms/selectedProgramIds for sequential processing. You must wait for the client to return the form submission.',
      inputSchema: z.object({}),
    },
    requestHonorsSelection: {
      description: 'Ask honors students to confirm honors-course handling. This currently renders an acknowledgment form because honors configuration is not yet available.',
      inputSchema: z.object({}),
    },
    requestGenEdSelection: {
      description: '[DEPRECATED — use selectGenEdCourses instead] Ask the user to select their General Education requirement set. You must wait for the client to return the form submission.',
      inputSchema: z.object({}),
    },
    selectMajorCourses: {
      description: 'Present the user with a per-requirement course selection form for their chosen program. Use programType=\'major\' for undergrad majors and programType=\'graduate_no_gen_ed\' for graduate programs. You must wait for the client to submit.',
      inputSchema: z.object({
        programName: z.string().describe('The exact program name, e.g. "Information Systems (BSIS)"'),
        programType: z.enum(['major', 'graduate_no_gen_ed']).optional().describe('Program type for requirement lookup. Use graduate_no_gen_ed for graduate students.'),
        selectedPrograms: z.array(z.string()).optional().describe('Optional ordered list of all selected majors/programs for sequential processing.'),
        selectedProgramIds: z.array(z.string()).optional().describe('Optional ordered list of selected program IDs aligned to selectedPrograms.'),
        currentIndex: z.number().int().min(0).optional().describe('Optional zero-based index within selectedPrograms for the currently processed program.'),
      }),
    },
    selectMinorCourses: {
      description: 'Present the user with a per-requirement course selection form for their chosen minor program. You must wait for the client to submit. Skip this if the user has no minor.',
      inputSchema: z.object({
        programName: z.string().describe('The exact minor program name'),
        selectedPrograms: z.array(z.string()).optional().describe('Optional ordered list of all selected minors for sequential processing.'),
        selectedProgramIds: z.array(z.string()).optional().describe('Optional ordered list of selected minor IDs aligned to selectedPrograms.'),
        currentIndex: z.number().int().min(0).optional().describe('Optional zero-based index within selectedPrograms for the currently processed minor.'),
      }),
    },
    selectGenEdCourses: {
      description: 'Present the user with a combined GE catalog year picker and per-requirement course selection form for General Education. You must wait for the client to submit.',
      inputSchema: z.object({}),
    },
    viewProgramRequirements: {
      description: 'View the requirements for a specific academic program.',
      inputSchema: z.object({
        programName: z.string().describe('The name of the program, e.g., "Information Systems (BSIS)"'),
      }),
      execute: async ({ programName }: { programName: string }) => {
        try {
          const fileContent = await fs.readFile(
            path.join(process.cwd(), 'information-systems-bsis.json'),
            'utf-8'
          );
          return JSON.parse(fileContent);
        } catch (e) {
          return { error: 'Program requirements not found.' };
        }
      },
    },
    getStudentTranscript: {
      description: '[DEPRECATED — transcript is now uploaded in requestUserPreferences] Ask the user to provide their student transcript.',
      inputSchema: z.object({}),
    },
    creditsCalculator: {
      description: 'Calculate how many credits a student has left to complete a program.',
      inputSchema: z.object({
        totalRequired: z.number().describe('Total credits required for the program'),
        completedCredits: z.number().describe('Total credits already completed by the student'),
      }),
      execute: async ({ totalRequired, completedCredits }: { totalRequired: number, completedCredits: number }) => {
        const remaining = totalRequired - completedCredits;
        return {
          remainingCredits: remaining > 0 ? remaining : 0,
          message: remaining > 0 ? `Student needs ${remaining} more credits.` : 'Student has met the credit requirement.'
        };
      },
    },
    requestCareerQuestionnaire: {
      description: 'Present the user with a 6-question career discovery form to help determine the best major for them. Call this when the user doesn\'t know their major. Wait for the user to submit all answers before calling queryPrograms.',
      inputSchema: z.object({}),
    },
    queryPrograms: {
      description: 'Intelligently query the database for available programs. Provide the programType and a userContext describing what the student is looking for (their interests, questionnaire answers, etc). This tool uses gpt-5 to generate multiple search keywords, queries the database for each, and returns the top 3 curated programs with reasoning. Use this instead of making multiple manual queries.',
      inputSchema: z.object({
        programType: z.enum(['major', 'minor', 'gen_ed', 'graduate_no_gen_ed']).describe('The type of program to query for'),
        userContext: z.string().describe('Description of the student\'s interests, strengths, and preferences from the questionnaire answers'),
      }),
      execute: async ({ programType, userContext }: { programType: string, userContext: string }) => {
        // Step 1: Use gpt-5 to generate 3 diverse search keywords
        const keywordsResult = await generateText({
          model: openai('gpt-5'),
          prompt: `Based on this student profile, generate exactly 3 diverse one-word search keywords to find matching university ${programType} programs. Each keyword should target a different angle of their interests.\n\nStudent profile: ${userContext}\n\nRespond with ONLY 3 keywords separated by commas, nothing else. Example: "computer,business,data"`,
        });

        const keywords = keywordsResult.text.split(',').map(k => k.trim().toLowerCase()).filter(Boolean).slice(0, 3);

        // Step 2: Run a Supabase query for each keyword
        const allResults: { keyword: string, programs: { name: string, minimum_credits: number, target_total_credits: number }[] }[] = [];

        for (const keyword of keywords) {
          const { data } = await supabase
            .from('program')
            .select('name, minimum_credits, target_total_credits, program_description')
            .eq('university_id', '1')
            .eq('program_type', programType)
            .ilike('program_description', `%${keyword}%`)
            .limit(5);

          allResults.push({ keyword, programs: data ?? [] });
        }

        // Step 3: Use gpt-5 to select the single best program from each keyword's results
        const flatPrograms = allResults.flatMap(r => r.programs);
        const uniquePrograms = [...new Map(flatPrograms.map(p => [p.name, p])).values()] as { name: string, minimum_credits: number, target_total_credits: number, program_description?: string }[];

        if (uniquePrograms.length === 0) {
          // Fallback: return all programs of this type if keyword search found nothing
          const { data } = await supabase
            .from('program')
            .select('name, minimum_credits, target_total_credits')
            .eq('university_id', '1')
            .eq('program_type', programType)
            .limit(10);
          return { programs: data ?? [], keywords, note: 'Keyword search returned no results, showing all programs.' };
        }

        const pickResult = await generateText({
          model: openai('gpt-5'),
          prompt: `A student described themselves as: ${userContext}\n\nHere are available university programs found via description search:\n${uniquePrograms.map(p => `- ${p.name} (${p.minimum_credits}–${p.target_total_credits} credits)${p.program_description ? `\n  Description: ${p.program_description}` : ''}`).join('\n')}\n\nPick exactly 3 programs that best fit this student. For each, provide the EXACT program name and a 1-sentence reason.\n\nRespond in this exact JSON format (no markdown, no code fences):\n[{"name": "exact name", "reason": "why it fits"}, ...]`,
        });

        try {
          const picks = JSON.parse(pickResult.text);
          return { recommendedPrograms: picks, searchKeywords: keywords, totalCandidatesFound: uniquePrograms.length };
        } catch {
          // If JSON parsing fails, return raw results for the chat model to handle
          return { programs: uniquePrograms.slice(0, 5), keywords, rawReasoning: pickResult.text };
        }
      },
    },
    presentMajorOptions: {
      description: 'Present the user with 3 recommended majors based on their questionnaire answers. Each option must have a name (exactly matching a program in the database) and a short reason why it fits.',
      inputSchema: z.object({
        options: z.array(z.object({
          name: z.string().describe('Exact program name from the database'),
          reason: z.string().describe('1-2 sentence explanation of why this major fits the student'),
        })).length(3).describe('Exactly 3 recommended major options'),
      }),
    },
    generateGradPlanScaffold: {
      description: '[WARNING: This tool is invoked automatically by the client parallel to standard workflows. When you see this tool result, just ignore it and continue down your normal sequential flow (Steps 1-7). Never restart the sequence.] Generate a base graduation plan scaffold by placing remaining uncompleted courses into future terms based on typical sequencing.',
      inputSchema: z.object({
        programName: z.string().describe('Name of the program'),
        startingTerm: z.string().describe('The starting term for the plan e.g., "Fall 2026"'),
        completedCourseCodes: z.array(z.string()).describe('An array of course codes the student has already completed')
      }),
      execute: async ({ programName, startingTerm, completedCourseCodes }: { programName: string, startingTerm: string, completedCourseCodes: string[] }) => {
        try {
          const programContent = await fs.readFile(
            path.join(process.cwd(), 'information-systems-bsis.json'),
            'utf-8'
          );
          const programRequirements = JSON.parse(programContent);

          let allRequiredCourses: any[] = [];

          for (const req of programRequirements.programRequirements) {
            if (req.courses) {
              allRequiredCourses.push(...req.courses);
            } else if (req.subRequirements) {
              for (const subReq of req.subRequirements) {
                if (subReq.courses) {
                  allRequiredCourses.push(...subReq.courses);
                }
              }
            }
          }

          const remainingCourses = allRequiredCourses.filter(c => !completedCourseCodes.includes(c.code));

          const scaffold = {
            plan: [
              {
                term: "Fall Semester 2026",
                courses: remainingCourses.slice(0, Math.ceil(remainingCourses.length / 4)),
                credits_planned: remainingCourses.slice(0, Math.ceil(remainingCourses.length / 4)).reduce((acc: number, c: any) => acc + c.credits, 0)
              },
              {
                term: "Winter Semester 2027",
                courses: remainingCourses.slice(Math.ceil(remainingCourses.length / 4), Math.ceil(remainingCourses.length / 2)),
                credits_planned: remainingCourses.slice(Math.ceil(remainingCourses.length / 4), Math.ceil(remainingCourses.length / 2)).reduce((acc: number, c: any) => acc + c.credits, 0)
              },
              {
                term: "Fall Semester 2027",
                courses: remainingCourses.slice(Math.ceil(remainingCourses.length / 2), Math.ceil(remainingCourses.length * 3 / 4)),
                credits_planned: remainingCourses.slice(Math.ceil(remainingCourses.length / 2), Math.ceil(remainingCourses.length * 3 / 4)).reduce((acc: number, c: any) => acc + c.credits, 0)
              },
              {
                term: "Winter Semester 2028",
                courses: remainingCourses.slice(Math.ceil(remainingCourses.length * 3 / 4)),
                credits_planned: remainingCourses.slice(Math.ceil(remainingCourses.length * 3 / 4)).reduce((acc: number, c: any) => acc + c.credits, 0)
              },
            ]
          };

          return {
            message: `Generated scaffold for ${programName}. Filtered out ${completedCourseCodes.length} completed courses.`,
            scaffold
          };
        } catch (e) {
          return { error: 'Failed to generate scaffold.' };
        }
      },
    },
    checkCourseOfferedInTerm: {
      description: 'Check if a specific course is offered in a particular term.',
      inputSchema: z.object({
        courseCode: z.string().describe('The code of the course, e.g., "IS 402"'),
      }),
      execute: async ({ courseCode }: { courseCode: string }) => {
        try {
          const programContent = await fs.readFile(
            path.join(process.cwd(), 'information-systems-bsis.json'),
            'utf-8'
          );
          const programRequirements = JSON.parse(programContent);

          let foundCourse = null;
          for (const req of programRequirements.programRequirements) {
            if (req.courses) {
              foundCourse = req.courses.find((c: any) => c.code === courseCode);
              if (foundCourse) break;
            }
          }

          if (foundCourse && foundCourse.termsOffered) {
            return { course: courseCode, termsOffered: foundCourse.termsOffered };
          }
          return { course: courseCode, termsOffered: ['Fall', 'Winter', 'Spring', 'Summer'] };
        } catch (e) {
          return { error: 'Failed to check course.' };
        }
      },
    },
    insertAcademicMilestone: {
      description: '[DEPRECATED — use insertMilestone] Insert an academic milestone into the graduation plan.',
      inputSchema: z.object({
        milestoneName: z.string().describe('Name of the milestone'),
        targetTerm: z.string().describe('Term to place the milestone after'),
      }),
      execute: async ({ milestoneName, targetTerm }: { milestoneName: string, targetTerm: string }) =>
        insertMilestoneInState(milestoneName, targetTerm),
    },
    transcriptOCR: {
      description: '[DEPRECATED — transcript is now parsed via /api/transcript/parse, triggered from the preferences form]',
      inputSchema: z.object({}),
      execute: async () => {
        return { message: 'Transcript OCR has moved to the preferences form. Use the upload section there.' };
      }
    },
    requestPlanReview: {
      description: 'Ask the user to review the generated grad plan, then either save and return to Stuplanning or provide feedback to iterate.',
      inputSchema: z.object({}),
    },
    addMilestones: {
      description: 'Ask the user which milestones to add between terms. "Apply For Graduation" is required and cannot be deselected.',
      inputSchema: z.object({}),
    },

    // PLAYGROUND TOOLS
    getRemainingCoursesToPlan: {
      description: 'Get the list of all courses the user has selected but not yet placed into a term in the playground. Also returns user preferences to help you plan.',
      inputSchema: z.object({}),
      execute: async () => {
        const rawState = store.get(planId);
        let state = rawState ? ensureCollections(rawState) : null;
        if (!state) return { error: 'Plan state not found.' };

        const remaining = getRemainingCourses(state);

        return {
          totalUnplanned: remaining.length,
          remainingCourses: remaining,
          preferences: state.preferences
        };
      }
    },
    createTerm: {
      description: 'Create a new term (semester) in the graduation plan playground, but only when there are still unplanned courses to place.',
      inputSchema: z.object({
        termName: z.string().describe('e.g., "Fall 2026"'),
      }),
      execute: async ({ termName }: { termName: string }) => {
        const rawState = store.get(planId);
        let state = rawState ? ensureCollections(rawState) : null;
        if (!state) return { error: 'Plan state not found.' };

        const remaining = getRemainingCourses(state);
        if (remaining.length === 0) {
          return {
            message: `No term created: all selected courses are already planned. Continue to milestones/review instead of creating an empty term.`,
            plan: state.terms,
            milestones: state.milestones,
            needsHeuristicsRecheck: false,
            totalUnplanned: 0,
          };
        }

        const exists = state.terms.find((t: any) => t.term === termName);
        if (exists) return { message: `Term ${termName} already exists.` };

        const trailingTerm = state.terms[state.terms.length - 1];
        if (trailingTerm && Array.isArray(trailingTerm.courses) && trailingTerm.courses.length === 0) {
          return {
            message: `No term created: the latest term "${trailingTerm.term}" is already empty. Fill or delete it before creating another term.`,
            plan: state.terms,
            milestones: state.milestones,
            needsHeuristicsRecheck: false,
            totalUnplanned: remaining.length,
          };
        }

        state.terms.push({ term: termName, courses: [], credits_planned: 0 });
        store.set(planId, state);
        return {
          message: `Term ${termName} created successfully.`,
          plan: state.terms,
          milestones: state.milestones,
          needsHeuristicsRecheck: true,
        };
      }
    },
    deleteTerm: {
      description: 'Delete an empty term from the playground.',
      inputSchema: z.object({
        termName: z.string(),
      }),
      execute: async ({ termName }: { termName: string }) => {
        const rawState = store.get(planId);
        let state = rawState ? ensureCollections(rawState) : null;
        if (!state) return { error: 'Plan state not found.' };

        const term = state.terms.find((t: any) => t.term === termName);
        if (!term) {
          return { message: `Term ${termName} not found.`, plan: state.terms };
        }

        if (term.courses.length > 0) {
          return {
            error: `Term ${termName} is not empty and cannot be deleted.`,
            plan: state.terms,
            milestones: state.milestones,
          };
        }

        const hasMilestonesAfterTerm = state.milestones.some((milestone) => milestone.afterTerm === termName);
        if (hasMilestonesAfterTerm) {
          return {
            error: `Term ${termName} has milestone(s) attached and cannot be deleted.`,
            plan: state.terms,
            milestones: state.milestones,
          };
        }

        state.terms = state.terms.filter((t: any) => t.term !== termName);
        store.set(planId, state);

        return {
          message: `Term ${termName} deleted.`,
          plan: state.terms,
          milestones: state.milestones,
          needsHeuristicsRecheck: true,
        };
      }
    },
    addCoursesToTerm: {
      description: 'Add one or more courses to a specific term in the playground. Automatically returns a heuristics check.',
      inputSchema: z.object({
        termName: z.string(),
        courses: z.array(z.object({
          code: z.string(),
          title: z.string(),
          credits: z.number(),
          source: z.enum(['major', 'minor', 'genEd', 'placeholder']),
          requirementId: z.string().optional(),
          prerequisite: z.string().optional(),
        }))
      }),
      execute: async ({ termName, courses }: { termName: string, courses: any[] }) => {
        const rawState = store.get(planId);
        let state = rawState ? ensureCollections(rawState) : null;
        if (!state) return { error: 'Plan state not found.' };

        let term = state.terms.find((t: any) => t.term === termName);
        if (!term) {
          term = { term: termName, courses: [], credits_planned: 0 };
          state.terms.push(term);
        }

        term.courses.push(...courses);
        term.credits_planned = term.courses.reduce((sum: number, c: any) => sum + (c.credits || 0), 0);
        store.set(planId, state);

        // Automatic heuristics check
        const { currentMax } = getTermCreditLimits(termName, state.preferences);

        if (term.credits_planned > currentMax) {
          return {
            message: `Courses added to ${termName}, BUT WARNING: Term now has ${term.credits_planned} credits, which exceeds the max of ${currentMax} credits for this term!`,
            plan: state.terms,
            milestones: state.milestones,
            needsHeuristicsRecheck: true,
          };
        }
        return {
          message: `Added ${courses.length} courses to ${termName}. Term now has ${term.credits_planned} credits.`,
          plan: state.terms,
          milestones: state.milestones,
          needsHeuristicsRecheck: true,
        };
      }
    },
    removeCourseFromTerm: {
      description: 'Remove a specific course from a term in the playground.',
      inputSchema: z.object({
        termName: z.string(),
        courseCode: z.string()
      }),
      execute: async ({ termName, courseCode }: { termName: string, courseCode: string }) => {
        const rawState = store.get(planId);
        let state = rawState ? ensureCollections(rawState) : null;
        if (!state) return { error: 'Plan state not found.' };

        const term = state.terms.find((t: any) => t.term === termName);
        if (!term) return { error: `Term ${termName} not found.`, milestones: state.milestones };

        const initialLen = term.courses.length;
        term.courses = term.courses.filter((c: any) => c.code !== courseCode);
        term.credits_planned = term.courses.reduce((sum: number, c: any) => sum + (c.credits || 0), 0);
        store.set(planId, state);

        if (term.courses.length < initialLen) {
          return {
            message: `Course ${courseCode} removed from ${termName}.`,
            plan: state.terms,
            milestones: state.milestones,
            needsHeuristicsRecheck: true,
          };
        }

        return { message: `Course ${courseCode} not found in ${termName}.`, plan: state.terms, milestones: state.milestones };
      }
    },
    checkPlanHeuristics: {
      description: 'Analyze the current graduation plan for any constraint violations (e.g., exceeding max credits).',
      inputSchema: z.object({}),
      execute: async () => {
        const rawState = store.get(planId);
        let state = rawState ? ensureCollections(rawState) : null;
        if (!state) return { error: 'Plan state not found.' };
        return evaluatePlanHeuristics(state);
      }
    },
    insertMilestone: {
      description: 'Insert a milestone between terms in the playground. Use this after milestone preferences are collected.',
      inputSchema: z.object({
        milestoneName: z.string().describe('Milestone name, e.g. "Apply For Graduation"'),
        targetTerm: z.string().describe('Insert this milestone after the specified term.'),
      }),
      execute: async ({ milestoneName, targetTerm }: { milestoneName: string, targetTerm: string }) =>
        insertMilestoneInState(milestoneName, targetTerm),
    }
  };
};
