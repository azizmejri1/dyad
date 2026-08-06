import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsavedEditorFilesAtom } from "@/atoms/viewAtoms";
import type { AppFileSearchResult } from "@/ipc/types";
import { FileTree } from "./FileTree";

const mocks = vi.hoisted(() => ({
  uncommittedFiles: [] as Array<Record<string, unknown>>,
  searchResults: [] as AppFileSearchResult[],
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

vi.mock("@/hooks/useSearchAppFiles", () => ({
  useSearchAppFiles: () => ({
    results: mocks.searchResults,
    loading: false,
    error: null,
  }),
}));

const APP_ID = 7;
const FILES = [
  "src/components/Header.tsx",
  "src/components/Footer.tsx",
  "public/robots.txt",
];

function renderFileTree(store = createStore()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <FileTree appId={APP_ID} files={FILES} />
      </Provider>
    </QueryClientProvider>,
  );
}

function rowFor(path: string) {
  const row = document.querySelector(`[data-path="${path}"]`);
  if (!row) throw new Error(`No tree row rendered for ${path}`);
  return row;
}

function markerFor(path: string) {
  return rowFor(path).getAttribute("data-marker");
}

describe("FileTree change markers", () => {
  beforeEach(() => {
    mocks.uncommittedFiles = [];
    mocks.searchResults = [];
  });

  it("marks uncommitted files and leaves untouched files bare", () => {
    mocks.uncommittedFiles = [
      { path: "src/components/Header.tsx", status: "modified" },
    ];
    renderFileTree();

    expect(markerFor("src/components/Header.tsx")).toBe("uncommitted");
    expect(markerFor("src/components/Footer.tsx")).toBeNull();
    expect(markerFor("public/robots.txt")).toBeNull();
  });

  it("marks files whose editor buffer is unsaved", () => {
    const store = createStore();
    store.set(
      unsavedEditorFilesAtom,
      new Map([
        [":r0:", { appId: APP_ID, filePath: "src/components/Footer.tsx" }],
      ]),
    );
    renderFileTree(store);

    expect(markerFor("src/components/Footer.tsx")).toBe("unsaved");
  });

  it("ignores unsaved entries belonging to a different app", () => {
    const store = createStore();
    store.set(
      unsavedEditorFilesAtom,
      new Map([
        [":r0:", { appId: APP_ID + 1, filePath: "src/components/Footer.tsx" }],
      ]),
    );
    renderFileTree(store);

    expect(markerFor("src/components/Footer.tsx")).toBeNull();
  });

  it("prefers the unsaved marker when a file is both unsaved and uncommitted", () => {
    mocks.uncommittedFiles = [
      { path: "src/components/Header.tsx", status: "modified" },
    ];
    const store = createStore();
    store.set(
      unsavedEditorFilesAtom,
      new Map([
        [":r0:", { appId: APP_ID, filePath: "src/components/Header.tsx" }],
      ]),
    );
    renderFileTree(store);

    expect(markerFor("src/components/Header.tsx")).toBe("unsaved");
  });

  it("rolls the marker up to every ancestor directory", () => {
    mocks.uncommittedFiles = [
      { path: "src/components/Header.tsx", status: "modified" },
    ];
    renderFileTree();

    expect(markerFor("src")).toBe("uncommitted");
    expect(markerFor("src/components")).toBe("uncommitted");
    expect(markerFor("public")).toBeNull();
  });

  it("does not mark rows or ancestors for deleted files", () => {
    // A deleted file is gone from disk, so it has no row; it must not light up
    // its ancestors either.
    mocks.uncommittedFiles = [
      { path: "src/components/Deleted.tsx", status: "deleted" },
    ];
    renderFileTree();

    expect(
      document.querySelector('[data-path="src/components/Deleted.tsx"]'),
    ).toBeNull();
    expect(markerFor("src")).toBeNull();
    expect(markerFor("src/components")).toBeNull();
  });

  it("marks rows in the flat search results list too", async () => {
    mocks.uncommittedFiles = [
      { path: "public/robots.txt", status: "modified" },
    ];
    mocks.searchResults = [
      {
        path: "public/robots.txt",
        matchesContent: true,
        snippets: [{ line: 1, before: "", match: "Disallow", after: "" }],
      } as unknown as AppFileSearchResult,
    ];
    renderFileTree();

    fireEvent.change(screen.getByTestId("file-tree-search"), {
      target: { value: "Disallow" },
    });

    // Search mode swaps the tree for a flat list once the 250ms debounce fires.
    const row = await waitFor(() => {
      const rows = screen.getAllByTestId("file-tree-file");
      expect(rows).toHaveLength(1);
      return rows[0];
    });
    expect(row.getAttribute("data-path")).toBe("public/robots.txt");
    expect(row.getAttribute("data-marker")).toBe("uncommitted");
  });
});
