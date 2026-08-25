// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { chats } from "@/db/schema";

const h = vi.hoisted(() => {
  process.env.NODE_ENV = "development";
  return { ipcHandlers: new Map() };
});

vi.mock("electron", async () => {
  const { createElectronMock } = await import("@/testing/electron_mock");
  return createElectronMock(h);
});

const telemetryEvents = vi.hoisted(
  () =>
    [] as Array<{ eventName: string; properties?: Record<string, unknown> }>,
);

vi.mock("@/ipc/utils/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ipc/utils/telemetry")>()),
  sendTelemetryEvent: (
    eventName: string,
    properties?: Record<string, unknown>,
  ) => {
    telemetryEvents.push({ eventName, properties });
  },
}));

import { getActiveStreamCount } from "@/ipc/handlers/chat_stream_handlers";
import {
  setupChatFlowHarness,
  type ChatFlowHarness,
} from "@/testing/chat_flow_harness";

function concurrentChatCounts(): unknown[] {
  return telemetryEvents
    .filter((event) => event.eventName === "chat:stream-start")
    .map((event) => event.properties?.concurrentChats);
}

describe("chat:stream-start concurrency telemetry", () => {
  let harness: ChatFlowHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    telemetryEvents.length = 0;
  });

  it("counts the chats already streaming when a turn is admitted", async () => {
    harness = await setupChatFlowHarness({ electronMock: h });
    const secondChat = harness.db
      .insert(chats)
      .values({ appId: harness.appId })
      .returning()
      .all()[0];

    // Held open by the fake server so the second turn is admitted while the
    // first is still streaming; the harness disposal cancels it.
    const parked = harness.streamChat("[sleep=long]");
    parked.catch(() => undefined);
    await vi.waitFor(() => expect(getActiveStreamCount()).toBe(1), {
      timeout: 10_000,
    });

    await harness.streamChat("hi", { chatId: secondChat.id });

    expect(concurrentChatCounts()).toEqual([1, 2]);
  }, 60_000);

  it("does not count an overlapping turn on the same chat as concurrency", async () => {
    harness = await setupChatFlowHarness({ electronMock: h });

    const parked = harness.streamChat("[sleep=long]");
    parked.catch(() => undefined);
    await vi.waitFor(() => expect(getActiveStreamCount()).toBe(1), {
      timeout: 10_000,
    });

    // Same chat, so `activeStreams` gains a second tracked stream under an
    // existing key rather than a new one.
    const overlapping = harness.streamChat("hi");
    overlapping.catch(() => undefined);
    await vi.waitFor(() => expect(concurrentChatCounts()).toHaveLength(2), {
      timeout: 10_000,
    });

    expect(concurrentChatCounts()).toEqual([1, 1]);
  }, 60_000);
});
