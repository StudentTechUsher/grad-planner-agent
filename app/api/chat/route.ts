import { streamText, convertToModelMessages } from 'ai';
import { openai } from '@ai-sdk/openai';
import { agentTools } from './tools';
import fs from 'fs/promises';
import path from 'path';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Load BYU institutional context lazily
let byuContext: string | null = null;

export async function POST(req: Request) {
    if (byuContext === null) {
        try {
            const raw = await fs.readFile(path.join(process.cwd(), 'byu-context.json'), 'utf-8');
            byuContext = '\n\nINSTITUTION CONTEXT (BYU-specific rules — follow these strictly):\n' + raw;
        } catch {
            byuContext = ''; // File not found — continue without it
        }
    }

    const { messages } = await req.json();
    const coreMessages = await convertToModelMessages(messages);

    const result = streamText({
        model: openai('gpt-5-mini'),
        system:
            "You are the Grad Planner AI Agent. " +
            "Your purpose is to help university students create a graduation plan. " +
            "A grad plan is fundamentally a JSON record of the courses/actions a student needs to take. " +
            "CRITICAL RULE: You MUST use tools to advance the flow — never ask the user to choose which step is next. Just call the tools in order. " +
            "CRITICAL RULE: Never produce freeform text offering the user numbered choices like '1. do X, 2. do Y'. Pick the next step yourself and call the tool. " +
            "Follow this exact sequential flow: " +
            "STEP 1: Call requestUserPreferences. Wait for the user to submit. (The form may include an uploaded transcript with parsed courses.) " +
            "STEP 2: Call requestMajorSelection. Wait for the user. " +
            "   - If result contains selectedProgram → major is set. Move immediately to STEP 3. " +
            "   - If result contains action='needsHelp' → call requestCareerQuestionnaire, wait for answers, " +
            "     then call queryPrograms (programType='major', userContext=summary of answers), " +
            "     then call presentMajorOptions with the 3 recommendedPrograms. Wait for the user to pick one. Then move to STEP 3. " +
            "STEP 3: Call selectMajorCourses with programName set to the selected major. Wait for the user to submit course selections. " +
            "STEP 4: Call requestMinorSelection. Wait for the user to submit or skip. " +
            "STEP 5: If the user selected a minor, call selectMinorCourses with the minor programName. Wait for submission. If skipped, go to STEP 6. " +
            "STEP 6: Call selectGenEdCourses. Wait for the user to submit GE course selections. " +
            "STEP 7: Call requestPlanReview. The scaffold has already been built incrementally — do NOT call generateGradPlanScaffold. " +
            "   If the user wants to iterate, refine using tools then call requestPlanReview again. " +
            "Never call multiple form-request tools in the same step. Always wait for the result before calling the next tool." +
            byuContext,
        messages: coreMessages,
        tools: agentTools,
    });

    return result.toUIMessageStreamResponse();
}
