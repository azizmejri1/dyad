import { useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorCursorAtom, unsavedEditorFilesAtom } from "@/atoms/viewAtoms";
import { FileEditor } from "./FileEditor";

const mocks = vi.hoisted(() => {
  let cursorListener:
    | ((event: { position: { lineNumber: number; column: number } }) => void)
    | undefined;
  let changeListener: ((value: string | undefined) => void) | undefined;
  const editor = {
    getModel: vi.fn(() => ({
      isDisposed: () => false,
      dispose: vi.fn(),
      getLineCount: () => 100,
    })),
    getPosition: vi.fn(() => null),
    setPosition: vi.fn(),
    revealPositionInCenter: vi.fn(),
    revealLineInCenter: vi.fn(),
    onDidChangeCursorPosition: vi.fn(
      (
        listener: (event: {
          position: { lineNumber: number; column: number };
        }) => void,
      ) => {
        cursorListener = listener;
        return { dispose: vi.fn() };
      },
    ),
    onDidBlurEditorText: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return {
    editor,
    emitCursor(lineNumber: number, column: number) {
      cursorListener?.({ position: { lineNumber, column } });
    },
    emitChange(value: string | undefined) {
      changeListener?.(value);
    },
    setChangeListener(listener: (value: string | undefined) => void) {
      changeListener = listener;
    },
  };
});

vi.mock("@monaco-editor/react", () => ({
  default: ({
    onMount,
    onChange,
  }: {
    onMount: (editor: typeof mocks.editor) => void;
    onChange: (value: string | undefined) => void;
  }) => {
    const mounted = useRef(false);
    mocks.setChangeListener(onChange);
    useEffect(() => {
      if (mounted.current) return;
      mounted.current = true;
      onMount(mocks.editor);
    }, [onMount]);
    return <div data-testid="monaco-editor" />;
  },
}));

vi.mock("@/hooks/useLoadAppFile", () => ({
  useLoadAppFile: () => ({
    content: "const value = 1;",
    loading: false,
    error: null,
  }),
}));

vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "light" }),
}));

describe("FileEditor cursor persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes cursor movement against the latest file props", async () => {
    const store = createStore();
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <FileEditor appId={1} filePath="src/first.ts" persistCursor />
        </Provider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(mocks.editor.onDidChangeCursorPosition).toHaveBeenCalled(),
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <FileEditor appId={2} filePath="src/second.ts" persistCursor />
        </Provider>
      </QueryClientProvider>,
    );
    mocks.emitCursor(12, 4);

    expect(store.get(editorCursorAtom)).toEqual({
      appId: 2,
      path: "src/second.ts",
      lineNumber: 12,
      column: 4,
    });
  });

  it("does not let an initial line overwrite a matching restored cursor", async () => {
    const store = createStore();
    store.set(editorCursorAtom, {
      appId: 1,
      path: "src/file.ts",
      lineNumber: 22,
      column: 7,
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Provider store={store}>
          <FileEditor
            appId={1}
            filePath="src/file.ts"
            initialLine={5}
            persistCursor
          />
        </Provider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(mocks.editor.setPosition).toHaveBeenCalledWith({
        lineNumber: 22,
        column: 7,
      }),
    );
    expect(mocks.editor.setPosition).not.toHaveBeenCalledWith({
      lineNumber: 5,
      column: 1,
    });
  });

  it("honors a later line target in the same file", async () => {
    const store = createStore();
    store.set(editorCursorAtom, {
      appId: 1,
      path: "src/file.ts",
      lineNumber: 22,
      column: 7,
    });
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <FileEditor
            appId={1}
            filePath="src/file.ts"
            initialLine={5}
            persistCursor
          />
        </Provider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(mocks.editor.setPosition).toHaveBeenCalledWith({
        lineNumber: 22,
        column: 7,
      }),
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <FileEditor
            appId={1}
            filePath="src/file.ts"
            initialLine={18}
            persistCursor
          />
        </Provider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(mocks.editor.setPosition).toHaveBeenCalledWith({
        lineNumber: 18,
        column: 1,
      }),
    );
  });
});

describe("FileEditor unsaved-file registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderEditor = (
    store: ReturnType<typeof createStore>,
    queryClient: QueryClient,
    props: { appId: number | null; filePath: string },
  ) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <FileEditor {...props} />
      </Provider>
    </QueryClientProvider>
  );

  const unsavedPaths = (store: ReturnType<typeof createStore>) => [
    ...store.get(unsavedEditorFilesAtom).values(),
  ];

  it("registers the file once its buffer diverges from disk", async () => {
    const store = createStore();
    render(
      renderEditor(store, new QueryClient(), {
        appId: 1,
        filePath: "src/file.ts",
      }),
    );
    await waitFor(() =>
      expect(mocks.editor.onDidBlurEditorText).toHaveBeenCalled(),
    );
    expect(unsavedPaths(store)).toEqual([]);

    act(() => mocks.emitChange("const value = 2;"));

    await waitFor(() =>
      expect(unsavedPaths(store)).toEqual([
        { appId: 1, filePath: "src/file.ts" },
      ]),
    );

    // Typing the original content back is not a pending change.
    act(() => mocks.emitChange("const value = 1;"));
    await waitFor(() => expect(unsavedPaths(store)).toEqual([]));
  });

  it("clears the entry when the editor unmounts", async () => {
    const store = createStore();
    const view = render(
      renderEditor(store, new QueryClient(), {
        appId: 1,
        filePath: "src/file.ts",
      }),
    );
    await waitFor(() =>
      expect(mocks.editor.onDidBlurEditorText).toHaveBeenCalled(),
    );
    act(() => mocks.emitChange("dirty"));
    await waitFor(() => expect(unsavedPaths(store)).toHaveLength(1));

    view.unmount();

    expect(unsavedPaths(store)).toEqual([]);
  });

  it("clears the previous file's entry when the path changes in place", async () => {
    const store = createStore();
    const queryClient = new QueryClient();
    const view = render(
      renderEditor(store, queryClient, { appId: 1, filePath: "src/first.ts" }),
    );
    await waitFor(() =>
      expect(mocks.editor.onDidBlurEditorText).toHaveBeenCalled(),
    );
    act(() => mocks.emitChange("dirty"));
    await waitFor(() =>
      expect(unsavedPaths(store)).toEqual([
        { appId: 1, filePath: "src/first.ts" },
      ]),
    );

    view.rerender(
      renderEditor(store, queryClient, { appId: 1, filePath: "src/second.ts" }),
    );

    // The stale first.ts entry must not survive; a leftover would leave an
    // unsaved marker on a file that has no open editor.
    await waitFor(() =>
      expect(
        unsavedPaths(store).some((entry) => entry.filePath === "src/first.ts"),
      ).toBe(false),
    );
  });

  it("never registers an entry without an app", async () => {
    const store = createStore();
    render(
      renderEditor(store, new QueryClient(), {
        appId: null,
        filePath: "src/file.ts",
      }),
    );
    await waitFor(() =>
      expect(mocks.editor.onDidBlurEditorText).toHaveBeenCalled(),
    );

    act(() => mocks.emitChange("dirty"));

    expect(unsavedPaths(store)).toEqual([]);
  });
});
