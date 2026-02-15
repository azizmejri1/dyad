import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";

const logger = log.scope("copy_file");

// The allowed source directory for copy_file (security boundary)
const TEMP_ATTACHMENTS_DIR = path.join(os.tmpdir(), "dyad-attachments");

const copyFileSchema = z.object({
  source: z
    .string()
    .describe("The absolute path of the temp attachment file to copy"),
  destination: z
    .string()
    .describe("The destination file path relative to the app root"),
  description: z
    .string()
    .optional()
    .describe("Brief description of the copy operation"),
});

export const copyFileTool: ToolDefinition<z.infer<typeof copyFileSchema>> = {
  name: "copy_file",
  description:
    "Copy an uploaded attachment file from the temp directory into the codebase",
  inputSchema: copyFileSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Copy attachment to ${args.destination}`,

  buildXml: (args, isComplete) => {
    if (!args.destination) return undefined;

    const sourceDisplay = args.source ? path.basename(args.source) : "";
    let xml = `<dyad-copy source="${escapeXmlAttr(sourceDisplay)}" destination="${escapeXmlAttr(args.destination)}" description="${escapeXmlAttr(args.description ?? "")}">`;
    if (isComplete) {
      xml += "</dyad-copy>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    // Security: validate source is within the temp attachments directory
    const resolvedSource = path.resolve(args.source);
    const resolvedTempDir = path.resolve(TEMP_ATTACHMENTS_DIR);

    if (
      !resolvedSource.startsWith(resolvedTempDir + path.sep) &&
      resolvedSource !== resolvedTempDir
    ) {
      throw new Error(
        `Security error: source path must be within the temp attachments directory (${TEMP_ATTACHMENTS_DIR}). Got: ${args.source}`,
      );
    }

    // Validate source file exists
    if (!fs.existsSync(resolvedSource)) {
      throw new Error(`Source file does not exist: ${args.source}`);
    }

    // Validate and resolve destination (within app root)
    const fullDestPath = safeJoin(ctx.appPath, args.destination);

    // Ensure destination directory exists
    const dirPath = path.dirname(fullDestPath);
    fs.mkdirSync(dirPath, { recursive: true });

    // Copy the file
    fs.copyFileSync(resolvedSource, fullDestPath);
    logger.log(
      `Successfully copied file: ${resolvedSource} -> ${fullDestPath}`,
    );

    return `Successfully copied attachment to ${args.destination}`;
  },
};
