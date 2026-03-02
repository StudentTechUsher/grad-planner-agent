# Scaffolding Examples

The following are examples demonstrating how to correctly distribute new courses into an empty or partially full graduation plan while maintaining credit limits and following basic sequencing.

## Example 1: Creating a fresh sequence (Max 15 credits/term)
**Input:** No existing plan. Needs to place 5 Computer Science major courses.
**Desired Action:** Put courses into chronological terms. Stop strictly when credits reach <= 15 for a term, then create a new term.

```json
[
  {
    "term": "Fall 2026",
    "credits_planned": 12,
    "courses": [
      { "code": "C S 111", "credits": 3, "source": "major" },
      { "code": "C S 142", "credits": 3, "source": "major" },
      { "code": "MATH 112", "credits": 4, "source": "genEd" },
      { "code": "GE 000", "title": "Gen Ed Placeholder", "credits": 2, "source": "genEd" }
    ]
  },
  {
    "term": "Winter 2027",
    "credits_planned": 14,
    "courses": [
      { "code": "C S 224", "credits": 3, "source": "major" },
      { "code": "C S 235", "credits": 3, "source": "major" },
      { "code": "MATH 113", "credits": 4, "source": "genEd" },
      { "code": "GE 000", "title": "Gen Ed Placeholder", "credits": 4, "source": "genEd" }
    ]
  }
]
```

## Example 2: Distributing heavily with many remaining courses
**Input:** Student wants sustainable pacing (14 credits). 
**Desired Action:** DO NOT squish all courses into a few semesters! You must continuously add standard fall/winter terms (and spring/summer if explicitly requested pace is 'fast') until all courses are legally distributed within their 12-15 credit limits.

```json
[
  { "term": "Fall 2026", "credits_planned": 14, "courses": [ /* approx 4-5 courses */ ] },
  { "term": "Winter 2027", "credits_planned": 15, "courses": [ /* approx 4-5 courses */ ] },
  { "term": "Spring 2027", "credits_planned": 6, "courses": [ /* approx 2 courses */ ] },
  { "term": "Fall 2027", "credits_planned": 13, "courses": [ /* approx 4-5 courses */ ] },
  { "term": "Winter 2028", "credits_planned": 14, "courses": [ /* approx 4-5 courses */ ] },
  { "term": "Fall 2028", "credits_planned": 14, "courses": [ /* approx 4-5 courses */ ] },
  { "term": "Winter 2029", "credits_planned": 13, "courses": [ /* approx 4-5 courses */ ] },
  { "term": "Fall 2029", "credits_planned": 12, "courses": [ /* approx 4 courses */ ] }
]
```

## Example 3: Adding courses to an existing populated plan
**Input:** Plan already has Fall 2026 at 10 credits (Max allowed: 16). You need to add `BIO 130` (4 credits) and `BIO 220` (3 credits).
**Desired Action:** Add `BIO 130` to Fall 2026 (taking it to 14 credits). Place `BIO 220` into a new term (e.g., Winter 2027) because adding it to Fall would exceed the 16 credit limit. Do NOT modify the original courses in Fall 2026.
