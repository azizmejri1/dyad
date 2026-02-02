import { expect } from "@playwright/test";
import { testSkipIfWindows, Timeout } from "./helpers/test_helper";

/**
 * E2E test for Plan Mode.
 *
 * Covers the full plan mode flow:
 * 1. Selecting plan mode
 * 2. Questionnaire appears and can be interacted with
 * 3. Plan panel shows after questionnaire submission
 * 4. Accepting the plan transitions to Agent v2 mode in a new chat
 */
testSkipIfWindows("plan mode - full flow", async ({ po }) => {
  // Setup: Pro user with Anthropic model (required for local agent path)
  await po.setUpDyadPro({ localAgent: true });
  await po.importApp("minimal");
  await po.selectPlanMode();

  // Step 1: Send prompt to trigger the plan-flow fixture.
  // The agent will call planning_questionnaire and then stop (hasToolCall condition).
  await po.sendPrompt("tc=local-agent/plan-flow");

  // Step 2: Questionnaire should appear. Answer the questions.
  await po.waitForQuestionnaire();

  // Question 1: Radio question - select "New UI component"
  await po.selectQuestionnaireRadio("New UI component");
  await po.clickQuestionnaireNext();

  // Question 2: Text question - type a description
  await po.fillQuestionnaireText("A dashboard widget that shows usage metrics");
  // Submit the questionnaire (sends answers as a new chat message).
  await po.clickQuestionnaireSubmit();

  // Step 3: Wait for the plan to be written and shown in the preview panel.
  // After submission, the agent calls write_plan (turn 1) then sends review
  // text (turn 2). Wait for the plan panel's Accept button to appear.
  await po.waitForPlanPanel();

  // Snapshot chat messages at this point to capture the questionnaire + plan flow.
  await po.snapshotMessages({ timeout: Timeout.MEDIUM });

  // Step 4: Accept the plan. This sends a message to the agent which calls
  // exit_plan (turn 3), transitioning to a new chat in Agent v2 mode.
  await po.clickAcceptPlan();

  // Verify the transition: chat mode should switch to Agent v2 (local-agent).
  await expect(po.page.getByTestId("chat-mode-selector")).toContainText(
    /Agent/,
    { timeout: Timeout.MEDIUM },
  );
});
