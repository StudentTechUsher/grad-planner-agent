import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { supabase } from '@/lib/supabase';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

export const agentTools = {
  requestUserPreferences: {
    description: 'Ask the user for their graduation plan preferences (e.g., max credits per semester). This will render a form for them to fill out. You must wait for the client to return the form submission.',
    inputSchema: z.object({}),
  },
  requestMajorSelection: {
    description: 'Ask the user to select their desired major. This will render a list for them to choose from. You must wait for the client to return the form submission.',
    inputSchema: z.object({}),
  },
  requestMinorSelection: {
    description: 'Ask the user to select their desired minor. You must wait for the client to return the form submission.',
    inputSchema: z.object({}),
  },
  requestGenEdSelection: {
    description: '[DEPRECATED — use selectGenEdCourses instead] Ask the user to select their General Education requirement set. You must wait for the client to return the form submission.',
    inputSchema: z.object({}),
  },
  selectMajorCourses: {
    description: 'Present the user with a per-requirement course selection form for their chosen major program. The form renders each requirement area with a dropdown of valid courses. You must wait for the client to submit.',
    inputSchema: z.object({
      programName: z.string().describe('The exact program name, e.g. "Information Systems (BSIS)"'),
    }),
  },
  selectMinorCourses: {
    description: 'Present the user with a per-requirement course selection form for their chosen minor program. You must wait for the client to submit. Skip this if the user has no minor.',
    inputSchema: z.object({
      programName: z.string().describe('The exact minor program name'),
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
    description: 'Generate a base graduation plan scaffold by placing remaining uncompleted courses into future terms based on typical sequencing.',
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
    description: 'Insert an academic milestone, such as "Apply for Graduation", into the graduation plan.',
    inputSchema: z.object({
      milestoneName: z.string().describe('Name of the milestone'),
      targetTerm: z.string().describe('Term it applies to'),
    }),
    execute: async ({ milestoneName, targetTerm }: { milestoneName: string, targetTerm: string }) => {
      return {
        success: true,
        milestone: {
          id: `milestone-${Date.now()}`,
          type: milestoneName,
          title: milestoneName,
          afterTerm: targetTerm
        }
      };
    },
  },
  transcriptOCR: {
    description: '[DEPRECATED — transcript is now parsed via /api/transcript/parse, triggered from the preferences form]',
    inputSchema: z.object({}),
    execute: async () => {
      return { message: 'Transcript OCR has moved to the preferences form. Use the upload section there.' };
    }
  },
  requestPlanReview: {
    description: 'Ask the user to review the generated grad plan, choose to either download it or provide feedback to iterate on it.',
    inputSchema: z.object({}),
  }
};
