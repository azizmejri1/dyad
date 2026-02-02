import React, { useMemo, useState } from "react";
import { ChevronsUpDown, ChevronsDownUp, type LucideIcon } from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";

interface DyadMcpToolBlockProps {
  node?: any;
  children?: React.ReactNode;
  icon: LucideIcon;
  label: string;
  accentColor: "blue" | "emerald";
}

const accentStyles = {
  blue: {
    labelText: "text-blue-600",
    iconColor: "text-blue-600",
    serverBadge:
      "bg-blue-50 dark:bg-zinc-800 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-zinc-700",
  },
  emerald: {
    labelText: "text-emerald-600",
    iconColor: "text-emerald-600",
    serverBadge:
      "bg-emerald-50 dark:bg-zinc-800 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-zinc-700",
  },
};

export const DyadMcpToolBlock: React.FC<DyadMcpToolBlockProps> = ({
  node,
  children,
  icon: Icon,
  label,
  accentColor,
}) => {
  const serverName: string = node?.properties?.serverName || "";
  const toolName: string = node?.properties?.toolName || "";
  const [expanded, setExpanded] = useState(false);

  const raw = typeof children === "string" ? children : String(children ?? "");

  const prettyJson = useMemo(() => {
    if (!expanded) return "";
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }, [expanded, raw]);

  const styles = accentStyles[accentColor];

  return (
    <div
      className="relative bg-(--background-lightest) hover:bg-(--background-lighter) rounded-lg px-4 py-2 border my-2 cursor-pointer"
      onClick={() => setExpanded((v) => !v)}
    >
      <div
        className={`absolute top-3 left-2 flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${styles.labelText} bg-white dark:bg-zinc-900`}
        style={{ zIndex: 1 }}
      >
        <Icon size={16} className={styles.iconColor} />
        <span>{label}</span>
      </div>

      <div className="absolute top-2 right-2 p-1 text-gray-500">
        {expanded ? <ChevronsDownUp size={18} /> : <ChevronsUpDown size={18} />}
      </div>

      <div className="flex items-start gap-2 pl-24 pr-8 py-1">
        {serverName ? (
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${styles.serverBadge}`}
          >
            {serverName}
          </span>
        ) : null}
        {toolName ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-gray-200 border border-border">
            {toolName}
          </span>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-2 pr-4 pb-2">
          <CodeHighlight className="language-json">{prettyJson}</CodeHighlight>
        </div>
      ) : null}
    </div>
  );
};
