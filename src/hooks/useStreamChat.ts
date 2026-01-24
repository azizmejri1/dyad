import { useCallback, useEffect } from "react";
import type {
  Message,
  FileAttachment,
  ComponentSelection,
} from "@/ipc/ipc_types";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
  recentStreamChatIdsAtom,
  queuedMessageByIdAtom,
} from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import type { ChatResponseEnd } from "@/ipc/ipc_types";
import { useChats } from "./useChats";
import { useLoadApp } from "./useLoadApp";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useVersions } from "./useVersions";
import { showExtraFilesToast, showWarning } from "@/lib/toast";
import { useSearch } from "@tanstack/react-router";
import { useRunApp } from "./useRunApp";
import { useCountTokens } from "./useCountTokens";
import { useUserBudgetInfo } from "./useUserBudgetInfo";
import { usePostHog } from "posthog-js/react";
import { useCheckProblems } from "./useCheckProblems";
import { useSettings } from "./useSettings";
import { useQueryClient } from "@tanstack/react-query";

export function getRandomNumberId() {
  return Math.floor(Math.random() * 1_000_000_000_000_000);
}

// Module-level set to track chatIds with active/pending streams
// This prevents race conditions when clicking rapidly before state updates
const pendingStreamChatIds = new Set<number>();

export function useStreamChat({
  hasChatId = true,
  shouldProcessQueue = false,
}: { hasChatId?: boolean; shouldProcessQueue?: boolean } = {}) {
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const setIsStreamingById = useSetAtom(isStreamingByIdAtom);
  const errorById = useAtomValue(chatErrorByIdAtom);
  const setErrorById = useSetAtom(chatErrorByIdAtom);
  const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const [selectedAppId] = useAtom(selectedAppIdAtom);
  const { invalidateChats } = useChats(selectedAppId);
  const { refreshApp } = useLoadApp(selectedAppId);

  const setStreamCountById = useSetAtom(chatStreamCountByIdAtom);
  const { refreshVersions } = useVersions(selectedAppId);
  const { refreshAppIframe } = useRunApp();
  const { refetchUserBudget } = useUserBudgetInfo();
  const { checkProblems } = useCheckProblems(selectedAppId);
  const { settings } = useSettings();
  const setRecentStreamChatIds = useSetAtom(recentStreamChatIdsAtom);
  const [queuedMessageById, setQueuedMessageById] = useAtom(
    queuedMessageByIdAtom,
  );

  const posthog = usePostHog();
  const queryClient = useQueryClient();
  let chatId: number | undefined;

  if (hasChatId) {
    const { id } = useSearch({ from: "/chat" });
    chatId = id;
  }
  const { invalidateTokenCount } = useCountTokens(chatId ?? null, "");

  const streamMessage = useCallback(
    async ({
      prompt,
      chatId,
      redo,
      attachments,
      selectedComponents,
      onSettled,
    }: {
      prompt: string;
      chatId: number;
      redo?: boolean;
      attachments?: FileAttachment[];
      selectedComponents?: ComponentSelection[];
      onSettled?: () => void;
    }) => {
      if (
        (!prompt.trim() && (!attachments || attachments.length === 0)) ||
        !chatId
      ) {
        return;
      }

      // Prevent duplicate streams - check module-level set to avoid race conditions
      if (pendingStreamChatIds.has(chatId)) {
        console.warn(
          `[CHAT] Ignoring duplicate stream request for chat ${chatId} - stream already in progress`,
        );
        // Call onSettled to allow callers to clean up their local loading state
        onSettled?.();
        return;
      }

      // Mark this chat as having a pending stream
      pendingStreamChatIds.add(chatId);

      setRecentStreamChatIds((prev) => {
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });

      setErrorById((prev) => {
        const next = new Map(prev);
        next.set(chatId, null);
        return next;
      });
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        next.set(chatId, true);
        return next;
      });

      let hasIncrementedStreamCount = false;
      try {
        IpcClient.getInstance().streamMessage(prompt, {
          selectedComponents: selectedComponents ?? [],
          chatId,
          redo,
          attachments,
          onUpdate: (updatedMessages: Message[]) => {
            if (!hasIncrementedStreamCount) {
              setStreamCountById((prev) => {
                const next = new Map(prev);
                next.set(chatId, (prev.get(chatId) ?? 0) + 1);
                return next;
              });
              hasIncrementedStreamCount = true;
            }

            setMessagesById((prev) => {
              const next = new Map(prev);
              next.set(chatId, updatedMessages);
              return next;
            });
          },
          onEnd: (response: ChatResponseEnd) => {
            // Remove from pending set now that stream is complete
            pendingStreamChatIds.delete(chatId);

            if (response.updatedFiles) {
              setIsPreviewOpen(true);
              refreshAppIframe();
              if (settings?.enableAutoFixProblems) {
                checkProblems();
              }
            }
            if (response.extraFiles) {
              showExtraFilesToast({
                files: response.extraFiles,
                error: response.extraFilesError,
                posthog,
              });
            }
            // Use queryClient directly with the chatId parameter to avoid stale closure issues
            queryClient.invalidateQueries({ queryKey: ["proposal", chatId] });

            refetchUserBudget();

            // Keep the same as below
            setIsStreamingById((prev) => {
              const next = new Map(prev);
              next.set(chatId, false);
              return next;
            });
            invalidateChats();
            refreshApp();
            refreshVersions();
            invalidateTokenCount();
            onSettled?.();
          },
          onError: (errorMessage: string) => {
            // Remove from pending set now that stream ended with error
            pendingStreamChatIds.delete(chatId);

            console.error(`[CHAT] Stream error for ${chatId}:`, errorMessage);
            setErrorById((prev) => {
              const next = new Map(prev);
              next.set(chatId, errorMessage);
              return next;
            });

            // Keep the same as above
            setIsStreamingById((prev) => {
              const next = new Map(prev);
              next.set(chatId, false);
              return next;
            });
            invalidateChats();
            refreshApp();
            refreshVersions();
            invalidateTokenCount();
            onSettled?.();
          },
        });
      } catch (error) {
        // Remove from pending set on exception
        pendingStreamChatIds.delete(chatId);

        console.error("[CHAT] Exception during streaming setup:", error);
        setIsStreamingById((prev) => {
          const next = new Map(prev);
          if (chatId) next.set(chatId, false);
          return next;
        });
        setErrorById((prev) => {
          const next = new Map(prev);
          if (chatId)
            next.set(
              chatId,
              error instanceof Error ? error.message : String(error),
            );
          return next;
        });
        onSettled?.();
      }
    },
    [
      setMessagesById,
      setIsStreamingById,
      setIsPreviewOpen,
      checkProblems,
      selectedAppId,
      refetchUserBudget,
      settings,
      queryClient,
    ],
  );

  // Process queued message when streaming ends successfully
  useEffect(() => {
    if (!chatId || !shouldProcessQueue) return;

    const queuedMessage = queuedMessageById.get(chatId);
    const isStreaming = isStreamingById.get(chatId);
    const hasError = errorById.get(chatId);

    // Only process queue if streaming ended successfully (no error)
    if (queuedMessage && !isStreaming && !hasError) {
      // Clear queue first to prevent loops
      setQueuedMessageById((prev) => {
        const next = new Map(prev);
        next.delete(chatId);
        return next;
      });

      posthog.capture("chat:submit", { chatMode: settings?.selectedChatMode });

      // Send the message
      streamMessage({
        prompt: queuedMessage.prompt,
        chatId,
        attachments: queuedMessage.attachments,
        selectedComponents: queuedMessage.selectedComponents,
      });
    }
  }, [
    chatId,
    queuedMessageById,
    isStreamingById,
    errorById,
    streamMessage,
    setQueuedMessageById,
    posthog,
    settings?.selectedChatMode,
  ]);

  return {
    streamMessage,
    isStreaming:
      hasChatId && chatId !== undefined
        ? (isStreamingById.get(chatId) ?? false)
        : false,
    error:
      hasChatId && chatId !== undefined
        ? (errorById.get(chatId) ?? null)
        : null,
    setError: (value: string | null) =>
      setErrorById((prev) => {
        const next = new Map(prev);
        if (chatId !== undefined) next.set(chatId, value);
        return next;
      }),
    setIsStreaming: (value: boolean) =>
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        if (chatId !== undefined) next.set(chatId, value);
        return next;
      }),
    queuedMessage:
      hasChatId && chatId !== undefined
        ? (queuedMessageById.get(chatId) ?? null)
        : null,
    queueMessage: (message: {
      prompt: string;
      attachments?: FileAttachment[];
      selectedComponents?: ComponentSelection[];
    }): boolean => {
      if (chatId === undefined) return false;
      const existingMessage = queuedMessageById.get(chatId);
      if (existingMessage) {
        showWarning(
          "A message is already queued. Wait for it to be sent or clear it.",
        );
        return false;
      }
      setQueuedMessageById((prev) => {
        const next = new Map(prev);
        next.set(chatId, message);
        return next;
      });
      return true;
    },
    clearQueuedMessage: () => {
      if (chatId === undefined) return;
      setQueuedMessageById((prev) => {
        const next = new Map(prev);
        next.delete(chatId);
        return next;
      });
    },
  };
}
