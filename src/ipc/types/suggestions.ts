import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Next-Step Suggestion Schemas
// =============================================================================

export const NextStepSuggestionSchema = z.object({
  id: z.string(),
  // Short button label shown on the pill (e.g. "Add authentication").
  title: z.string(),
  // Full instruction that gets filled into the chat input when clicked.
  prompt: z.string(),
});

export type NextStepSuggestion = z.infer<typeof NextStepSuggestionSchema>;

// =============================================================================
// Suggestion Contracts
// =============================================================================

export const suggestionsContracts = {
  generateSuggestions: defineContract({
    channel: "chat:generate-suggestions",
    input: z.object({ chatId: z.number() }),
    output: z.array(NextStepSuggestionSchema),
  }),
} as const;

// =============================================================================
// Suggestion Client
// =============================================================================

export const suggestionsClient = createClient(suggestionsContracts);
