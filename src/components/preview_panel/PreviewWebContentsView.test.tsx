import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface SyncCall {
  appId: number;
  url: string;
  visible: boolean;
  reloadToken?: number;
  bounds: { x: number; y: number; width: number; height: number };
}

const mocks = vi.hoisted(() => ({
  syncPreviewView: vi.fn((_params: unknown) =>
    Promise.resolve({ ok: true as const }),
  ),
  setPreviewViewVisible: vi.fn((_params: unknown) =>
    Promise.resolve({ ok: true as const }),
  ),
  releasePreviewView: vi.fn((_params: unknown) =>
    Promise.resolve({ ok: true as const }),
  ),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    previewView: {
      syncPreviewView: mocks.syncPreviewView,
      setPreviewViewVisible: mocks.setPreviewViewVisible,
      releasePreviewView: mocks.releasePreviewView,
    },
  },
}));

import {
  PreviewWebContentsView,
  resetPendingPreviewParksForTests,
} from "./PreviewWebContentsView";

const flushParks = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  mocks.syncPreviewView.mockClear();
  mocks.setPreviewViewVisible.mockClear();
  mocks.releasePreviewView.mockClear();
  resetPendingPreviewParksForTests();
});

describe("PreviewWebContentsView", () => {
  it("reports the placeholder rectangle so main can position the native view", async () => {
    render(
      <PreviewWebContentsView
        appId={7}
        url="http://localhost:32100/"
        visible
      />,
    );

    await waitFor(() => expect(mocks.syncPreviewView).toHaveBeenCalled());
    const call = mocks.syncPreviewView.mock.calls[0]![0] as SyncCall;
    expect(call.appId).toBe(7);
    expect(call.url).toBe("http://localhost:32100/");
    expect(call.visible).toBe(true);
    expect(call.bounds).toEqual(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      }),
    );
  });

  it("re-syncs when the URL or reload token changes", async () => {
    const { rerender } = render(
      <PreviewWebContentsView
        appId={7}
        url="http://localhost:32100/"
        visible
      />,
    );
    await waitFor(() => expect(mocks.syncPreviewView).toHaveBeenCalled());
    mocks.syncPreviewView.mockClear();

    rerender(
      <PreviewWebContentsView
        appId={7}
        url="http://localhost:32100/"
        visible
        reloadToken={2}
      />,
    );

    await waitFor(() => expect(mocks.syncPreviewView).toHaveBeenCalled());
    expect(
      (mocks.syncPreviewView.mock.calls.at(-1)![0] as SyncCall).reloadToken,
    ).toBe(2);
  });

  it("parks the view on unmount instead of destroying it", async () => {
    // The panel unmounts on every tab switch. Releasing here would reload the
    // app each time and delete the CDP target a test run attaches to.
    const { unmount } = render(
      <PreviewWebContentsView
        appId={7}
        url="http://localhost:32100/"
        visible
      />,
    );
    await waitFor(() => expect(mocks.syncPreviewView).toHaveBeenCalled());

    unmount();
    await flushParks();

    await waitFor(() =>
      expect(mocks.setPreviewViewVisible).toHaveBeenCalledWith({
        appId: 7,
        visible: false,
      }),
    );
    expect(mocks.releasePreviewView).not.toHaveBeenCalled();
  });

  it("does not park the view when a reload remounts it", async () => {
    // PreviewPanel keys PreviewIframe on the reload token, so every reload
    // unmounts this component and immediately mounts a new one. The park and
    // the re-show travel on different IPC channels with no ordering guarantee;
    // if the park won, the view stayed off-screen and the panel looked blank
    // for the rest of the session.
    const first = render(
      <PreviewWebContentsView
        appId={7}
        url="http://localhost:32100/"
        visible
      />,
    );
    await waitFor(() => expect(mocks.syncPreviewView).toHaveBeenCalled());

    first.unmount();
    render(
      <PreviewWebContentsView
        appId={7}
        url="http://localhost:32100/"
        visible
      />,
    );
    await flushParks();

    expect(mocks.setPreviewViewVisible).not.toHaveBeenCalled();
  });
});
