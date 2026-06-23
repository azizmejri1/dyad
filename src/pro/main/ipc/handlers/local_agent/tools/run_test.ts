import { z } from "zod";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { runAppTestsCore } from "@/ipc/handlers/tests_handlers";
import { normalizeTestPath } from "@/ipc/utils/normalize_test_path";

const runTestSchema = z.object({
  path: z
    .string()
    .describe(
      "The spec file to run, relative to the app root, e.g. 'tests/signup.spec.ts'. Omit to run all tests in the app's tests/ folder.",
    )
    .optional(),
});

/**
 * Run-only tool: executes a Playwright test (or all tests) against the running
 * dev server and reports the result, WITHOUT modifying any files. Paired with
 * `generate_test` so the agent can generate → run → fix → run and refine the
 * test (and its assertions) until it passes.
 */
export const runTestTool: ToolDefinition<z.infer<typeof runTestSchema>> = {
  name: "run_test",
  description: `Run an end-to-end Playwright test (or all tests) for the current app and get the pass/fail result. This does NOT modify any files — use it to verify a test you wrote with generate_test.

- The app's dev server must be running; if it isn't, this returns an error telling you to ask the user to start the app.
- On the first run it lazily installs Playwright + a browser, which can take a while.
- Use this after generate_test to confirm the test passes, then fix the test (or the app) and re-run if it fails. Stop after a couple of fix attempts and report back if it still doesn't pass.`,
  inputSchema: runTestSchema,
  defaultConsent: "always",
  // Running tests does not modify files/state, so this is a read-only tool.
  modifiesState: false,

  getConsentPreview: (args) =>
    args.path ? `Run test ${normalizeTestPath(args.path)}` : "Run all tests",

  execute: async (args, ctx: AgentContext) => {
    const testFile = args.path ? normalizeTestPath(args.path) : undefined;
    const title = testFile ? `Running test ${testFile}` : "Running all tests";
    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(title)}"></dyad-status>`,
    );

    const result = await runAppTestsCore({ appId: ctx.appId, testFile });

    ctx.onXmlComplete(
      `<dyad-status title="${escapeXmlAttr(title)}"></dyad-status>`,
    );

    if (result.infraError) {
      return `The test could not be run: ${result.infraError.message}`;
    }
    if (result.results.length === 0) {
      return "No tests were found to run. Generate a test first with generate_test.";
    }

    const lines = result.results.map((r) => {
      const duration =
        r.durationMs != null ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : "";
      let line = `- ${r.file}: ${r.status.toUpperCase()}${duration}`;
      if (r.status !== "passed" && r.error) {
        line += `\n  ${r.error.trim().slice(0, 1500)}`;
      }
      return line;
    });

    const passed = result.results.filter((r) => r.status === "passed").length;
    const total = result.results.length;
    const header =
      passed === total
        ? `All ${total} test(s) passed.`
        : `${passed} of ${total} test(s) passed.`;
    return `${header}\n\n${lines.join("\n")}`;
  },
};
