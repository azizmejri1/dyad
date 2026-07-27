import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";

/**
 * EXPERIMENT: run E2E tests inside the preview panel.
 *
 * Toggling this needs an explicit restart note because the flag is read before
 * `app.whenReady()` — Chromium's remote debugging switch cannot be applied to a
 * running process.
 */
export function PreviewPanelE2ESwitch() {
  const { settings, updateSettings } = useSettings();
  const isEnabled = !!settings?.enablePreviewPanelE2E;
  const [changedThisSession, setChangedThisSession] = useState(false);

  return (
    <div className="space-y-1">
      <div className="flex items-center space-x-2">
        <Switch
          id="enable-preview-panel-e2e"
          aria-label="Run E2E tests in the preview panel"
          checked={isEnabled}
          onCheckedChange={(checked) => {
            setChangedThisSession(true);
            updateSettings({ enablePreviewPanelE2E: checked });
          }}
        />
        <Label htmlFor="enable-preview-panel-e2e">
          Run E2E tests in the preview panel
        </Label>
      </div>
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Renders the preview in a native view instead of an iframe, and runs your
        app's tests inside it — no separate browser window opens and there is no
        Chromium download. Visual editing, component selection and the annotator
        are not available in this mode.
      </div>
      {isEnabled && (
        <div className="rounded bg-amber-50 p-2 text-sm text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">
          While enabled, Dyad starts with a local debugging port open so the
          test runner can attach to the preview. Any program running as you can
          use it to control Dyad, so leave this off unless you are trying the
          experiment.
        </div>
      )}
      {changedThisSession && (
        <div
          className="text-sm text-gray-500 dark:text-gray-400"
          data-testid="preview-panel-e2e-restart-note"
        >
          Restart Dyad for this change to take effect.
        </div>
      )}
    </div>
  );
}
