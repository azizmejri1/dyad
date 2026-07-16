import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import type { NextStepSuggestion } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import { useSettings } from "@/hooks/useSettings";

/**
 * Fetches AI-generated "next step" suggestions for a chat.
 *
 * This is an experimental feature: it only runs when
 * `settings.enableNextStepSuggestions` is on. The backend also returns an empty
 * list unless the latest assistant turn actually changed code. The query is
 * re-generated (invalidated) when a stream completes — see `useStreamChat`.
 */
export function useNextStepSuggestions(chatId?: number | undefined) {
  const { settings } = useSettings();
  const enabled = !!settings?.enableNextStepSuggestions && chatId !== undefined;

  const {
    data: suggestions,
    isLoading,
    error,
    refetch: refreshSuggestions,
  } = useQuery<NextStepSuggestion[], Error>({
    queryKey: queryKeys.nextStepSuggestions.detail({ chatId }),
    queryFn: async (): Promise<NextStepSuggestion[]> => {
      if (chatId === undefined) {
        return [];
      }
      return ipc.suggestions.generateSuggestions({ chatId });
    },
    enabled,
    // Generating suggestions costs an LLM call, so don't re-run on remount /
    // window focus. Fresh suggestions come from explicit invalidation on
    // stream completion.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return {
    suggestions: suggestions ?? [],
    isLoading,
    error,
    refreshSuggestions,
  };
}
