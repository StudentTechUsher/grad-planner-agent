// lib/transcriptParser.ts
// BYU transcript parser using OpenAI structured output (Responses API).
// Adapted from stu-suite's byuTranscriptParserOpenAI.ts — simplified for this agent.

export interface ParsedCourse {
    subject: string;
    number: string;
    title: string;
    credits: number;
    grade: string;
    term: string;
}

export interface TranscriptParseResult {
    success: boolean;
    courses: ParsedCourse[];
    gpa: number | null;
    courseCount: number;
    termCount: number;
    error?: string;
}

// JSON schema for OpenAI structured output
const TRANSCRIPT_JSON_SCHEMA = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
        gpa: {
            type: ['number', 'null'] as const,
            description: 'Overall undergraduate GPA, or null if not found',
        },
        terms: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                additionalProperties: false,
                properties: {
                    term: { type: 'string' as const, description: 'Term label (e.g., Fall Semester 2023)' },
                    courses: {
                        type: 'array' as const,
                        items: {
                            type: 'object' as const,
                            additionalProperties: false,
                            properties: {
                                subject: { type: 'string' as const, description: 'Course subject code, uppercase (e.g., CS, MATH, REL A)' },
                                number: { type: 'string' as const, description: 'Course number (e.g., 142, 112R)' },
                                title: { type: 'string' as const, description: 'Course title' },
                                credits: { type: 'number' as const, description: 'Credit hours' },
                                grade: { type: 'string' as const, description: 'Letter grade or empty string for in-progress' },
                            },
                            required: ['subject', 'number', 'title', 'credits', 'grade'],
                        },
                    },
                },
                required: ['term', 'courses'],
            },
        },
    },
    required: ['gpa', 'terms'],
};

const PARSE_PROMPT = `Extract ALL courses from this BYU academic transcript.

Course codes follow the pattern: Subject (uppercase letters, optional spaces, e.g. "CS", "REL A", "EC EN") + Number (3 digits, optional trailing letter, e.g. "142", "112R").

For each course extract: subject, number, title, credits (decimal), grade (letter grade, P/F/I/W/CR/NC, or empty string if in-progress).

Group courses by term (e.g. "Fall Semester 2023"). Also extract overall GPA if found.

Skip GPA summary lines, total credit lines, headers, footers, and administrative notes.
Be thorough — extract every course.`;

/**
 * Parse a transcript PDF buffer using OpenAI's API.
 * Sends the PDF as a base64 file input for vision-capable models.
 */
export async function parseTranscriptPdf(pdfBuffer: Buffer, fileName: string): Promise<TranscriptParseResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const model = process.env.OPENAI_TRANSCRIPT_MODEL ?? 'gpt-4o-mini';

    // Upload PDF to OpenAI Files API
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
    formData.append('file', blob, fileName || 'transcript.pdf');
    formData.append('purpose', 'user_data');

    const uploadRes = await fetch('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
    });

    if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`File upload failed (${uploadRes.status}): ${errText}`);
    }

    const uploadResult = await uploadRes.json();
    const fileId = (uploadResult as { id?: string }).id;
    if (!fileId) throw new Error('File upload did not return a file id');

    try {
        // Call OpenAI Responses API with file + structured output
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                input: [
                    {
                        role: 'user',
                        content: [
                            { type: 'input_file', file_id: fileId },
                            { type: 'input_text', text: PARSE_PROMPT },
                        ],
                    },
                ],
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'transcript_courses',
                        schema: TRANSCRIPT_JSON_SCHEMA,
                        strict: true,
                    },
                },
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI API failed (${response.status}): ${errText}`);
        }

        const result = await response.json();
        return parseOpenAIResult(result);
    } finally {
        // Clean up uploaded file
        await fetch(`https://api.openai.com/v1/files/${fileId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${apiKey}` },
        }).catch(() => { /* best-effort cleanup */ });
    }
}

/**
 * Parse transcript from pasted text using OpenAI chat completions.
 */
export async function parseTranscriptText(text: string): Promise<TranscriptParseResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const model = process.env.OPENAI_TRANSCRIPT_MODEL ?? 'gpt-4o-mini';

    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            input: [
                {
                    role: 'user',
                    content: `${PARSE_PROMPT}\n\n--- TRANSCRIPT TEXT ---\n${text}`,
                },
            ],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'transcript_courses',
                    schema: TRANSCRIPT_JSON_SCHEMA,
                    strict: true,
                },
            },
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API failed (${response.status}): ${errText}`);
    }

    const result = await response.json();
    return parseOpenAIResult(result);
}

function extractOutputText(result: unknown): string {
    if (!result || typeof result !== 'object') return '';

    const r = result as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };

    if (typeof r.output_text === 'string' && r.output_text.trim().length > 0) return r.output_text;

    if (Array.isArray(r.output)) {
        for (const item of r.output) {
            if (item?.content && Array.isArray(item.content)) {
                for (const part of item.content) {
                    if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
                }
            }
        }
    }

    return '';
}

function parseOpenAIResult(result: unknown): TranscriptParseResult {
    const text = extractOutputText(result);
    if (!text) {
        return { success: false, courses: [], gpa: null, courseCount: 0, termCount: 0, error: 'Empty response from OpenAI' };
    }

    try {
        const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr) as { gpa: number | null; terms: Array<{ term: string; courses: Array<{ subject: string; number: string; title: string; credits: number; grade: string }> }> };

        const courses: ParsedCourse[] = [];
        const termSet = new Set<string>();

        for (const term of parsed.terms ?? []) {
            termSet.add(term.term);
            for (const c of term.courses ?? []) {
                courses.push({
                    subject: c.subject,
                    number: c.number,
                    title: c.title,
                    credits: c.credits,
                    grade: c.grade,
                    term: term.term,
                });
            }
        }

        return {
            success: true,
            courses,
            gpa: parsed.gpa,
            courseCount: courses.length,
            termCount: termSet.size,
        };
    } catch (e) {
        return { success: false, courses: [], gpa: null, courseCount: 0, termCount: 0, error: 'Failed to parse OpenAI response' };
    }
}
