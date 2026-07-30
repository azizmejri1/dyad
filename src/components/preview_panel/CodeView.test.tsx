import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedFileAtom, stagedDiffFileAtom } from "@/atoms/viewAtoms";
import { CodeView } from "./CodeView";

const mocks = vi.hoisted(() => ({
  previewState: { type: "closed" } as any,
  sendPreviewEvent: vi.fn(),
  versionChanges: [] as Array<Record<string, unknown>>,
  uncommittedFiles: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useVersionPreview", () => ({
  useVersionPreview: () => ({
    state: mocks.previewState,
    send: mocks.sendPreviewEvent,
  }),
}));

vi.mock("@/hooks/useVersionChanges", () => ({
  useVersionChanges: () => ({ changes: mocks.versionChanges }),
}));

vi.mock("@/hooks/useUncommittedFiles", () => ({
  useUncommittedFiles: () => ({
    uncommittedFiles: mocks.uncommittedFiles,
    hasUncommittedFiles: mocks.uncommittedFiles.length > 0,
  }),
}));

vi.mock("@/hooks/useLoadApp", () => ({
  useLoadApp: () => ({ refreshApp: vi.fn() }),
}));

vi.mock("./VersionDiffView", () => ({
  VersionDiffView: () => <div data-testid="version-diff-view" />,
}));

vi.mock("./StagedDiffView", () => ({
  StagedDiffView: () => <div data-testid="staged-diff-view" />,
}));

vi.mock("./FileTree", () => ({ FileTree: () => <div /> }));
vi.mock("./FileEditor", () => ({
  FileEditor: ({ filePath }: { filePath: string }) => (
    <div data-testid="file-editor">{filePath}</div>
  ),
}));
vi.mock("./CommitMenu", () => ({ CommitMenu: () => null }));
vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PanelResizeHandle: () => <div />,
}));

function versionDiffState(selectedPath: string) {
  return {
    type: "viewing-diff",
    session: {
      appId: 1,
      targetVersionId: "version-1",
      selectedDiffFile: { versionId: "version-1", path: selectedPath },
      isDiffVisible: true,
    },
  };
}

describe("CodeView diff editing", () => {
  beforeEach(() => {
    mocks.previewState = { type: "closed" };
    mocks.sendPreviewEvent.mockReset();
    mocks.versionChanges = [];
    mocks.uncommittedFiles = [];
  });

  it("opens the displayed version-diff path in the regular editor", () => {
    const store = createStore();
    mocks.previewState = versionDiffState("src/selected.ts");
    mocks.versionChanges = [
      { path: "src/first.ts" },
      { path: "src/selected.ts" },
    ];
    const { rerender } = render(
      <Provider store={store}>
        <CodeView loading={false} app={{ id: 1, files: ["src/selected.ts"] }} />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId("edit-latest-version-button"));

    expect(store.get(selectedFileAtom)).toEqual({ path: "src/selected.ts" });
    expect(mocks.sendPreviewEvent).toHaveBeenCalledWith({
      type: "CLOSE_VERSION_DIFF",
    });
    mocks.previewState = { type: "closed" };
    rerender(
      <Provider store={store}>
        <CodeView loading={false} app={{ id: 1, files: ["src/selected.ts"] }} />
      </Provider>,
    );
    expect(screen.getByTestId("file-editor")).toHaveTextContent(
      "src/selected.ts",
    );
  });

  it("uses the staged view fallback and clears staged diff mode", () => {
    const store = createStore();
    store.set(stagedDiffFileAtom, "src/no-longer-staged.ts");
    mocks.uncommittedFiles = [{ path: "src/fallback.ts", status: "modified" }];
    render(
      <Provider store={store}>
        <CodeView loading={false} app={{ id: 1, files: ["src/fallback.ts"] }} />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId("edit-latest-version-button"));

    expect(store.get(selectedFileAtom)).toEqual({ path: "src/fallback.ts" });
    expect(store.get(stagedDiffFileAtom)).toBeNull();
    expect(screen.getByTestId("file-editor")).toHaveTextContent(
      "src/fallback.ts",
    );
  });

  it("disables editing when the displayed diff path is missing at HEAD", () => {
    const store = createStore();
    mocks.previewState = versionDiffState("src/deleted.ts");
    mocks.versionChanges = [{ path: "src/deleted.ts", type: "delete" }];
    render(
      <Provider store={store}>
        <CodeView loading={false} app={{ id: 1, files: ["src/current.ts"] }} />
      </Provider>,
    );

    expect(screen.getByTestId("edit-latest-version-button")).toBeDisabled();
    expect(store.get(selectedFileAtom)).toBeNull();
  });
});
