1. Next.js Architecture & Performance
Since we are building for scale and speed, we leverage the latest Next.js features to ensure a seamless user experience.

App Router: All new features must be built within the app/ directory to utilize Server Components by default.

Server Actions: Use Server Actions for data mutations (POST, PATCH, DELETE) to minimize client-side JavaScript and simplify form handling.

Streaming & Suspense: Implement loading.tsx and <Suspense /> boundaries for AI-generated content to ensure the UI remains responsive while waiting for large language model (LLM) responses.

Environment Variables: Strictly separate development and production keys using .env.local and Vercel's dashboard to protect sensitive AI API credentials.

2. Vercel AI SDK Integration
For agentic workflows and streaming interfaces, we utilize the Vercel AI SDK to manage LLM interactions efficiently.

useChat & useCompletion: Utilize these hooks for standard chat interfaces to benefit from built-in state management and automatic UI updates.

Streaming Data: Always enable streaming for long-form AI generations to reduce perceived latency for the user.

Tool Calling: When building agentic features, define clear tool schemas using libraries like zod to ensure the AI interacts with our backend services predictably.

Edge Runtime: Favor the Edge Runtime for AI route handlers to ensure the lowest possible latency and prevent cold starts.

3. Unit Testing & Quality Assurance
To maintain the stability of createV3 and our other services, every new feature must include comprehensive unit tests.

Testing Framework: We use Jest and React Testing Library for component and logic verification.

Test-Driven Development (TDD): Where possible, write tests for edge cases before implementing the final logic to ensure "breadth of execution" is met.

Mocking AI Responses: Never make live API calls during unit tests. Use mocks to simulate various LLM outputs, including successful streams, tool calls, and error states.

Coverage Goals:

Logic/Utils: 100% coverage for helper functions and data parsers.

Components: Verify that UI elements render correctly based on different props and AI states.

Hooks: Ensure custom hooks (like those wrapping useChat) manage internal state as expected.

4. Implementation Checklist
Before submitting a Pull Request, ensure you have:

[ ] Verified that all Server Components are utilized where possible.

[ ] Confirmed AI streaming works without UI "jank".

[ ] Added unit tests covering at least two edge cases for your feature.

[ ] Checked that no sensitive API keys are hardcoded.