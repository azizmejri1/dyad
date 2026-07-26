import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { previewModeAtom, selectedAppIdAtom } from "@/atoms/appAtoms";
import { setAppUrlForAppAtom } from "@/atoms/previewRuntimeAtoms";
import { recordingStartRequestAtom } from "@/atoms/recorderAtoms";
import { selectedFileAtom } from "@/atoms/viewAtoms";
import { TestsPanel } from "./TestsPanel";

const mocks = vi.hoisted(() => ({
  app: { id: 1, testingEnabled: true } as Record<string, unknown>,
  specs: [] as { file: string; tests: { title: string; line: number }[] }[],
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    tests: {
      listAppTests: vi.fn(async () => ({ specs: mocks.specs })),
      runAppTests: vi.fn(),
      stopAppTests: vi.fn(),
      getTestScreenshot: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useLoadApp", () => ({
  useLoadApp: () => ({ app: mocks.app }),
}));

vi.mock("@/hooks/useRunApp", () => ({
  useRunApp: () => ({ runApp: vi.fn() }),
}));

vi.mock("@/hooks/useSetTestingEnabled", () => ({
  useSetTestingEnabled: () => ({
    setTestingEnabled: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: {}, updateSettings: vi.fn() }),
}));

vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage: vi.fn(), isStreaming: false }),
}));

vi.mock("@/chat_stream/ChatStreamProvider", () => ({
  useStreamFinished: vi.fn(),
}));

vi.mock("@/hooks/useChatMode", () => ({
  useChatMode: () => ({ effectiveMode: "local-agent" }),
}));

vi.mock("./MigrateTestsBanner", () => ({
  MigrateTestsBanner: () => null,
}));

function renderPanel({ devServerRunning }: { devServerRunning: boolean }) {
  const store = createStore();
  store.set(selectedAppIdAtom, 1);
  store.set(previewModeAtom, "tests");
  if (devServerRunning) {
    store.set(setAppUrlForAppAtom, {
      appId: 1,
      appUrl: {
        appUrl: "http://localhost:32100",
        appId: 1,
        originalUrl: "http://localhost:32100",
        mode: "host",
      },
    });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>{children}</Provider>
      </QueryClientProvider>
    );
  }
  render(<TestsPanel />, { wrapper: Wrapper });
  return store;
}

describe("TestsPanel recording entry point", () => {
  beforeEach(() => {
    mocks.app = { id: 1, testingEnabled: true };
    mocks.specs = [];
  });

  it("hands a record request to the preview recorder", () => {
    const store = renderPanel({ devServerRunning: true });

    fireEvent.click(screen.getByTestId("tests-record-button"));

    expect(store.get(recordingStartRequestAtom)?.appId).toBe(1);
    // The recorder only exists in the preview, so the panel switches to it.
    expect(store.get(previewModeAtom)).toBe("preview");
  });

  it("disables recording until the app is running", () => {
    renderPanel({ devServerRunning: false });

    const button = screen.getByTestId(
      "tests-record-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("hides recording until testing is enabled for the app", () => {
    mocks.app = { id: 1, testingEnabled: false };

    renderPanel({ devServerRunning: true });

    expect(screen.queryByTestId("tests-record-button")).toBeNull();
  });

  it("opens a spec file in the code view", async () => {
    mocks.specs = [{ file: "e2e-tests/recorded-add-item.spec.ts", tests: [] }];

    const store = renderPanel({ devServerRunning: true });

    fireEvent.click(
      await screen.findByLabelText("Open test file: recorded-add-item.spec.ts"),
    );

    expect(store.get(selectedFileAtom)?.path).toBe(
      "e2e-tests/recorded-add-item.spec.ts",
    );
    expect(store.get(previewModeAtom)).toBe("code");
  });
});
