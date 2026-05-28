import { useEffect, useRef } from "react";

// Prototype bridge that lets Dyad keep talking to the component-selector client
// when the preview is opened in a regular browser tab instead of the embedded
// iframe.
//
// The proxy worker (worker/proxy_server.js) exposes a small WebSocket bridge
// at /__dyad_ws. The injected client connects as role="tab" when it detects
// it is not in an iframe; this hook connects Dyad as role="host" and:
//   - re-emits incoming WS messages as `window.postMessage` events so the
//     existing PreviewIframe message handler picks them up unchanged.
//   - exposes a `send` function that mirrors outgoing iframe.postMessage
//     payloads to all connected external tabs.
//
// Both sides agreed on the payload shape that already flows over postMessage
// in the iframe path (see PreviewIframe.tsx), so no schema changes are
// needed here.

export interface ExternalPreviewBridge {
  /** Send a payload to every currently-connected external tab. */
  send: (payload: unknown) => void;
  /** Send a payload to a specific external tab. */
  sendToTab: (tabId: string, payload: unknown) => void;
}

const bridgeRef: { current: ExternalPreviewBridge | null } = { current: null };

/**
 * Returns a stable handle to the current external-preview bridge. The handle's
 * `send` is a no-op until a WebSocket connection is established, so callers
 * can fire-and-forget regardless of whether any external tab is open.
 */
export function getExternalPreviewBridge(): ExternalPreviewBridge {
  return {
    send: (payload) => bridgeRef.current?.send(payload),
    sendToTab: (tabId, payload) => bridgeRef.current?.sendToTab(tabId, payload),
  };
}

export function useExternalPreviewBridge(appUrl: string | null) {
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!appUrl) return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;

    const connect = () => {
      if (cancelled) return;
      let wsUrl: string;
      try {
        const u = new URL(appUrl);
        const scheme = u.protocol === "https:" ? "wss" : "ws";
        wsUrl = `${scheme}://${u.host}/__dyad_ws?role=host`;
      } catch {
        return;
      }

      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.addEventListener("open", () => {
        backoff = 1000;
      });

      ws.addEventListener("message", (evt) => {
        let parsed: any;
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          return;
        }
        // Connection-lifecycle hints — surface them but don't forward as
        // postMessage events because the existing handler doesn't know them.
        if (
          parsed?.type === "__dyad_ws_tab_connected" ||
          parsed?.type === "__dyad_ws_tab_disconnected"
        ) {
          console.debug("[dyad-ws]", parsed.type, parsed.tabId);
          return;
        }
        const data = parsed?.data;
        if (!data) return;
        // Replay this payload through window.postMessage with `source` set so
        // the existing PreviewIframe handler treats it identically to an
        // iframe-originated message. We dispatch a MessageEvent directly
        // because window.postMessage to ourselves would re-enter the same
        // event loop with `source === window`.
        const ev = new MessageEvent("message", {
          data,
          origin: window.location.origin,
          source: window,
        });
        window.dispatchEvent(ev);
      });

      ws.addEventListener("close", () => {
        socketRef.current = null;
        bridgeRef.current = null;
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      });

      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {}
      });

      bridgeRef.current = {
        send: (payload) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(JSON.stringify({ data: payload }));
          } catch {}
        },
        sendToTab: (tabId, payload) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(JSON.stringify({ target: tabId, data: payload }));
          } catch {}
        },
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      bridgeRef.current = null;
      const s = socketRef.current;
      socketRef.current = null;
      if (s) {
        try {
          s.close();
        } catch {}
      }
    };
  }, [appUrl]);
}
