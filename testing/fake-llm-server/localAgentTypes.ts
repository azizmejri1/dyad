/**
 * TypeScript types for the Local Agent E2E testing DSL
 */

export type ToolCall = {
  /** The name of the tool to call */
  name: string;
  /** Arguments to pass to the tool */
  args: Record<string, unknown>;
};

export type Turn = {
  /** Optional text content to output before tool calls */
  text?: string;
  /** Tool calls to execute in this turn */
  toolCalls?: ToolCall[];
  /** Text to output after tool results are received (final turn only) */
  textAfterTools?: string;
};

export type LocalAgentFixture = {
  /** Description for debugging */
  description?: string;
  /** Ordered turns in the conversation */
  turns: Turn[];
  /**
   * How to determine which turn to serve.
   *
   * "tool-results-after-last-user" (default):
   *   Count tool-result messages after the last user message.
   *   Works for single-user-message flows where the agent makes
   *   multiple tool calls within one continuous run.
   *
   * "all-assistant-messages":
   *   Count all assistant messages in the entire conversation.
   *   Required for multi-user-message flows (e.g., plan mode) where
   *   the user sends additional messages between agent runs.
   */
  turnCountMode?: "tool-results-after-last-user" | "all-assistant-messages";
};
