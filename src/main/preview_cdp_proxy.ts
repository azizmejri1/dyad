import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { PreviewCdpFilter } from "./preview_cdp_filter";

/**
 * A loopback WebSocket endpoint that a user's Playwright process connects to
 * with `chromium.connectOverCDP`. Everything crossing it is vetted by
 * PreviewCdpFilter, so the tests see one page target and never Dyad's own
 * renderer.
 *
 * The proxy is also the only component that sees the raw input stream, which is
 * what lets the synthetic cursor be driven by real coordinates rather than
 * inferred ones. `onInputEvent` observes; its returned promise is awaited before
 * the frame is forwarded, which is how a click can be held back until the drawn
 * cursor has arrived.
 */

export interface CdpInputEvent {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  clickCount?: number;
}

export interface PreviewCdpProxyOptions {
  /** The `ws://` endpoint Chromium's --remote-debugging-port advertises. */
  browserWsEndpoint: string;
  /** The only target the connected client may discover or attach to. */
  allowedTargetId: string;
  /**
   * Observes `Input.dispatchMouseEvent` on its way to the browser. Awaited
   * before the frame is forwarded, so a slow observer paces the run. Must be
   * bounded by the caller — see HOLD_CEILING_MS.
   */
  onInputEvent?: (event: CdpInputEvent) => void | Promise<void>;
}

/**
 * Ceiling on how long an input observer may delay a frame. A run that watches
 * itself is allowed to be slower; it is not allowed to turn a passing test into
 * a timeout, so the hold can never grow without bound.
 */
export const HOLD_CEILING_MS = 400;

export function mintCdpToken(): string {
  return randomBytes(32).toString("hex");
}

/** Extracts the token from a `/<token>` request path. */
export function tokenFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const match = /^\/([a-f0-9]{64})$/.exec(path.split("?")[0]);
  return match ? match[1] : null;
}

function withCeiling(promise: void | Promise<void>): Promise<void> {
  if (!promise) return Promise.resolve();
  return Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, HOLD_CEILING_MS)),
  ]);
}

export class PreviewCdpProxy {
  private server: WebSocketServer | null = null;
  private readonly token = mintCdpToken();

  constructor(private readonly options: PreviewCdpProxyOptions) {}

  /** Starts listening and returns the endpoint to hand to the test process. */
  async start(): Promise<string> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server = server;

    server.on("connection", (client, request) => {
      if (tokenFromPath(request.url) !== this.token) {
        client.close(1008, "Unauthorized");
        return;
      }
      this.bridge(client);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `ws://127.0.0.1:${port}/${this.token}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // close() alone waits for every client to disconnect, which a test process
    // that has already gone away will never do.
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private bridge(client: WebSocket): void {
    const filter = new PreviewCdpFilter(this.options.allowedTargetId);
    const upstream = new WebSocket(this.options.browserWsEndpoint);
    /** Ids of in-flight Target.getTargets calls, whose results need narrowing. */
    const pendingGetTargets = new Set<number>();
    const queued: string[] = [];

    const sendToClient = (frame: unknown) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(frame));
      }
    };

    const sendUpstream = (raw: string) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
      else queued.push(raw);
    };

    upstream.on("open", () => {
      for (const raw of queued.splice(0)) upstream.send(raw);
    });

    client.on("message", async (data) => {
      const raw = data.toString();
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }

      const verdict = filter.fromClient(frame);
      if (verdict.action === "reject") {
        sendToClient({
          id: frame.id,
          error: { code: -32000, message: verdict.message },
        });
        return;
      }
      if (verdict.action === "drop") return;

      if (
        frame.method === "Target.getTargets" &&
        typeof frame.id === "number"
      ) {
        pendingGetTargets.add(frame.id);
      }

      if (
        frame.method === "Input.dispatchMouseEvent" &&
        this.options.onInputEvent
      ) {
        await withCeiling(this.options.onInputEvent(frame.params ?? {}));
      }

      sendUpstream(raw);
    });

    upstream.on("message", (data) => {
      const raw = data.toString();
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }

      const verdict = filter.fromBrowser(frame);
      if (verdict.action !== "forward") return;

      if (typeof frame.id === "number" && pendingGetTargets.delete(frame.id)) {
        sendToClient(filter.filterGetTargetsResult(frame));
        return;
      }
      sendToClient(frame);
    });

    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
  }
}
