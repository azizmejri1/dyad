import React from "react";
import { CheckCircle } from "lucide-react";
import { DyadMcpToolBlock } from "./DyadMcpToolBlock";

interface DyadMcpToolResultProps {
  node?: any;
  children?: React.ReactNode;
}

export const DyadMcpToolResult: React.FC<DyadMcpToolResultProps> = (props) => (
  <DyadMcpToolBlock
    {...props}
    icon={CheckCircle}
    label="Tool Result"
    accentColor="emerald"
  />
);
