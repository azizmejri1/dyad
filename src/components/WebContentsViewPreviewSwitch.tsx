import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/useSettings";

export function WebContentsViewPreviewSwitch() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Switch
          id="enable-web-contents-view-preview"
          aria-label="Enable native preview"
          checked={!!settings?.enableWebContentsViewPreview}
          onCheckedChange={(checked) => {
            void updateSettings({ enableWebContentsViewPreview: checked });
          }}
        />
        <Label htmlFor="enable-web-contents-view-preview">
          Enable native preview
        </Label>
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Adds a toggle to the preview panel that renders your app in a native
        browser view instead of an iframe. Only basic navigation is supported:
        component selection, the visual editor, the annotator, and browser
        console capture are unavailable, and menus or notifications may appear
        behind the preview.
      </p>
    </div>
  );
}
