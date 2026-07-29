import type React from "react";
import { useEffect, useState } from "react";
import { Images } from "lucide-react";
import { useAtomValue } from "jotai";
import { CustomTagState } from "./stateTypes";
import {
  DyadCard,
  DyadCardHeader,
  DyadBadge,
  DyadStateIndicator,
} from "./DyadCardPrimitives";
import { ImageLightbox } from "./ImageLightbox";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApp } from "@/hooks/useLoadApp";
import { buildDyadTestScreenshotUrlForApp } from "@/lib/dyadMediaUrl";
import { DYAD_TEST_SCREENSHOT_DIR_NAME } from "@/ipc/utils/media_path_utils";

interface DyadUiDiffNode {
  properties: {
    testFile: string;
    label: string;
    before: string;
    after: string;
    outcome: string;
    state: CustomTagState;
  };
}

interface DyadUiDiffProps {
  node?: DyadUiDiffNode;
}

/** One labeled screenshot pane, or a placeholder when the file is gone. */
function ScreenshotPane({
  title,
  fileName,
  appId,
  appPath,
  note,
}: {
  title: string;
  fileName: string;
  appId: number | null;
  appPath: string;
  note?: string;
}) {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [fileName]);

  const url =
    appId != null && fileName
      ? buildDyadTestScreenshotUrlForApp(appId, fileName)
      : "";
  // Screenshots are pruned (and apps get deleted), so an older card can outlive
  // its images. Say so rather than showing a broken image.
  const unavailable = !url || hasError;
  const alt = `${title} screenshot`;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5 mb-1">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {title}
        </span>
        {note && (
          <span className="text-[11px] text-muted-foreground">{note}</span>
        )}
      </div>
      {unavailable ? (
        <div className="flex items-center justify-center h-28 rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
          Screenshot unavailable
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsLightboxOpen(true);
          }}
          className="block w-full rounded-lg overflow-hidden border border-border/60 transition-shadow hover:shadow-lg cursor-pointer"
          title={`View ${title.toLowerCase()} screenshot`}
          aria-label={`View ${title.toLowerCase()} screenshot`}
        >
          <img
            src={url}
            alt={alt}
            className="w-full max-h-64 object-contain bg-(--background-lighter)"
            onError={() => setHasError(true)}
          />
        </button>
      )}
      {isLightboxOpen && url && (
        <ImageLightbox
          imageUrl={url}
          alt={alt}
          filePath={
            appPath
              ? `${appPath}/${DYAD_TEST_SCREENSHOT_DIR_NAME}/${fileName}`
              : undefined
          }
          onClose={() => setIsLightboxOpen(false)}
          onError={() => {
            setHasError(true);
            setIsLightboxOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Before/after screenshots of a visual change, captured by the agent's E2E
 * runs. Unlike most cards this shows its content directly instead of behind an
 * expander: seeing the change without reading the diff is the entire point.
 */
export const DyadUiDiff: React.FC<DyadUiDiffProps> = ({ node }) => {
  const label = node?.properties?.label || node?.properties?.testFile || "";
  const before = node?.properties?.before ?? "";
  const after = node?.properties?.after ?? "";
  const failed = node?.properties?.outcome === "failed";
  const state = node?.properties?.state;

  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { app } = useLoadApp(selectedAppId);
  const appPath = app?.resolvedPath ?? app?.path ?? "";

  if (!after) return null;

  return (
    <DyadCard state={state} accentColor="sky">
      <DyadCardHeader icon={<Images size={15} />} accentColor="sky">
        <DyadBadge color="sky">UI Change</DyadBadge>
        {label && (
          <span className="text-xs text-muted-foreground font-mono truncate">
            {label}
          </span>
        )}
        {failed && (
          <div className="ml-auto">
            <DyadStateIndicator state="warning" warningLabel="Test failed" />
          </div>
        )}
      </DyadCardHeader>
      <div className="px-3 pb-3">
        <div
          className={`grid gap-3 ${before ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}
        >
          {before && (
            <ScreenshotPane
              title="Before"
              fileName={before}
              appId={selectedAppId}
              appPath={appPath}
            />
          )}
          <ScreenshotPane
            title={before ? "After" : "Now"}
            fileName={after}
            appId={selectedAppId}
            appPath={appPath}
            note={failed ? "(test failed at this point)" : undefined}
          />
        </div>
      </div>
    </DyadCard>
  );
};
