import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { dismissedLegacySupabaseKeyAppIdsAtom } from "@/atoms/supabaseAtoms";
import { SupabaseKeyWarningBanner } from "./SupabaseKeyWarningBanner";

const {
  detectLegacyAppKeyMock,
  switchAppToPublishableKeyMock,
  showSuccessMock,
} = vi.hoisted(() => ({
  detectLegacyAppKeyMock: vi.fn(),
  switchAppToPublishableKeyMock: vi.fn(),
  showSuccessMock: vi.fn(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    supabase: {
      detectLegacyAppKey: detectLegacyAppKeyMock,
      switchAppToPublishableKey: switchAppToPublishableKeyMock,
    },
  },
}));

vi.mock("@/lib/toast", () => ({
  showSuccess: showSuccessMock,
  showError: vi.fn(),
}));

function renderBanner(appId: number | null = 7) {
  const store = createStore();
  store.set(selectedAppIdAtom, appId);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  return { store, ...render(<SupabaseKeyWarningBanner />, { wrapper }) };
}

const BANNER = "supabase-key-warning-banner";

beforeEach(() => {
  vi.clearAllMocks();
  detectLegacyAppKeyMock.mockResolvedValue({ hasLegacyKey: true });
  switchAppToPublishableKeyMock.mockResolvedValue({ updated: true });
});

describe("SupabaseKeyWarningBanner", () => {
  it("offers the switch when the app is on a legacy key", async () => {
    renderBanner();

    expect(await screen.findByTestId(BANNER)).toBeTruthy();
    expect(screen.getByText(/legacy API key/i)).toBeTruthy();
  });

  it("renders nothing when the app is already on a publishable key", async () => {
    detectLegacyAppKeyMock.mockResolvedValue({ hasLegacyKey: false });

    renderBanner();

    await waitFor(() => expect(detectLegacyAppKeyMock).toHaveBeenCalled());
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it("switches the key and reports it", async () => {
    renderBanner();
    fireEvent.click(await screen.findByTestId(`${BANNER}-update`));

    await waitFor(() =>
      expect(switchAppToPublishableKeyMock).toHaveBeenCalledWith({ appId: 7 }),
    );
    expect(showSuccessMock).toHaveBeenCalledWith(
      expect.stringMatching(/Restart the app/),
    );
  });

  // Detection failing is non-critical — the offer just doesn't show.
  it("stays hidden when detection fails", async () => {
    detectLegacyAppKeyMock.mockRejectedValue(new Error("supabase down"));

    renderBanner();

    await waitFor(() => expect(detectLegacyAppKeyMock).toHaveBeenCalled());
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it("stops asking once dismissed, without checking again", async () => {
    const { store } = renderBanner();
    fireEvent.click(
      await screen.findByLabelText("Dismiss Supabase key warning"),
    );

    await waitFor(() => expect(screen.queryByTestId(BANNER)).toBeNull());
    expect(store.get(dismissedLegacySupabaseKeyAppIdsAtom).has(7)).toBe(true);
  });

  it("does not check when no app is selected", async () => {
    renderBanner(null);

    await waitFor(() => expect(screen.queryByTestId(BANNER)).toBeNull());
    expect(detectLegacyAppKeyMock).not.toHaveBeenCalled();
  });
});
