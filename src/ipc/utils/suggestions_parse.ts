import {
  getDyadAddDependencyTags,
  getDyadChatSummaryTag,
  getDyadDeleteTags,
  getDyadRenameTags,
  getDyadWriteTags,
} from "./dyad_tag_parser";
import {
  NextStepSuggestionSchema,
  type NextStepSuggestion,
} from "../types/suggestions";

export const MAX_SUGGESTIONS = 4;

/**
 * Whether an assistant message actually changed code/files (as opposed to a
 * plain chat / ask-mode reply). Used to decide if next-step suggestions are
 * worth generating.
 */
export function hasCodeChanges(content: string): boolean {
  return (
    getDyadWriteTags(content).length > 0 ||
    getDyadRenameTags(content).length > 0 ||
    getDyadDeleteTags(content).length > 0 ||
    getDyadAddDependencyTags(content).length > 0
  );
}

/**
 * Reduce an assistant message (which is full of code/tags) to a rough
 * natural-language description so the context we send to the model stays small.
 */
export function summarizeAssistantMessage(content: string): string {
  const summary = getDyadChatSummaryTag(content);
  if (summary) {
    return summary;
  }
  return content
    .replace(/<dyad-[\s\S]*?<\/dyad-[^>]*>/g, " ")
    .replace(/<dyad-[^>]*\/>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the model's raw text output into validated next-step suggestions.
 * Tolerant of markdown code fences and surrounding prose. Returns an empty
 * array if nothing valid can be extracted.
 */
export function parseSuggestions(text: string): NextStepSuggestion[] {
  let cleaned = text.trim();

  // Strip a markdown code fence if the model wrapped the JSON in one.
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Extract the first JSON array in the text.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const result: NextStepSuggestion[] = [];
  parsed.forEach((item, index) => {
    const record = item as Record<string, unknown>;
    const candidate = NextStepSuggestionSchema.safeParse({
      id: `suggestion-${index}`,
      title: record?.title,
      prompt: record?.prompt,
    });
    if (candidate.success && candidate.data.title && candidate.data.prompt) {
      result.push(candidate.data);
    }
  });

  return result.slice(0, MAX_SUGGESTIONS);
}
