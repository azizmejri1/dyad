// Node fetch for SQL-over-HTTP and Neon Auth during live runs, with the
// campaign's SQL concurrency cap, Auth rate limit, fault rules and metrics.
//
// The hybrid harness installs undici fetch for its lifetime; install this
// after harness setup and uninstall before its disposal.
import { neonConfig } from "@neondatabase/serverless";
import { fetch as undiciFetch, Response as UndiciResponse } from "undici";
import WebSocket from "ws";
import type { Semaphore, TokenBucket } from "./budget";
import {
  injectedFetchFailure,
  type FaultController,
  type FaultTransport,
} from "./faults";
import type { MetricsRecorder } from "./metrics";

export interface LiveFetchOptions {
  sqlLimiter: Semaphore;
  authBucket: TokenBucket;
  metrics?: MetricsRecorder;
  faults?: FaultController;
}

type FetchFn = typeof globalThis.fetch;

/** SQL over HTTP goes to the compute host's /sql endpoint. */
export function classifyNeonUrl(url: URL): FaultTransport | undefined {
  // The Management API goes through the SDK (axios), never through here.
  if (url.hostname === "console.neon.tech") return undefined;
  if (url.hostname.includes("neonauth") || /\/auth(\/|$)/.test(url.pathname)) {
    if (
      url.hostname.endsWith(".neon.tech") ||
      url.hostname.endsWith(".neon.build")
    ) {
      return "auth";
    }
  }
  if (url.pathname === "/sql" && /\.neon\.(tech|build)$/.test(url.hostname))
    return "sql";
  return undefined;
}

export function createLiveFetch(
  options: LiveFetchOptions,
  base: FetchFn,
): FetchFn {
  const { sqlLimiter, authBucket, metrics, faults } = options;
  const liveFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url,
    );
    const transport = classifyNeonUrl(url);
    if (!transport) return base(input, init);
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input
        ? String(input.method)
        : "GET")
    ).toUpperCase();
    const op =
      transport === "sql"
        ? "POST /sql"
        : `${method} ${url.pathname.replace(/^.*\/auth/, "/auth")}`;
    const run = async () => {
      const start = Date.now();
      const record = (
        status: number | undefined,
        ok: boolean,
        extra: Partial<{ injected: string; networkError: string }> = {},
      ) =>
        metrics?.request({
          transport,
          op,
          status,
          ok,
          ms: Date.now() - start,
          ...extra,
        });
      const fault = faults?.match(transport, method, url.pathname);
      let loseResponse = false;
      if (fault) {
        switch (fault.action.kind) {
          case "status":
            record(fault.action.status, false, { injected: "status" });
            return new UndiciResponse(
              JSON.stringify({
                message: `Injected ${fault.action.status} (live Neon fault campaign)`,
              }),
              {
                status: fault.action.status,
                headers: {
                  "content-type": "application/json",
                  ...(fault.action.retryAfterSeconds !== undefined
                    ? { "retry-after": String(fault.action.retryAfterSeconds) }
                    : {}),
                },
              },
            );
          case "reset-before-send":
            record(undefined, false, {
              injected: "reset-before-send",
              networkError: "ECONNRESET",
            });
            throw injectedFetchFailure(true);
          case "delay": {
            const { ms } = fault.action;
            await new Promise((resolve) => setTimeout(resolve, ms));
            break;
          }
          case "gate":
            await fault.wait();
            break;
          case "lose-response":
            loseResponse = true;
            break;
          case "crash":
            process.kill(process.pid, "SIGKILL");
        }
      }
      try {
        const response = await base(input, init);
        if (loseResponse) {
          // Drain so the connection is reusable, then report it as lost.
          await response.arrayBuffer().catch(() => {});
          record(response.status, false, {
            injected: "lose-response",
            networkError: "ECONNRESET",
          });
          throw injectedFetchFailure(false);
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after"));
          if (transport === "auth")
            authBucket.onThrottle(
              Number.isFinite(retryAfter) ? retryAfter : undefined,
            );
        } else if (transport === "auth" && response.ok) {
          authBucket.onSuccess();
        }
        record(
          response.status,
          response.ok,
          fault ? { injected: fault.action.kind } : {},
        );
        return response;
      } catch (error) {
        if ((error as { isInjectedFault?: boolean }).isInjectedFault)
          throw error;
        record(undefined, false, {
          networkError: String(
            (error as { cause?: { code?: string } }).cause?.code ?? "network",
          ),
        });
        throw error;
      }
    };
    if (transport === "auth") {
      await authBucket.take();
      return run();
    }
    return sqlLimiter.run(run);
  };
  return liveFetch as FetchFn;
}

/**
 * Routes the serverless driver and global fetch through the live wrapper.
 * Returns an uninstaller that restores both.
 */
export function installLiveFetch(options: LiveFetchOptions): () => void {
  const previousGlobal = globalThis.fetch;
  const previousDriverFetch = neonConfig.fetchFunction;
  const previousWebSocket = neonConfig.webSocketConstructor;
  const wrapped = createLiveFetch(options, undiciFetch as unknown as FetchFn);
  globalThis.fetch = wrapped;
  neonConfig.fetchFunction = wrapped;
  // Pool/Client (used to replay backups) need a WebSocket in Node. No fault
  // hooks on this path.
  neonConfig.webSocketConstructor = WebSocket;
  return () => {
    globalThis.fetch = previousGlobal;
    neonConfig.fetchFunction = previousDriverFetch;
    neonConfig.webSocketConstructor = previousWebSocket;
  };
}
