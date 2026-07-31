import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupabaseConnector } from "./SupabaseConnector";

const {
  detectLegacyAppKeyMock,
  switchAppToPublishableKeyMock,
  toastSuccessMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  detectLegacyAppKeyMock: vi.fn(),
  switchAppToPublishableKeyMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    supabase: {
      detectLegacyAppKey: detectLegacyAppKeyMock,
      switchAppToPublishableKey: switchAppToPublishableKeyMock,
    },
    system: { openExternalUrl: vi.fn() },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: {}, refreshSettings: vi.fn() }),
}));

vi.mock("@/hooks/useLoadApp", () => ({
  useLoadApp: () => ({
    app: {
      supabaseProjectId: "proj-1",
      supabaseProjectName: "My Project",
      supabaseOrganizationSlug: "org-1",
    },
    refreshApp: vi.fn(),
  }),
}));

vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock("@/lib/schemas", () => ({ isSupabaseConnected: () => true }));

vi.mock("@/hooks/useSupabase", () => ({
  useSupabase: () => ({
    organizations: [],
    projects: [],
    branches: [],
    isLoadingProjects: false,
    isFetchingProjects: false,
    projectsError: null,
    isLoadingBranches: false,
    branchesError: null,
    isSettingAppProject: false,
    refetchOrganizations: vi.fn(),
    setAppProject: vi.fn(),
    unsetAppProject: vi.fn(),
    deleteOrganization: vi.fn(),
  }),
}));

vi.mock("@/hooks/useConnectionFlow", () => ({
  useConnectionFlow: () => ({
    flowState: { status: "idle" },
    isFlowActive: false,
  }),
  useUnsolicitedConnectionReturn: vi.fn(),
  acknowledgeConnectionFlow: vi.fn(),
  cancelConnectionFlow: vi.fn(),
  startConnectionFlow: vi.fn(),
}));

function renderConnector() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<SupabaseConnector appId={7} />, { wrapper });
}

const BUTTON = "supabase-update-api-key-button";
const WARNING = "supabase-legacy-key-warning";

beforeEach(() => {
  vi.clearAllMocks();
  detectLegacyAppKeyMock.mockResolvedValue({ hasLegacyKey: false });
  switchAppToPublishableKeyMock.mockResolvedValue({ updated: true });
});

describe("SupabaseConnector — app API key", () => {
  // The whole point of putting it here: detection can miss the key entirely,
  // so the action must stay reachable regardless of what detection says.
  it("offers the update even when no legacy key is detected", async () => {
    renderConnector();

    expect(await screen.findByTestId(BUTTON)).toBeTruthy();
    await waitFor(() => expect(detectLegacyAppKeyMock).toHaveBeenCalled());
    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it("warns when a legacy key is detected", async () => {
    detectLegacyAppKeyMock.mockResolvedValue({ hasLegacyKey: true });

    renderConnector();

    expect(await screen.findByTestId(WARNING)).toBeTruthy();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  it("reports a completed switch", async () => {
    renderConnector();
    fireEvent.click(await screen.findByTestId(BUTTON));

    await waitFor(() =>
      expect(switchAppToPublishableKeyMock).toHaveBeenCalledWith({ appId: 7 }),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "integrations.supabase.apiKeyUpdated",
    );
  });

  // Clicking with nothing to change is expected here, since the button isn't
  // gated on detection — say so rather than looking like it did nothing.
  it("says so when the key was already current", async () => {
    switchAppToPublishableKeyMock.mockResolvedValue({ updated: false });

    renderConnector();
    fireEvent.click(await screen.findByTestId(BUTTON));

    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "integrations.supabase.apiKeyAlreadyCurrent",
      ),
    );
  });

  it("surfaces a failed switch", async () => {
    switchAppToPublishableKeyMock.mockRejectedValue(new Error("write failed"));

    renderConnector();
    fireEvent.click(await screen.findByTestId(BUTTON));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
  });
});
