import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

/**
 * Test fixture for file upload to codebase in local-agent mode.
 * The AI receives the temp file path and uses the copy_file tool
 * to copy the uploaded file into the codebase.
 * The $$TEMP_PATH:filename$$ placeholder is resolved at runtime by the
 * fake LLM server using the actual temp path from the user message.
 */
export const fixture: LocalAgentFixture = {
  description: "Upload file to codebase using copy_file tool",
  turns: [
    {
      text: "I'll upload your file to the codebase.",
      toolCalls: [
        {
          name: "copy_file",
          args: {
            source: "$$TEMP_PATH:logo.png$$",
            destination: "assets/uploaded-file.png",
            description: "Upload file to codebase",
          },
        },
      ],
    },
    {
      text: "I've successfully uploaded your file to assets/uploaded-file.png in the codebase.",
    },
  ],
};
