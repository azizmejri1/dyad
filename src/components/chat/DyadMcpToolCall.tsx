import React from "react";
import { Wrench } from "lucide-react";
import { DyadMcpToolBlock } from "./DyadMcpToolBlock";

interface DyadMcpToolCallProps {
  node?: any;
  children?: React.ReactNode;
}

export const DyadMcpToolCall: React.FC<DyadMcpToolCallProps> = (props) => (
  <DyadMcpToolBlock
    {...props}
    icon={Wrench}
    label="Tool Call"
    accentColor="blue"
  />
);
