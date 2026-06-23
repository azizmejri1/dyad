import net from "node:net";
import { randomBytes } from "node:crypto";
import log from "electron-log/main";
import type { WebContents } from "electron";
import { safeSend } from "./safe_sender";

const logger = log.scope("test_stream_server");

/**
 * Relays live screencast frames from a running Playwright test process into the
 * renderer. The test process (via tests/dyad-fixtures.ts) connects over a
 * loopback TCP socket and streams newline-delimited JSON messages:
 *
 *   {"type":"hello","token":"<run token>"}
 *   {"type":"frame","data":"<base64 jpeg>"}   (repeated)
 *
 * We authenticate the first message against a per-run token (the server binds
 * to 127.0.0.1 only, but the token stops any other local process from injecting
 * frames), then forward each frame to the renderer that started the run as a
 * `tests:frame` event.
 */

interface Registration {
  appId: number;
  sender: WebContents;
}

let server: net.Server | null = null;
let serverPort = 0;
const registrations = new Map<string, Registration>();

// A JSON line bigger than this is treated as malformed and drops the
// connection — a single 1280x720 JPEG frame is well under this.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface TestStreamHandle {
  port: number;
  token: string;
}

/**
 * Ensures the relay server is running and registers a run, returning the port
 * and token to hand to the test process. Best-effort: callers should tolerate
 * this throwing (streaming is a nice-to-have, never required for a run).
 */
export async function startTestStream(
  appId: number,
  sender: WebContents,
): Promise<TestStreamHandle> {
  await ensureServer();
  const token = randomBytes(16).toString("hex");
  registrations.set(token, { appId, sender });
  return { port: serverPort, token };
}

/** Unregisters a run so its token can no longer be used. */
export function stopTestStream(token: string): void {
  registrations.delete(token);
}

function ensureServer(): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const srv = net.createServer(handleConnection);
    srv.once("error", (err) => {
      logger.error(`Test stream server failed to start: ${err}`);
      reject(err);
    });
    // Loopback only, ephemeral port.
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      server = srv;
      logger.info(`Test stream server listening on 127.0.0.1:${serverPort}`);
      resolve();
    });
  });
}

function handleConnection(socket: net.Socket): void {
  socket.setNoDelay(true);
  let reg: Registration | null = null;
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_BUFFER_BYTES) {
      socket.destroy();
      return;
    }
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let msg: { type?: string; token?: string; data?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (!reg) {
        // The first valid message must authenticate with a registered token.
        if (msg.type === "hello" && typeof msg.token === "string") {
          const found = registrations.get(msg.token);
          if (!found) {
            socket.destroy();
            return;
          }
          reg = found;
        }
        continue;
      }

      if (msg.type === "frame" && typeof msg.data === "string") {
        safeSend(reg.sender, "tests:frame", {
          appId: reg.appId,
          dataUrl: `data:image/jpeg;base64,${msg.data}`,
        });
      }
    }
  });

  // Sockets close abruptly on test teardown — never surface that as an error.
  socket.on("error", () => {});
}
