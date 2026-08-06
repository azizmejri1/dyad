import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import { previewModeAtom, selectedAppIdAtom } from "@/atoms/appAtoms";
import { isPreviewOpenAtom, stagedDiffFileAtom } from "@/atoms/viewAtoms";
import {
  clearStagedDiffAtom,
  commitMessageDraftAtom,
  commitMessageDraftsByAppIdAtom,
  exitStagedDiffAtom,
  openCommitDialogAtom,
  openStagedDiffAtom,
  resetCommitDialogAtom,
} from "./commitAtoms";

describe("staged diff navigation", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("closes the dialog and reveals the code panel when opening a diff", () => {
    store.set(openCommitDialogAtom, "banner");
    store.set(previewModeAtom, "preview");
    store.set(isPreviewOpenAtom, false);

    store.set(openStagedDiffAtom, {
      path: "src/changed.ts",
      returnTo: "banner",
    });

    expect(store.get(openCommitDialogAtom)).toBeNull();
    expect(store.get(stagedDiffFileAtom)).toBe("src/changed.ts");
    // The banner lives in the chat header, so the diff has to be revealed.
    expect(store.get(previewModeAtom)).toBe("code");
    expect(store.get(isPreviewOpenAtom)).toBe(true);
  });

  it("reopens the dialog the diff was opened from", () => {
    store.set(openStagedDiffAtom, {
      path: "src/changed.ts",
      returnTo: "editor",
    });

    store.set(exitStagedDiffAtom);

    expect(store.get(stagedDiffFileAtom)).toBeNull();
    expect(store.get(openCommitDialogAtom)).toBe("editor");
  });

  it("opens no dialog when the diff came from somewhere without one", () => {
    // The commit menu's dropdown is a shortcut straight to a diff.
    store.set(openStagedDiffAtom, { path: "src/changed.ts", returnTo: null });

    store.set(exitStagedDiffAtom);

    expect(store.get(stagedDiffFileAtom)).toBeNull();
    expect(store.get(openCommitDialogAtom)).toBeNull();
  });

  it("forgets the return target once it has been used", () => {
    store.set(openStagedDiffAtom, {
      path: "src/changed.ts",
      returnTo: "editor",
    });
    store.set(exitStagedDiffAtom);
    store.set(openCommitDialogAtom, null);

    // A later diff opened without a return target must not resurrect it.
    store.set(openStagedDiffAtom, { path: "src/other.ts", returnTo: null });
    store.set(exitStagedDiffAtom);

    expect(store.get(openCommitDialogAtom)).toBeNull();
  });

  it("does not reopen a dialog when the diff is cleared on the way elsewhere", () => {
    store.set(openStagedDiffAtom, {
      path: "src/changed.ts",
      returnTo: "editor",
    });

    // Committing, editing a diff, or opening a spec all land here.
    store.set(clearStagedDiffAtom);
    store.set(exitStagedDiffAtom);

    expect(store.get(stagedDiffFileAtom)).toBeNull();
    expect(store.get(openCommitDialogAtom)).toBeNull();
  });

  it("drops a dialog and its return target without touching the diff", () => {
    store.set(openStagedDiffAtom, {
      path: "src/changed.ts",
      returnTo: "banner",
    });
    store.set(openCommitDialogAtom, "banner");

    // A chat tab switch restores that tab's own staged diff separately.
    store.set(resetCommitDialogAtom);

    expect(store.get(openCommitDialogAtom)).toBeNull();
    expect(store.get(stagedDiffFileAtom)).toBe("src/changed.ts");
    store.set(exitStagedDiffAtom);
    expect(store.get(openCommitDialogAtom)).toBeNull();
  });
});

describe("commit message draft", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("keeps a draft per app", () => {
    store.set(selectedAppIdAtom, 1);
    store.set(commitMessageDraftAtom, "Fix the header");
    store.set(selectedAppIdAtom, 2);

    expect(store.get(commitMessageDraftAtom)).toBeNull();

    store.set(commitMessageDraftAtom, "Add a route");
    store.set(selectedAppIdAtom, 1);

    expect(store.get(commitMessageDraftAtom)).toBe("Fix the header");
  });

  it("keeps an explicitly emptied message distinct from having no draft", () => {
    store.set(selectedAppIdAtom, 1);
    store.set(commitMessageDraftAtom, "");

    // "" means the user cleared the box; null means show a fresh suggestion.
    expect(store.get(commitMessageDraftAtom)).toBe("");
  });

  it("discards the draft when set to null", () => {
    store.set(selectedAppIdAtom, 1);
    store.set(commitMessageDraftAtom, "Fix the header");

    store.set(commitMessageDraftAtom, null);

    expect(store.get(commitMessageDraftAtom)).toBeNull();
    expect(store.get(commitMessageDraftsByAppIdAtom).has(1)).toBe(false);
  });

  it("ignores writes before an app is selected", () => {
    store.set(commitMessageDraftAtom, "Fix the header");

    expect(store.get(commitMessageDraftsByAppIdAtom).size).toBe(0);
  });
});
