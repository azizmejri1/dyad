/**
 * The preview surface as its consumers actually use it: something you can post
 * a message to, and something you can attribute an inbound message to.
 *
 * Today the only implementation is iframe-backed. When the preview gains a real
 * WebContents the surface stops being a `contentWindow`, and inbound messages
 * stop arriving as `window` message events — consumers that hold this interface
 * instead of an `HTMLIFrameElement` do not have to care.
 */
export interface PreviewTransport {
  post(message: unknown): void;
  isReady(): boolean;
  matchesSource(source: MessageEventSource | null): boolean;
}

export function createIframeTransport(
  getIframe: () => HTMLIFrameElement | null,
): PreviewTransport {
  return {
    post(message) {
      getIframe()?.contentWindow?.postMessage(message, "*");
    },
    isReady() {
      return Boolean(getIframe()?.contentWindow);
    },
    matchesSource(source) {
      const contentWindow = getIframe()?.contentWindow;
      return Boolean(contentWindow) && source === contentWindow;
    },
  };
}
