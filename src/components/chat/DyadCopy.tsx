import type React from "react";
import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import {
  DyadCard,
  DyadCardHeader,
  DyadBadge,
  DyadFilePath,
  DyadDescription,
  DyadStateIndicator,
} from "./DyadCardPrimitives";
import { CustomTagState } from "./stateTypes";

interface DyadCopyProps {
  children?: ReactNode;
  node?: any;
  source?: string;
  destination?: string;
  description?: string;
}

export const DyadCopy: React.FC<DyadCopyProps> = ({
  children,
  node,
  source: sourceProp,
  destination: destinationProp,
  description: descriptionProp,
}) => {
  const source = sourceProp || node?.properties?.source || "";
  const destination = destinationProp || node?.properties?.destination || "";
  const description = descriptionProp || node?.properties?.description || "";
  const state = node?.properties?.state as CustomTagState;

  const destFileName = destination ? destination.split("/").pop() : "";
  const inProgress = state === "pending";
  const aborted = state === "aborted";

  return (
    <DyadCard accentColor="teal" state={state}>
      <DyadCardHeader icon={<Copy size={15} />} accentColor="teal">
        {destFileName && (
          <span className="font-medium text-sm text-foreground truncate">
            {destFileName}
          </span>
        )}
        <DyadBadge color="teal">Copy</DyadBadge>
        {inProgress && (
          <DyadStateIndicator state="pending" pendingLabel="Copying..." />
        )}
        {aborted && (
          <DyadStateIndicator state="aborted" abortedLabel="Did not finish" />
        )}
      </DyadCardHeader>
      {source && <DyadFilePath path={`From: ${source}`} />}
      {destination && <DyadFilePath path={`To: ${destination}`} />}
      {description && <DyadDescription>{description}</DyadDescription>}
      {children && <DyadDescription>{children}</DyadDescription>}
    </DyadCard>
  );
};
