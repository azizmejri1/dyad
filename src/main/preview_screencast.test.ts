import { describe, expect, it, vi } from "vitest";
import {
  PreviewScreencast,
  viewportToCanvas,
  type ScreencastFrame,
} from "./preview_screencast";

function fakeDebugger(attached = false) {
  const listeners: any[] = [];
  const commands: Array<{ method: string; params?: object }> = [];
  let isAttached = attached;
  return {
    commands,
    target: {
      isAttached: () => isAttached,
      attach: () => {
        isAttached = true;
      },
      detach: () => {
        isAttached = false;
      },
      sendCommand: async (method: string, params?: object) => {
        commands.push({ method, params });
        return {};
      },
      on: (_e: string, listener: any) => listeners.push(listener),
      off: (_e: string, listener: any) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    emit(method: string, params: Record<string, unknown>) {
      for (const listener of [...listeners]) listener({}, method, params);
    },
    listenerCount: () => listeners.length,
  };
}

const metadata = {
  deviceWidth: 375,
  deviceHeight: 812,
  pageScaleFactor: 1,
  offsetTop: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};

describe("PreviewScreencast", () => {
  it("attaches and starts with jpeg defaults", async () => {
    const fake = fakeDebugger();
    const screencast = new PreviewScreencast(fake.target, () => {});

    await screencast.start();

    expect(fake.target.isAttached()).toBe(true);
    const start = fake.commands.find(
      (c) => c.method === "Page.startScreencast",
    );
    expect(start?.params).toMatchObject({ format: "jpeg", quality: 60 });
    expect(screencast.isRunning()).toBe(true);
  });

  it("lets callers override the format for a paused run", async () => {
    const fake = fakeDebugger();
    await new PreviewScreencast(fake.target, () => {}).start({
      format: "png",
      maxWidth: 375,
    });

    const start = fake.commands.find(
      (c) => c.method === "Page.startScreencast",
    );
    expect(start?.params).toMatchObject({ format: "png", maxWidth: 375 });
  });

  it("acks every frame, because Chromium sends only one more until it does", async () => {
    const fake = fakeDebugger();
    await new PreviewScreencast(fake.target, () => {}).start();

    fake.emit("Page.screencastFrame", { data: "AAA", metadata, sessionId: 1 });
    fake.emit("Page.screencastFrame", { data: "BBB", metadata, sessionId: 2 });

    const acks = fake.commands.filter(
      (c) => c.method === "Page.screencastFrameAck",
    );
    expect(acks.map((a) => a.params)).toEqual([
      { sessionId: 1 },
      { sessionId: 2 },
    ]);
  });

  it("acks before delivering, so a throwing consumer cannot wedge the stream", async () => {
    const fake = fakeDebugger();
    const screencast = new PreviewScreencast(fake.target, () => {
      throw new Error("render failed");
    });
    await screencast.start();

    expect(() =>
      fake.emit("Page.screencastFrame", { data: "A", metadata, sessionId: 1 }),
    ).toThrow();
    expect(
      fake.commands.some((c) => c.method === "Page.screencastFrameAck"),
    ).toBe(true);
  });

  it("delivers frame data with its metadata", async () => {
    const fake = fakeDebugger();
    const frames: ScreencastFrame[] = [];
    await new PreviewScreencast(fake.target, (f) => frames.push(f)).start();

    fake.emit("Page.screencastFrame", { data: "AAA", metadata, sessionId: 1 });

    expect(frames).toEqual([{ data: "AAA", metadata }]);
  });

  it("ignores unrelated debugger traffic", async () => {
    const fake = fakeDebugger();
    const onFrame = vi.fn();
    await new PreviewScreencast(fake.target, onFrame).start();

    fake.emit("Page.loadEventFired", {});
    fake.emit("Network.requestWillBeSent", { requestId: "1" });

    expect(onFrame).not.toHaveBeenCalled();
  });

  it("drops a malformed frame rather than emitting a partial one", async () => {
    const fake = fakeDebugger();
    const onFrame = vi.fn();
    await new PreviewScreencast(fake.target, onFrame).start();

    fake.emit("Page.screencastFrame", { data: "AAA", sessionId: 1 });
    fake.emit("Page.screencastFrame", { metadata, sessionId: 2 });

    expect(onFrame).not.toHaveBeenCalled();
  });

  it("stops cleanly and removes its listener", async () => {
    const fake = fakeDebugger();
    const onFrame = vi.fn();
    const screencast = new PreviewScreencast(fake.target, onFrame);
    await screencast.start();
    await screencast.stop();

    expect(fake.listenerCount()).toBe(0);
    expect(screencast.isRunning()).toBe(false);
    expect(fake.commands.some((c) => c.method === "Page.stopScreencast")).toBe(
      true,
    );

    fake.emit("Page.screencastFrame", { data: "A", metadata, sessionId: 9 });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("is idempotent on repeated start and stop", async () => {
    const fake = fakeDebugger();
    const screencast = new PreviewScreencast(fake.target, () => {});
    await screencast.start();
    await screencast.start();
    await screencast.stop();
    await screencast.stop();

    expect(
      fake.commands.filter((c) => c.method === "Page.startScreencast"),
    ).toHaveLength(1);
    expect(
      fake.commands.filter((c) => c.method === "Page.stopScreencast"),
    ).toHaveLength(1);
  });
});

describe("viewportToCanvas", () => {
  it("scales a viewport point into canvas space", () => {
    expect(
      viewportToCanvas({ x: 187.5, y: 406 }, metadata, {
        width: 750,
        height: 1624,
      }),
    ).toEqual({ x: 375, y: 812 });
  });

  it("is identity when the canvas matches the viewport", () => {
    expect(
      viewportToCanvas({ x: 10, y: 20 }, metadata, { width: 375, height: 812 }),
    ).toEqual({ x: 10, y: 20 });
  });

  it("returns the origin rather than NaN for a zero-sized frame", () => {
    const empty = { ...metadata, deviceWidth: 0, deviceHeight: 0 };
    expect(
      viewportToCanvas({ x: 10, y: 20 }, empty, { width: 375, height: 812 }),
    ).toEqual({ x: 0, y: 0 });
  });
});
