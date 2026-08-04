import { ComponentSelection, VisualEditingChange } from "@/ipc/types";
import { atom } from "jotai";

export const selectedComponentsPreviewAtom = atom<ComponentSelection[]>([]);

export const visualEditingSelectedComponentAtom =
  atom<ComponentSelection | null>(null);

export const currentComponentCoordinatesAtom = atom<{
  top: number;
  left: number;
  width: number;
  height: number;
} | null>(null);

export const previewIframeRefAtom = atom<HTMLIFrameElement | null>(null);

/**
 * Renders the preview in an Electron WebContentsView instead of the iframe.
 *
 * Deliberately session-local rather than persisted: the native view is
 * experimental, so restarting Dyad should always land back on the iframe.
 */
export const previewNativeViewAtom = atom<boolean>(false);

export const annotatorModeAtom = atom<boolean>(false);

export const screenshotDataUrlAtom = atom<string | null>(null);
export const pendingVisualChangesAtom = atom<Map<string, VisualEditingChange>>(
  new Map(),
);
