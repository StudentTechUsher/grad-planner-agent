import { NextRequest, NextResponse } from 'next/server';

// ─── In-memory scaffold state ──────────────────────────────────────────
// Each plan has a planId (UUID generated client-side) and an evolving scaffold.
// Phases: major → minor → genEd → transcript
// Each phase adds courses into the term plan.

interface ScaffoldCourse {
    code: string;
    title: string;
    credits: number;
    source: 'major' | 'minor' | 'genEd';
    requirementId?: string;
    requirementDescription?: string;
}

interface ScaffoldTerm {
    term: string;
    courses: ScaffoldCourse[];
    credits_planned: number;
}

interface ScaffoldState {
    planId: string;
    createdAt: number;
    preferences: {
        maxCreditsPerTerm: number;
        minCreditsPerTerm: number;
    };
    phases: string[];           // which phases have been applied
    terms: ScaffoldTerm[];
    allCourses: ScaffoldCourse[]; // flat list of every course added
}

const store = new Map<string, ScaffoldState>();

// Cleanup old scaffolds after 2 hours
setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, state] of store) {
        if (state.createdAt < cutoff) store.delete(id);
    }
}, 10 * 60 * 1000);

// ─── Helpers ────────────────────────────────────────────────────────────

function distributeCoursesIntoTerms(
    existingTerms: ScaffoldTerm[],
    newCourses: ScaffoldCourse[],
    maxCredits: number,
    startTermLabel: string = 'Term 1',
): ScaffoldTerm[] {
    // Clone existing terms
    const terms: ScaffoldTerm[] = existingTerms.map(t => ({
        ...t,
        courses: [...t.courses],
    }));

    // Standard BYU term sequence
    const termLabels = [
        'Fall 2026', 'Winter 2027', 'Spring 2027', 'Summer 2027',
        'Fall 2027', 'Winter 2028', 'Spring 2028', 'Summer 2028',
        'Fall 2028', 'Winter 2029', 'Spring 2029', 'Summer 2029',
    ];

    for (const course of newCourses) {
        let placed = false;

        // Try to fit into an existing term that has room
        for (const term of terms) {
            if (term.credits_planned + course.credits <= maxCredits) {
                term.courses.push(course);
                term.credits_planned += course.credits;
                placed = true;
                break;
            }
        }

        // If no existing term has room, create a new one
        if (!placed) {
            const nextLabel = termLabels[terms.length] ?? `Term ${terms.length + 1}`;
            terms.push({
                term: nextLabel,
                courses: [course],
                credits_planned: course.credits,
            });
        }
    }

    return terms;
}

// ─── POST handler – add courses from a phase ────────────────────────────
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { planId, phase, courses, preferences } = body as {
        planId: string;
        phase: 'major' | 'minor' | 'genEd';
        courses: ScaffoldCourse[];
        preferences?: { maxCreditsPerTerm?: number; minCreditsPerTerm?: number };
    };

    if (!planId || !phase || !Array.isArray(courses)) {
        return NextResponse.json({ error: 'Missing required fields: planId, phase, courses' }, { status: 400 });
    }

    let state = store.get(planId);

    if (!state) {
        state = {
            planId,
            createdAt: Date.now(),
            preferences: {
                maxCreditsPerTerm: preferences?.maxCreditsPerTerm ?? 15,
                minCreditsPerTerm: preferences?.minCreditsPerTerm ?? 12,
            },
            phases: [],
            terms: [],
            allCourses: [],
        };
    }

    // Tag courses with source
    const taggedCourses: ScaffoldCourse[] = courses.map(c => ({
        ...c,
        source: phase,
    }));

    // Merge into state
    state.allCourses.push(...taggedCourses);
    state.phases.push(phase);
    state.terms = distributeCoursesIntoTerms(
        state.terms,
        taggedCourses,
        state.preferences.maxCreditsPerTerm,
    );

    store.set(planId, state);

    return NextResponse.json({
        success: true,
        planId,
        phase,
        coursesAdded: taggedCourses.length,
        totalCourses: state.allCourses.length,
        termsCount: state.terms.length,
        scaffold: {
            plan: state.terms,
        },
    });
}

// ─── GET handler – retrieve current scaffold ─────────────────────────────
export async function GET(req: NextRequest) {
    const planId = req.nextUrl.searchParams.get('planId');

    if (!planId) {
        return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    }

    const state = store.get(planId);

    if (!state) {
        return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }

    return NextResponse.json({
        planId: state.planId,
        phases: state.phases,
        totalCourses: state.allCourses.length,
        scaffold: {
            plan: state.terms,
        },
    });
}
