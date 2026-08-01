import { describe, expect, it, vi } from "vitest";
import { createIframeTransport } from "./transport";

function iframeWith(contentWindow: unknown) {
  return { contentWindow } as unknown as HTMLIFrameElement;
}

describe("createIframeTransport", () => {
  it("posts to the current contentWindow with a wildcard origin", () => {
    const postMessage = vi.fn();
    const transport = createIframeTransport(() => iframeWith({ postMessage }));

    transport.post({ type: "clear-dyad-component-overlays" });

    expect(postMessage).toHaveBeenCalledWith(
      { type: "clear-dyad-component-overlays" },
      "*",
    );
  });

  it("resolves the iframe lazily so it survives a remount", () => {
    const first = vi.fn();
    const second = vi.fn();
    let current = iframeWith({ postMessage: first });
    const transport = createIframeTransport(() => current);

    transport.post({ type: "a" });
    current = iframeWith({ postMessage: second });
    transport.post({ type: "b" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ type: "b" }, "*");
  });

  it("is a no-op rather than a throw when the surface is gone", () => {
    const detached = createIframeTransport(() => null);
    const unloaded = createIframeTransport(() => iframeWith(null));

    expect(() => detached.post({ type: "a" })).not.toThrow();
    expect(() => unloaded.post({ type: "a" })).not.toThrow();
    expect(detached.isReady()).toBe(false);
    expect(unloaded.isReady()).toBe(false);
  });

  it("attributes inbound messages to the current contentWindow", () => {
    const contentWindow = { postMessage: vi.fn() };
    const transport = createIframeTransport(() => iframeWith(contentWindow));

    expect(
      transport.matchesSource(contentWindow as unknown as MessageEventSource),
    ).toBe(true);
    expect(transport.matchesSource({} as unknown as MessageEventSource)).toBe(
      false,
    );
    expect(transport.matchesSource(null)).toBe(false);
  });

  it("never matches a null source against a detached surface", () => {
    // Guards the `event.source !== contentWindow` idiom this replaced: with no
    // iframe, both sides were undefined and every inbound message matched.
    const transport = createIframeTransport(() => iframeWith(null));
    expect(transport.matchesSource(null)).toBe(false);
  });
});
