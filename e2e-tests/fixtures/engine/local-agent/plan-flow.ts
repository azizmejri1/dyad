import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

/**
 * Plan mode fixture: questionnaire → write plan → review text → exit plan
 *
 * This fixture simulates the full plan mode flow:
 * - Turn 0: Agent asks a questionnaire with 2 questions
 * - Turn 1: Agent writes an implementation plan
 * - Turn 2: Agent sends text telling user to review the plan
 * - Turn 3: Agent calls exit_plan after user accepts
 *
 * Uses "all-assistant-messages" counting because the user sends multiple
 * messages throughout the flow (initial prompt, questionnaire answers,
 * accept plan).
 */
export const fixture: LocalAgentFixture = {
  description: "Plan mode: questionnaire, write plan, review, exit",
  turnCountMode: "all-assistant-messages",
  turns: [
    // Turn 0: Agent asks a planning questionnaire
    {
      text: "Let me gather some requirements to create a good plan for you.",
      toolCalls: [
        {
          name: "planning_questionnaire",
          args: {
            title: "Feature Requirements",
            description:
              "Help me understand what you want to build so I can create a detailed plan.",
            questions: [
              {
                id: "feature_type",
                type: "radio",
                question: "What type of feature are you building?",
                options: [
                  "New UI component",
                  "API endpoint",
                  "Bug fix",
                ],
                required: true,
              },
              {
                id: "details",
                type: "text",
                question: "Describe the feature in more detail",
                required: true,
                placeholder: "e.g., A dashboard widget that shows...",
              },
            ],
          },
        },
      ],
    },
    // Turn 1: Agent writes the implementation plan based on user's answers
    {
      text: "Based on your requirements, here is the implementation plan.",
      toolCalls: [
        {
          name: "write_plan",
          args: {
            title: "New UI Component Implementation",
            summary:
              "Build a new dashboard widget component with data fetching and responsive layout.",
            plan: "## Overview\n\nImplement a new dashboard widget component.\n\n## Technical Approach\n\n- Create a React component with TypeScript\n- Use TanStack Query for data fetching\n- Add responsive CSS with Tailwind\n\n## Implementation Steps\n\n1. Create `src/components/DashboardWidget.tsx`\n2. Add data fetching hook `src/hooks/useWidgetData.ts`\n3. Add styles and responsive layout\n4. Write unit tests\n\n## Testing Strategy\n\n- Unit test the component rendering\n- Test data fetching with mock API",
          },
        },
      ],
    },
    // Turn 2: Agent tells user to review the plan
    {
      text: "I've created the implementation plan. Please review it in the preview panel. You can accept it to start implementation or let me know if you'd like any changes.",
    },
    // Turn 3: Agent exits plan mode after user accepts
    {
      text: "Great! Starting implementation now.",
      toolCalls: [
        {
          name: "exit_plan",
          args: {
            confirmation: true,
            implementationNotes:
              "Start with the DashboardWidget component, then add the data fetching hook.",
          },
        },
      ],
    },
  ],
};
