import { useAtomValue } from "jotai";
import { Sparkles } from "lucide-react";

import { isStreamingByIdAtom } from "@/atoms/chatAtoms";
import { useNextStepSuggestions } from "@/hooks/useNextStepSuggestions";

// Same pill styling as the homepage inspiration prompts (see src/pages/home.tsx).
const PILL_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground";

/**
 * Renders AI-generated "next step" suggestions as pill-shaped buttons above the
 * chat composer. Clicking a pill fills the chat input with the full prompt
 * (it does not submit). Experimental — gated behind the
 * `enableNextStepSuggestions` setting inside `useNextStepSuggestions`.
 */
export function NextStepSuggestions({
  chatId,
  onSelect,
}: {
  chatId?: number;
  onSelect: (prompt: string) => void;
}) {
  const { suggestions } = useNextStepSuggestions(chatId);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const isStreaming = chatId ? (isStreamingById.get(chatId) ?? false) : false;

  // Hide while a response is streaming or when there is nothing to suggest.
  if (isStreaming || suggestions.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="next-step-suggestions"
      className="flex flex-wrap items-center gap-2 px-2 pb-2"
    >
      {suggestions.map((suggestion) => (
        <button
          type="button"
          key={suggestion.id}
          title={suggestion.prompt}
          onClick={() => onSelect(suggestion.prompt)}
          className={PILL_CLASS}
        >
          <Sparkles aria-hidden="true" className="size-4" />
          {suggestion.title}
        </button>
      ))}
    </div>
  );
}
