import type { RunAppTestsResult, TestResult } from "@/ipc/types/tests";
import {
  buildUiScreenshotFileName,
  persistTestScreenshot,
  type UiScreenshotPhase,
} from "@/ipc/utils/test_screenshot_store";
import { readSettings } from "@/main/settings";
import { AgentContext, escapeXmlAttr } from "./types";

/**
 * Whether the user has opted into before/after UI screenshots. Off means no
 * capture at all: the Playwright config keeps its failure-only screenshot mode
 * (see `screenshotModeFromSettings`), and nothing here runs.
 */
export function uiScreenshotsEnabled(): boolean {
  return readSettings().enableUiChangeScreenshots === true;
}

/** First screenshot of the run, whatever the outcome, with its owning spec. */
function findFinalScreenshot(results: TestResult[]): string | null {
  for (const r of results) {
    if (r.finalScreenshotPath) return r.finalScreenshotPath;
    for (const t of r.tests ?? []) {
      if (t.finalScreenshotPath) return t.finalScreenshotPath;
    }
  }
  return null;
}

/**
 * Copy this run's screenshot somewhere durable and return its filename, or
 * null when there's nothing to keep. Playwright clears `test-results/` at the
 * start of every run, so a chat card pointing there would break as soon as the
 * next test executes — the copy is what lets the card outlive the run.
 */
export async function captureUiScreenshot(
  ctx: AgentContext,
  res: RunAppTestsResult,
  phase: UiScreenshotPhase,
): Promise<string | null> {
  if (!uiScreenshotsEnabled()) return null;
  const sourcePath = findFinalScreenshot(res.results);
  if (!sourcePath) return null;

  const seq = (ctx.uiScreenshotSeq ?? 0) + 1;
  ctx.uiScreenshotSeq = seq;
  return persistTestScreenshot({
    appPath: ctx.appPath,
    sourcePath,
    fileName: buildUiScreenshotFileName({
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      seq,
      phase,
    }),
  });
}

/**
 * Render the before/after card in chat. `before` is optional: a run with no
 * baseline (the agent skipped it, or the baseline captured nothing) still shows
 * the user what the UI looks like now, which beats showing nothing.
 */
export function emitUiDiffCard(
  ctx: AgentContext,
  {
    testFile,
    grep,
    before,
    after,
    outcome,
  }: {
    testFile: string;
    grep?: string;
    before?: string;
    after: string;
    outcome: "passed" | "failed";
  },
): void {
  const label = grep ? `${testFile} › /${grep}/` : testFile;
  ctx.onXmlComplete(
    `<dyad-ui-diff test-file="${escapeXmlAttr(testFile)}" label="${escapeXmlAttr(label)}"` +
      (before ? ` before="${escapeXmlAttr(before)}"` : "") +
      ` after="${escapeXmlAttr(after)}" outcome="${outcome}"></dyad-ui-diff>`,
  );
}
