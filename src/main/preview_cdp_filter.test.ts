import { describe, expect, it } from "vitest";
import { PreviewCdpFilter } from "./preview_cdp_filter";

const PREVIEW = "preview-target-id";
const DYAD_RENDERER = "dyad-renderer-target-id";

/** Walk the filter through the attach handshake so a session is authorized. */
function attached(filter: PreviewCdpFilter, sessionId = "session-1") {
  filter.fromBrowser({
    method: "Target.attachedToTarget",
    params: { sessionId, targetInfo: { targetId: PREVIEW, type: "page" } },
  });
  return sessionId;
}

describe("PreviewCdpFilter", () => {
  describe("browser -> client", () => {
    it("forwards target events for the preview", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      expect(
        filter.fromBrowser({
          method: "Target.targetCreated",
          params: { targetInfo: { targetId: PREVIEW, type: "page" } },
        }),
      ).toEqual({ action: "forward" });
    });

    it("drops target events for every other target", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      for (const method of [
        "Target.targetCreated",
        "Target.targetInfoChanged",
        "Target.attachedToTarget",
      ]) {
        expect(
          filter.fromBrowser({
            method,
            params: { targetInfo: { targetId: DYAD_RENDERER, type: "page" } },
          }),
        ).toEqual({ action: "drop" });
      }
    });

    it("drops a targetInfo-less target event rather than defaulting open", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      expect(
        filter.fromBrowser({ method: "Target.attachedToTarget", params: {} }),
      ).toEqual({ action: "drop" });
    });

    it("forwards command results untouched", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      expect(filter.fromBrowser({ id: 7, result: {} })).toEqual({
        action: "forward",
      });
    });

    it("only forwards a detach for a session it handed out", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      expect(
        filter.fromBrowser({
          method: "Target.detachedFromTarget",
          params: { sessionId: "never-seen" },
        }),
      ).toEqual({ action: "drop" });

      const sessionId = attached(filter);
      expect(
        filter.fromBrowser({
          method: "Target.detachedFromTarget",
          params: { sessionId },
        }),
      ).toEqual({ action: "forward" });
      // ...and the session stops being authorized afterwards.
      expect(filter.isAuthorizedSession(sessionId)).toBe(false);
    });
  });

  describe("client -> browser", () => {
    it("forwards browser-level commands", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      expect(
        filter.fromClient({ id: 1, method: "Browser.getVersion" }),
      ).toEqual({ action: "forward" });
      expect(
        filter.fromClient({ id: 2, method: "Target.setDiscoverTargets" }),
      ).toEqual({ action: "forward" });
    });

    it("rejects attaching to any target but the preview", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      const verdict = filter.fromClient({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId: DYAD_RENDERER },
      });
      expect(verdict.action).toBe("reject");
    });

    it("allows attaching to the preview", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      expect(
        filter.fromClient({
          id: 1,
          method: "Target.attachToTarget",
          params: { targetId: PREVIEW },
        }),
      ).toEqual({ action: "forward" });
    });

    it("rejects target and browser escapes outright", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      for (const method of [
        "Target.createTarget",
        "Target.createBrowserContext",
        "Target.exposeDevToolsProtocol",
      ]) {
        expect(filter.fromClient({ id: 1, method }).action).toBe("reject");
      }
    });

    it("rejects a command riding an unknown session", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      const verdict = filter.fromClient({
        id: 1,
        method: "Runtime.evaluate",
        sessionId: "guessed-session",
      });
      expect(verdict.action).toBe("reject");
    });

    it("accepts a command on a session learned from a forwarded attach", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      const sessionId = attached(filter);
      expect(
        filter.fromClient({ id: 1, method: "Runtime.evaluate", sessionId }),
      ).toEqual({ action: "forward" });
    });

    it("does not authorize a session from a dropped attach", () => {
      const filter = new PreviewCdpFilter(PREVIEW);
      filter.fromBrowser({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "renderer-session",
          targetInfo: { targetId: DYAD_RENDERER, type: "page" },
        },
      });
      expect(
        filter.fromClient({
          id: 1,
          method: "Runtime.evaluate",
          sessionId: "renderer-session",
        }).action,
      ).toBe("reject");
    });
  });

  it("narrows Target.getTargets to the preview", () => {
    const filter = new PreviewCdpFilter(PREVIEW);
    const filtered = filter.filterGetTargetsResult({
      id: 1,
      result: {
        targetInfos: [
          { targetId: DYAD_RENDERER, type: "page" },
          { targetId: PREVIEW, type: "page" },
          { targetId: "some-worker", type: "service_worker" },
        ],
      },
    });
    expect(filtered.result?.targetInfos).toEqual([
      { targetId: PREVIEW, type: "page" },
    ]);
  });

  it("leaves a result with no targetInfos alone", () => {
    const filter = new PreviewCdpFilter(PREVIEW);
    const frame = { id: 1, result: { value: 3 } };
    expect(filter.filterGetTargetsResult(frame)).toEqual(frame);
  });
});
