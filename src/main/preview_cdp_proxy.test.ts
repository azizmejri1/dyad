import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  HOLD_CEILING_MS,
  PreviewCdpProxy,
  mintCdpToken,
  tokenFromPath,
} from "./preview_cdp_proxy";

const PREVIEW = "preview-target";
const RENDERER = "dyad-renderer-target";

/** A stand-in for Chromium's debugging port that records what reaches it. */
function fakeBrowser() {
  const received: any[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let socket: WebSocket | null = null;
  const ready = new Promise<void>((resolve) => {
    server.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (data) => received.push(JSON.parse(data.toString())));
      resolve();
    });
  });
  const listening = new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  return {
    received,
    ready,
    async endpoint() {
      await listening;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return `ws://127.0.0.1:${port}`;
    },
    emit(frame: unknown) {
      socket?.send(JSON.stringify(frame));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of server.clients) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

function connect(endpoint: string) {
  const frames: any[] = [];
  const ws = new WebSocket(endpoint);
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const open = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, frames, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("tokenFromPath", () => {
  it("accepts a 64-hex-char path and ignores a query string", () => {
    const token = mintCdpToken();
    expect(tokenFromPath(`/${token}`)).toBe(token);
    expect(tokenFromPath(`/${token}?x=1`)).toBe(token);
  });

  it("rejects anything else", () => {
    expect(tokenFromPath(undefined)).toBeNull();
    expect(tokenFromPath("/")).toBeNull();
    expect(tokenFromPath("/short")).toBeNull();
    expect(tokenFromPath(`/${"z".repeat(64)}`)).toBeNull();
    // No traversal past the single path segment.
    expect(tokenFromPath(`/${mintCdpToken()}/../devtools`)).toBeNull();
  });
});

describe("PreviewCdpProxy", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function harness(
    options: { onInputEvent?: (e: any) => void | Promise<void> } = {},
  ) {
    const browser = fakeBrowser();
    const proxy = new PreviewCdpProxy({
      browserWsEndpoint: await browser.endpoint(),
      allowedTargetId: PREVIEW,
      ...options,
    });
    const endpoint = await proxy.start();
    cleanups.push(() => proxy.stop());
    cleanups.push(() => browser.close());
    return { browser, proxy, endpoint };
  }

  it("refuses a connection carrying the wrong token", async () => {
    const { endpoint } = await harness();
    const wrong = endpoint.replace(/\/[a-f0-9]{64}$/, `/${mintCdpToken()}`);
    const client = connect(wrong);

    const closeCode = await new Promise<number>((resolve) => {
      client.ws.once("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1008);
  });

  it("passes a browser-level command through to Chromium", async () => {
    const { browser, endpoint } = await harness();
    const client = connect(endpoint);
    await client.open;

    client.ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await browser.ready;
    await settle();

    expect(browser.received).toEqual([{ id: 1, method: "Browser.getVersion" }]);
  });

  it("answers a forbidden command itself and never forwards it", async () => {
    const { browser, endpoint } = await harness();
    const client = connect(endpoint);
    await client.open;

    client.ws.send(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: RENDERER },
      }),
    );
    await settle();

    expect(browser.received).toEqual([]);
    expect(client.frames).toHaveLength(1);
    expect(client.frames[0].id).toBe(4);
    expect(client.frames[0].error.message).toContain("Dyad preview target");
  });

  it("hides other targets from the client", async () => {
    const { browser, endpoint } = await harness();
    const client = connect(endpoint);
    await client.open;
    client.ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await browser.ready;

    browser.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "renderer-session",
        targetInfo: { targetId: RENDERER, type: "page" },
      },
    });
    browser.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "preview-session",
        targetInfo: { targetId: PREVIEW, type: "page" },
      },
    });
    await settle();

    const attaches = client.frames.filter(
      (f) => f.method === "Target.attachedToTarget",
    );
    expect(attaches).toHaveLength(1);
    expect(attaches[0].params.targetInfo.targetId).toBe(PREVIEW);
  });

  it("narrows Target.getTargets over the wire", async () => {
    const { browser, endpoint } = await harness();
    const client = connect(endpoint);
    await client.open;

    client.ws.send(JSON.stringify({ id: 9, method: "Target.getTargets" }));
    await browser.ready;
    await settle();
    browser.emit({
      id: 9,
      result: {
        targetInfos: [
          { targetId: RENDERER, type: "page" },
          { targetId: PREVIEW, type: "page" },
        ],
      },
    });
    await settle();

    expect(client.frames[0].result.targetInfos).toEqual([
      { targetId: PREVIEW, type: "page" },
    ]);
  });

  it("observes mouse input on its way through", async () => {
    const seen: any[] = [];
    const { browser, endpoint } = await harness({
      onInputEvent: (event) => {
        seen.push(event);
      },
    });
    const client = connect(endpoint);
    await client.open;

    client.ws.send(
      JSON.stringify({
        id: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 412, y: 268, clickCount: 1 },
      }),
    );
    await browser.ready;
    await settle();

    expect(seen).toEqual([
      { type: "mousePressed", x: 412, y: 268, clickCount: 1 },
    ]);
    expect(browser.received).toHaveLength(1);
  });

  it("forwards the click even when the observer never resolves", async () => {
    // The hold is what makes the cursor arrive before the click. An observer
    // that hangs must not strand the run: the ceiling releases the frame.
    const { browser, endpoint } = await harness({
      onInputEvent: () => new Promise<void>(() => {}),
    });
    const client = connect(endpoint);
    await client.open;

    const started = Date.now();
    client.ws.send(
      JSON.stringify({
        id: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 1, y: 2 },
      }),
    );
    await browser.ready;
    await new Promise((resolve) => setTimeout(resolve, HOLD_CEILING_MS + 150));

    expect(browser.received).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_CEILING_MS);
  });
});
