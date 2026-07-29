import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function UiChangeScreenshotsSwitch() {
  const { settings, updateSettings } = useSettings();
  const enabled = settings?.enableUiChangeScreenshots ?? false;
  return (
    <div className="flex items-center space-x-2">
      <Switch
        id="enable-ui-change-screenshots"
        aria-label="Before/After UI Screenshots"
        checked={enabled}
        onCheckedChange={(checked) => {
          updateSettings({ enableUiChangeScreenshots: checked });
        }}
      />
      <Label htmlFor="enable-ui-change-screenshots">
        Before/After UI Screenshots
      </Label>
    </div>
  );
}
