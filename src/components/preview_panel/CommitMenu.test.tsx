import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import {
  commitMessageDraftAtom,
  exitStagedDiffAtom,
  openCommitDialogAtom,
} from "@/atoms/commitAtoms";
import { stagedDiffFileAtom } from "@/atoms/viewAtoms";
import { CommitMenu } from "./CommitMenu";

const mocks = vi.hoisted(() => ({
  uncommittedFiles: [] as Array<Record<string, unknown>>,
  commitChanges: vi.fn(),
  isCommitting: false,
  sendPreviewEvent: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useUncommittedFiles", () => ({
  useUncommittedFiles: () => ({
    uncommittedFiles: mocks.uncommittedFiles,
    hasUncommittedFiles: mocks.uncommittedFiles.length > 0,
  }),
}));

vi.mock("@/hooks/useCommitChanges", () => ({
  useCommitChanges: () => ({
    commitChanges: mocks.commitChanges,
    isCommitting: mocks.isCommitting,
  }),
}));

vi.mock("@/hooks/useVersionPreview", () => ({
  useVersionPreview: () => ({ send: mocks.sendPreviewEvent }),
}));

function commitMenuView(store: ReturnType<typeof createStore>) {
  // A fresh element every time: React bails out of re-rendering a referentially
  // identical one, and these tests re-render to pick up a changed file list.
  return (
    <Provider store={store}>
      <CommitMenu appId={1} />
    </Provider>
  );
}

function renderCommitMenu(store: ReturnType<typeof createStore>) {
  const rendered = render(commitMenuView(store));
  return {
    ...rendered,
    // The uncommitted-files hook is mocked from a mutable value, so a change to
    // it only reaches the component on the next render (in production the
    // query's own poll re-renders).
    rerenderCommitMenu: () => rendered.rerender(commitMenuView(store)),
  };
}

function messageInput(): HTMLInputElement {
  return screen.getByTestId("editor-commit-message-input") as HTMLInputElement;
}

describe("CommitMenu dialog", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
    store.set(selectedAppIdAtom, 1);
    mocks.uncommittedFiles = [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
      { path: "src/b.ts", status: "added", additions: 3, deletions: 0 },
    ];
    mocks.commitChanges.mockReset();
    mocks.commitChanges.mockResolvedValue(undefined);
    mocks.isCommitting = false;
    mocks.sendPreviewEvent.mockReset();
  });

  it("opens the clicked file's diff and closes the dialog", () => {
    renderCommitMenu(store);
    fireEvent.click(screen.getByTestId("editor-commit-button"));

    const rows = screen.getAllByTestId("commit-file-item");
    fireEvent.click(rows[1]);

    expect(store.get(stagedDiffFileAtom)).toBe("src/b.ts");
    expect(store.get(openCommitDialogAtom)).toBeNull();
    expect(screen.queryByTestId("editor-commit-dialog")).toBeNull();
    // A version diff would otherwise take precedence over the staged one.
    expect(mocks.sendPreviewEvent).toHaveBeenCalledWith({ type: "CLOSE" });
  });

  it("still has the typed message when the dialog comes back", () => {
    renderCommitMenu(store);
    fireEvent.click(screen.getByTestId("editor-commit-button"));
    fireEvent.change(messageInput(), { target: { value: "Fix the header" } });

    fireEvent.click(screen.getAllByTestId("commit-file-item")[0]);
    // What CodeView's "back to editor" control does.
    act(() => store.set(exitStagedDiffAtom));

    expect(screen.queryByTestId("editor-commit-dialog")).not.toBeNull();
    expect(messageInput().value).toBe("Fix the header");
  });

  it("keeps a typed message across a plain cancel and reopen", () => {
    renderCommitMenu(store);
    fireEvent.click(screen.getByTestId("editor-commit-button"));
    fireEvent.change(messageInput(), { target: { value: "Fix the header" } });

    act(() => store.set(openCommitDialogAtom, null));
    fireEvent.click(screen.getByTestId("editor-commit-button"));

    expect(messageInput().value).toBe("Fix the header");
  });

  it("regenerates the suggestion when the user never typed one", () => {
    const { rerenderCommitMenu } = renderCommitMenu(store);
    fireEvent.click(screen.getByTestId("editor-commit-button"));
    expect(messageInput().value).toBe("Add 1 file, update 1 file");

    act(() => store.set(openCommitDialogAtom, null));
    // More files changed while the dialog was closed; an untouched suggestion
    // must not still claim the old counts.
    mocks.uncommittedFiles = [
      ...mocks.uncommittedFiles,
      { path: "src/c.ts", status: "deleted", additions: 0, deletions: 2 },
    ];
    rerenderCommitMenu();
    fireEvent.click(screen.getByTestId("editor-commit-button"));

    expect(messageInput().value).toBe(
      "Add 1 file, update 1 file, remove 1 file",
    );
    expect(store.get(commitMessageDraftAtom)).toBeNull();
  });

  it("discards the draft after a successful commit", async () => {
    renderCommitMenu(store);
    fireEvent.click(screen.getByTestId("editor-commit-button"));
    fireEvent.change(messageInput(), { target: { value: "Fix the header" } });

    fireEvent.click(screen.getByTestId("editor-commit-confirm-button"));
    await vi.waitFor(() => {
      expect(mocks.commitChanges).toHaveBeenCalledWith({
        appId: 1,
        message: "Fix the header",
      });
    });

    await vi.waitFor(() => {
      expect(store.get(commitMessageDraftAtom)).toBeNull();
    });
    expect(store.get(openCommitDialogAtom)).toBeNull();
  });

  it("keeps the dialog and the message when the commit fails", async () => {
    mocks.commitChanges.mockRejectedValue(new Error("commit failed"));
    renderCommitMenu(store);
    fireEvent.click(screen.getByTestId("editor-commit-button"));
    fireEvent.change(messageInput(), { target: { value: "Fix the header" } });

    fireEvent.click(screen.getByTestId("editor-commit-confirm-button"));
    await vi.waitFor(() => {
      expect(mocks.commitChanges).toHaveBeenCalled();
    });

    expect(store.get(openCommitDialogAtom)).toBe("editor");
    expect(messageInput().value).toBe("Fix the header");
  });

  it("does not open a diff while a commit is in flight", () => {
    mocks.isCommitting = true;
    renderCommitMenu(store);
    act(() => store.set(openCommitDialogAtom, "editor"));

    const row = screen.getAllByTestId("commit-file-item")[0];
    fireEvent.click(row);

    // Opening a diff closes the dialog directly, bypassing its own busy guard.
    expect(store.get(stagedDiffFileAtom)).toBeNull();
    expect(store.get(openCommitDialogAtom)).toBe("editor");
  });
});
