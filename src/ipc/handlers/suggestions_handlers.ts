import { type IpcMainInvokeEvent } from "electron";
import { streamText, type ModelMessage } from "ai";
import log from "electron-log";
import { and, desc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "../../db";
import { messages } from "../../db/schema";
import { readSettings } from "@/main/settings";
import { getModelClient } from "@/ipc/utils/get_model_client";
import {
  cancelOrphanedBaseStream,
  fastTextOutput,
} from "@/ipc/utils/stream_text_utils";
import {
  DYAD_INTERNAL_REQUEST_ID_HEADER,
  getAiHeaders,
  getProviderOptions,
} from "@/ipc/utils/provider_options";
import { createLoggedHandler } from "./safe_handle";
import { type NextStepSuggestion } from "../types/suggestions";
import {
  MAX_SUGGESTIONS,
  hasCodeChanges,
  parseSuggestions,
  summarizeAssistantMessage,
} from "../utils/suggestions_parse";

const logger = log.scope("suggestions_handlers");
const handle = createLoggedHandler(logger);

const SUGGESTIONS_SYSTEM_PROMPT = `You are a product assistant for an AI app builder. Given the app the user just built or modified, propose concise "next step" features the user could add next.

Rules:
- Return ONLY a JSON array. No prose, no explanation, no markdown code fences.
- Each array item is an object with exactly two string fields: {"title": string, "prompt": string}.
- "title" is a short button label, at most 4 words, in Title Case, with no trailing punctuation (e.g. "Add authentication").
- "prompt" is a full, self-contained build instruction telling the app builder exactly what to add (1-2 sentences).
- Propose between 3 and ${MAX_SUGGESTIONS} distinct, relevant, non-duplicate suggestions.
- Suggestions must be concrete next features for THIS specific app, not generic advice.`;

const generateSuggestionsHandler = async (
  _event: IpcMainInvokeEvent,
  { chatId }: { chatId: number },
): Promise<NextStepSuggestion[]> => {
  const settings = readSettings();

  // Experimental feature — off unless explicitly enabled.
  if (!settings.enableNextStepSuggestions) {
    return [];
  }

  // Find the latest assistant message for the chat.
  const latestAssistantMessage = await db.query.messages.findFirst({
    where: and(eq(messages.chatId, chatId), eq(messages.role, "assistant")),
    orderBy: [desc(messages.createdAt), desc(messages.id)],
    columns: { id: true, content: true },
  });

  if (!latestAssistantMessage?.content) {
    return [];
  }

  // Only suggest next steps after a turn that actually changed code/files.
  if (!hasCodeChanges(latestAssistantMessage.content)) {
    return [];
  }

  // Build a lightweight context from the most recent messages.
  const recentMessages = await db.query.messages.findMany({
    where: eq(messages.chatId, chatId),
    orderBy: [desc(messages.createdAt), desc(messages.id)],
    limit: 6,
    columns: { role: true, content: true },
  });
  const orderedMessages = [...recentMessages].reverse();

  const conversationContext = orderedMessages
    .map((m) => {
      const text =
        m.role === "assistant"
          ? summarizeAssistantMessage(m.content)
          : m.content;
      return `${m.role.toUpperCase()}: ${text.slice(0, 2000)}`;
    })
    .join("\n\n");

  try {
    const { modelClient } = await getModelClient(
      settings.selectedModel,
      settings,
    );
    const dyadRequestId = uuidv4();

    const suggestionMessages: ModelMessage[] = [
      {
        role: "user",
        content: `Here is the recent conversation for the app that was just built or modified:\n\n${conversationContext}\n\nPropose the next features to add.`,
      },
    ];

    const result = streamText({
      output: fastTextOutput(),
      model: modelClient.model,
      headers: {
        ...getAiHeaders({ builtinProviderId: modelClient.builtinProviderId }),
        [DYAD_INTERNAL_REQUEST_ID_HEADER]: dyadRequestId,
      },
      providerOptions: getProviderOptions({
        dyadAppId: 0,
        dyadRequestId,
        dyadDisableFiles: true,
        files: [],
        mentionedAppsCodebases: [],
        builtinProviderId: modelClient.builtinProviderId,
        settings,
      }),
      system: SUGGESTIONS_SYSTEM_PROMPT,
      messages: suggestionMessages,
      maxRetries: 1,
    });

    // Read `.textStream` eagerly, then cancel the orphaned tee branch — same
    // pattern the compaction handler uses.
    const textStream = result.textStream;
    cancelOrphanedBaseStream(result);

    let fullText = "";
    for await (const chunk of textStream) {
      fullText += chunk;
    }

    const suggestions = parseSuggestions(fullText);
    logger.debug(
      `Generated ${suggestions.length} next-step suggestions for chat ${chatId}`,
    );
    return suggestions;
  } catch (error) {
    logger.error(
      `Failed to generate next-step suggestions for chat ${chatId}:`,
      error,
    );
    return [];
  }
};

export function registerSuggestionsHandlers() {
  handle("chat:generate-suggestions", generateSuggestionsHandler);
}
