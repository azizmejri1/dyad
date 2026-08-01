import { useEffect } from "react";
import type { PreviewTransport } from "@/preview_iframe/transport";

export function useShortcut(
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean },
  callback: () => void,
  isComponentSelectorInitialized: boolean,
  transport?: PreviewTransport | null,
): void {
  useEffect(() => {
    const isModifierActive = (modKey: boolean | undefined, eventKey: boolean) =>
      modKey ? eventKey : true;

    const validateShortcut = (
      eventKey: string,
      eventModifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean },
    ) => {
      const keyMatches = eventKey === key.toLowerCase();
      const ctrlMatches = isModifierActive(
        modifiers.ctrl,
        eventModifiers.ctrl || false,
      );
      const shiftMatches = isModifierActive(
        modifiers.shift,
        eventModifiers.shift || false,
      );
      const metaMatches = isModifierActive(
        modifiers.meta,
        eventModifiers.meta || false,
      );

      if (
        keyMatches &&
        ctrlMatches &&
        shiftMatches &&
        metaMatches &&
        isComponentSelectorInitialized
      ) {
        callback();
        return true;
      }
      return false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        validateShortcut(event.key.toLowerCase(), {
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        })
      ) {
        event.preventDefault();
      }
    };

    const handleMessageEvent = (event: MessageEvent) => {
      // Only handle messages from our preview surface
      if (!transport?.matchesSource(event.source)) {
        return;
      }

      if (event.data?.type === "dyad-select-component-shortcut") {
        if (isComponentSelectorInitialized) {
          callback();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("message", handleMessageEvent);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleMessageEvent);
    };
  }, [key, modifiers, callback, isComponentSelectorInitialized, transport]);
}
