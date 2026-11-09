// Transport-level fault injection for live runs. Successful calls still reach
// real Neon; matched requests get a deliberate failure, delay, barrier, or a
// lost response after the server already committed. Results produced under a
// rule must be labeled "live Neon with injected transport faults".
//
// Coverage is per transport: the Management API (SDK axios adapter), SQL over
// HTTP (serverless driver fetch) and Auth (fetch). WebSocket SQL (Pool) and
// TCP Postgres (pg, used by schema diffing) have no fault hooks here.
//
// Relative imports only: the supervisor CLI loads this through jiti.

export type FaultTransport = "management" | "sql" | "auth";

export type FaultAction =
  /** Fails before sending: Neon never sees the request. */
  | {
      kind: "status";
      status: number;
      retryAfterSeconds?: number;
      message?: string;
    }
  /** Connection reset before sending. */
  | { kind: "reset-before-send" }
  /** Holds the request, then sends it. */
  | { kind: "delay"; ms: number }
  /** Sends for real, then drops the response: the mutation may have committed. */
  | { kind: "lose-response" }
  /** Holds the request until the test releases the rule (named barrier). */
  | { kind: "gate" }
  /** SIGKILLs this process at the matched request (crash probes only). */
  | { kind: "crash" };

export interface FaultRule {
  id: string;
  transport: FaultTransport;
  method?: string;
  /** Matched against the endpoint path (Management: without /api/v2). */
  path?: RegExp;
  /** Let this many matching requests through first (e.g. "the 2nd branch create"). */
  skip?: number;
  /** Matching requests affected after `skip` (default 1). */
  times?: number;
  action: FaultAction;
}

export interface FaultHit {
  ruleId: string;
  transport: FaultTransport;
  method: string;
  path: string;
  action: FaultAction["kind"];
  at: string;
}

export interface FaultHandle {
  /** Resolves the first time a request reaches this rule. */
  reached: Promise<void>;
  /** Releases every request held at a gate (and future ones). */
  release: () => void;
  hits: () => number;
}

interface ActiveRule {
  rule: FaultRule;
  seen: number;
  applied: number;
  released: boolean;
  releaseWaiters: Array<() => void>;
  markReached: () => void;
}

export class FaultController {
  private rules: ActiveRule[] = [];
  readonly hits: FaultHit[] = [];

  add(rule: FaultRule): FaultHandle {
    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const active: ActiveRule = {
      rule,
      seen: 0,
      applied: 0,
      released: false,
      releaseWaiters: [],
      markReached,
    };
    this.rules.push(active);
    return {
      reached,
      release: () => {
        active.released = true;
        for (const wake of active.releaseWaiters.splice(0)) wake();
      },
      hits: () => active.applied,
    };
  }

  /** Removes all rules, releasing anything held at a gate. */
  clear(): void {
    for (const active of this.rules) {
      active.released = true;
      for (const wake of active.releaseWaiters.splice(0)) wake();
    }
    this.rules = [];
  }

  get injectedCount(): number {
    return this.hits.length;
  }

  /**
   * Finds the rule that applies to this request, consuming its counters, and
   * returns what to do. At most one rule applies per request.
   */
  match(
    transport: FaultTransport,
    method: string,
    path: string,
  ): { action: FaultAction; wait: () => Promise<void> } | undefined {
    for (const active of this.rules) {
      const { rule } = active;
      if (rule.transport !== transport) continue;
      if (rule.method && rule.method.toUpperCase() !== method.toUpperCase())
        continue;
      if (rule.path && !rule.path.test(path)) continue;
      active.seen += 1;
      if (active.seen <= (rule.skip ?? 0)) continue;
      if (active.applied >= (rule.times ?? 1)) continue;
      active.applied += 1;
      this.hits.push({
        ruleId: rule.id,
        transport,
        method,
        path,
        action: rule.action.kind,
        at: new Date().toISOString(),
      });
      active.markReached();
      return {
        action: rule.action,
        wait: () =>
          active.released
            ? Promise.resolve()
            : new Promise<void>((resolve) =>
                active.releaseWaiters.push(resolve),
              ),
      };
    }
    return undefined;
  }
}

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  423: "Locked",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export interface InjectedError extends Error {
  isInjectedFault: true;
  /** The request never reached Neon, so a create cannot have happened. */
  notSent: boolean;
  isAxiosError?: boolean;
  code?: string;
  response?: {
    status: number;
    statusText: string;
    data: { code: string; message: string };
    headers: Record<string, string>;
  };
}

/** An HTTP error shaped like the SDK's AxiosError, as Dyad code inspects it. */
export function injectedHttpError(
  status: number,
  {
    retryAfterSeconds,
    message,
  }: { retryAfterSeconds?: number; message?: string } = {},
): InjectedError {
  const error = new Error(
    `Request failed with status code ${status}`,
  ) as InjectedError;
  error.name = "AxiosError";
  error.isAxiosError = true;
  error.isInjectedFault = true;
  error.notSent = true;
  error.code = status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
  error.response = {
    status,
    statusText: STATUS_TEXT[status] ?? "Injected",
    data: {
      code:
        status === 423
          ? "LOCKED"
          : status === 429
            ? "RATE_LIMITED"
            : "INJECTED",
      message: message ?? `Injected ${status} (live Neon fault campaign)`,
    },
    headers:
      retryAfterSeconds !== undefined
        ? { "retry-after": String(retryAfterSeconds) }
        : {},
  };
  return error;
}

export function injectedNetworkError(
  code: "ECONNRESET" | "ETIMEDOUT",
  { notSent }: { notSent: boolean },
): InjectedError {
  const error = new Error(
    notSent
      ? `Injected ${code} before send`
      : `Injected ${code}: response lost after send`,
  ) as InjectedError;
  error.name = "AxiosError";
  error.isAxiosError = true;
  error.isInjectedFault = true;
  error.notSent = notSent;
  error.code = code;
  return error;
}

/** Fetch-style network failure, as undici reports it. */
export function injectedFetchFailure(notSent: boolean): TypeError & {
  isInjectedFault: true;
  notSent: boolean;
} {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(
      new Error(notSent ? "injected reset" : "injected lost response"),
      {
        code: "ECONNRESET",
      },
    ),
  }) as TypeError & { isInjectedFault: true; notSent: boolean };
  error.isInjectedFault = true;
  error.notSent = notSent;
  return error;
}

export function crashNow(): never {
  process.kill(process.pid, "SIGKILL");
  // SIGKILL is not deliverable synchronously on every platform.
  throw new Error("crash probe: SIGKILL did not terminate the process");
}
