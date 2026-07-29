import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { DyadUiDiff } from "./DyadUiDiff";

vi.mock("@/hooks/useLoadApp", () => ({
  useLoadApp: () => ({ app: { path: "my-app", resolvedPath: "/apps/my-app" } }),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    media: { openMediaFile: vi.fn() },
    system: { openFilePath: vi.fn() },
  },
}));

function renderCard(
  properties: Partial<{
    testFile: string;
    label: string;
    before: string;
    after: string;
    outcome: string;
  }>,
) {
  const store = createStore();
  store.set(selectedAppIdAtom, 7);
  return render(
    <Provider store={store}>
      <DyadUiDiff
        node={{
          properties: {
            testFile: "e2e-tests/cart.spec.ts",
            label: "e2e-tests/cart.spec.ts",
            before: "",
            after: "",
            outcome: "passed",
            state: "finished",
            ...properties,
          },
        }}
      />
    </Provider>,
  );
}

afterEach(cleanup);

describe("DyadUiDiff", () => {
  it("shows both screenshots, served from the app's test-screenshot dir", () => {
    renderCard({
      before: "ui-7-42-1-before.png",
      after: "ui-7-42-2-after.png",
    });

    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    const images = screen.getAllByRole("img");
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      "dyad-media://media/app-id/7/.dyad/test-screenshot/ui-7-42-1-before.png",
      "dyad-media://media/app-id/7/.dyad/test-screenshot/ui-7-42-2-after.png",
    ]);
  });

  it("shows a single pane when there is no baseline", () => {
    renderCard({ after: "ui-7-42-1-after.png" });

    expect(screen.queryByText("Before")).toBeNull();
    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("labels the after shot when the test failed", () => {
    renderCard({
      before: "ui-7-42-1-before.png",
      after: "ui-7-42-2-after.png",
      outcome: "failed",
    });

    expect(screen.getByText("Test failed")).toBeTruthy();
    expect(screen.getByText("(test failed at this point)")).toBeTruthy();
  });

  it("degrades to a placeholder when a screenshot no longer exists", () => {
    renderCard({
      before: "ui-7-42-1-before.png",
      after: "ui-7-42-2-after.png",
    });

    fireEvent.error(screen.getAllByRole("img")[0]);

    expect(screen.getByText("Screenshot unavailable")).toBeTruthy();
    // The surviving pane still renders its image.
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("renders nothing without an after screenshot", () => {
    const { container } = renderCard({ before: "ui-7-42-1-before.png" });

    expect(container.firstChild).toBeNull();
  });

  it("opens a lightbox on click", () => {
    renderCard({ after: "ui-7-42-1-after.png" });

    fireEvent.click(
      screen.getByRole("button", { name: /view now screenshot/i }),
    );

    expect(screen.getByRole("button", { name: "Open file" })).toBeTruthy();
  });
});
