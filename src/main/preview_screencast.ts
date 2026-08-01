/**
 * Streams the hidden preview window into Dyad's panel.
 *
 * The panel draws these frames into an ordinary DOM element, which is what
 * keeps every Dyad overlay — error banner, tooltips, run bar, step rail —
 * compositing normally. A native view pinned over the panel would win the
 * z-order against all of them.
 */

export interface ScreencastFrameMetadata {
  /** Viewport size in CSS pixels — the space Input.dispatchMouseEvent uses. */
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

export interface ScreencastFrame {
  /** Base64 image data, without a data: prefix. */
  data: string;
  metadata: ScreencastFrameMetadata;
}

export interface DebuggerLike {
  isAttached(): boolean;
  attach(version?: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
  on(event: "message", listener: DebuggerMessageListener): void;
  off(event: "message", listener: DebuggerMessageListener): void;
}

type DebuggerMessageListener = (
  event: unknown,
  method: string,
  params: Record<string, unknown>,
) => void;

export interface ScreencastOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** JPEG while playing; callers switch to png when the run pauses. */
  format?: "jpeg" | "png";
  quality?: number;
  everyNthFrame?: number;
}

const DEFAULTS: Required<ScreencastOptions> = {
  maxWidth: 1280,
  maxHeight: 800,
  format: "jpeg",
  quality: 60,
  everyNthFrame: 2,
};

export class PreviewScreencast {
  private listener: DebuggerMessageListener | null = null;
  private running = false;

  constructor(
    private readonly target: DebuggerLike,
    private readonly onFrame: (frame: ScreencastFrame) => void,
  ) {}

  async start(options: ScreencastOptions = {}): Promise<void> {
    if (this.running) return;
    if (!this.target.isAttached()) this.target.attach("1.3");

    const listener: DebuggerMessageListener = (_event, method, params) => {
      if (method !== "Page.screencastFrame") return;
      const sessionId = params.sessionId;

      // Chromium sends exactly one more frame until this is acked. Ack first,
      // so a slow consumer cannot wedge the stream.
      if (sessionId !== undefined) {
        void this.target
          .sendCommand("Page.screencastFrameAck", { sessionId })
          .catch(() => undefined);
      }

      const data = params.data;
      const metadata = params.metadata as ScreencastFrameMetadata | undefined;
      if (typeof data === "string" && metadata) {
        this.onFrame({ data, metadata });
      }
    };

    this.target.on("message", listener);
    this.listener = listener;
    this.running = true;
    await this.target.sendCommand("Page.startScreencast", {
      ...DEFAULTS,
      ...options,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.listener) {
      this.target.off("message", this.listener);
      this.listener = null;
    }
    await this.target.sendCommand("Page.stopScreencast").catch(() => undefined);
  }

  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Maps a viewport coordinate (what CDP input events carry) onto the canvas the
 * frame is drawn into. The synthetic cursor needs this to sit on the element
 * the test is actually acting on.
 */
export function viewportToCanvas(
  point: { x: number; y: number },
  metadata: Pick<ScreencastFrameMetadata, "deviceWidth" | "deviceHeight">,
  canvas: { width: number; height: number },
): { x: number; y: number } {
  if (metadata.deviceWidth <= 0 || metadata.deviceHeight <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: (point.x / metadata.deviceWidth) * canvas.width,
    y: (point.y / metadata.deviceHeight) * canvas.height,
  };
}
