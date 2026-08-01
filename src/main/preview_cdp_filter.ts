/**
 * Decides, frame by frame, what may cross between a user's Playwright process
 * and Dyad's Chromium debugging port.
 *
 * The debugging port is browser-wide: it exposes Dyad's own renderer, which has
 * a privileged preload, alongside the preview page. Playwright connects at the
 * browser level (it needs `Browser.*` and target discovery), so the connection
 * cannot simply be scoped to one page. This filter is what makes it safe: the
 * user's tests learn about exactly one target and can attach to exactly one
 * target.
 *
 * Pure and stateless apart from the set of sessions it has authorized, so the
 * rules can be tested without a browser.
 */

export type FilterVerdict =
  | { action: "forward" }
  /** Swallow silently. Only ever applied to events, never to a command. */
  | { action: "drop" }
  /** Answer the command ourselves with a CDP error. */
  | { action: "reject"; message: string };

const FORWARD: FilterVerdict = { action: "forward" };
const DROP: FilterVerdict = { action: "drop" };

/** Commands that would reach outside the preview target, whatever the params. */
const FORBIDDEN_METHODS = new Set([
  "Target.createTarget",
  "Target.createBrowserContext",
  "Target.exposeDevToolsProtocol",
  "Browser.setDownloadBehavior",
  "Browser.grantPermissions",
]);

/** Events that carry a `targetInfo` we must vet before the client sees it. */
const TARGET_INFO_EVENTS = new Set([
  "Target.targetCreated",
  "Target.targetInfoChanged",
  "Target.attachedToTarget",
]);

interface CdpFrame {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export class PreviewCdpFilter {
  /** Sessions the client legitimately owns, learned from forwarded attaches. */
  private readonly authorizedSessions = new Set<string>();

  constructor(private readonly allowedTargetId: string) {}

  /** A frame travelling client -> browser. */
  fromClient(frame: CdpFrame): FilterVerdict {
    const { method, sessionId, params } = frame;
    if (!method) return FORWARD;

    // A session we never handed out is either a guess or a leak; refuse it
    // before the params are even considered.
    if (sessionId !== undefined && !this.authorizedSessions.has(sessionId)) {
      return { action: "reject", message: `Unknown session: ${sessionId}` };
    }

    if (FORBIDDEN_METHODS.has(method)) {
      return {
        action: "reject",
        message: `${method} is not permitted by Dyad`,
      };
    }

    if (method === "Target.attachToTarget" || method === "Target.closeTarget") {
      const targetId = params?.targetId;
      if (targetId !== this.allowedTargetId) {
        return {
          action: "reject",
          message: `${method} is limited to the Dyad preview target`,
        };
      }
    }

    return FORWARD;
  }

  /** A frame travelling browser -> client. */
  fromBrowser(frame: CdpFrame): FilterVerdict {
    const { method, params } = frame;

    // Command results are addressed to a request we already vetted.
    if (!method) return FORWARD;

    if (TARGET_INFO_EVENTS.has(method)) {
      const targetInfo = params?.targetInfo as
        | { targetId?: string }
        | undefined;
      if (targetInfo?.targetId !== this.allowedTargetId) return DROP;

      // Remember the session so later frames carrying it are recognised.
      if (method === "Target.attachedToTarget") {
        const sessionId = params?.sessionId;
        if (typeof sessionId === "string") {
          this.authorizedSessions.add(sessionId);
        }
      }
      return FORWARD;
    }

    if (method === "Target.targetDestroyed") {
      return params?.targetId === this.allowedTargetId ? FORWARD : DROP;
    }

    if (method === "Target.detachedFromTarget") {
      const sessionId = params?.sessionId;
      if (typeof sessionId !== "string") return DROP;
      if (!this.authorizedSessions.has(sessionId)) return DROP;
      this.authorizedSessions.delete(sessionId);
      return FORWARD;
    }

    return FORWARD;
  }

  /**
   * `Target.getTargets` answers with the whole browser. Narrow the list to the
   * preview before the client sees it.
   */
  filterGetTargetsResult(frame: CdpFrame): CdpFrame {
    const infos = frame.result?.targetInfos;
    if (!Array.isArray(infos)) return frame;
    return {
      ...frame,
      result: {
        ...frame.result,
        targetInfos: infos.filter(
          (info: { targetId?: string }) =>
            info?.targetId === this.allowedTargetId,
        ),
      },
    };
  }

  isAuthorizedSession(sessionId: string): boolean {
    return this.authorizedSessions.has(sessionId);
  }
}
