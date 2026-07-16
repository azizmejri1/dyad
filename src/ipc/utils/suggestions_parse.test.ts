import { describe, expect, it } from "vitest";
import {
  hasCodeChanges,
  parseSuggestions,
  summarizeAssistantMessage,
} from "./suggestions_parse";

describe("parseSuggestions", () => {
  it("parses a plain JSON array", () => {
    const text = JSON.stringify([
      { title: "Add authentication", prompt: "Add email/password auth." },
      { title: "Add categories", prompt: "Let users group todos by category." },
    ]);
    const result = parseSuggestions(text);
    expect(result).toEqual([
      {
        id: "suggestion-0",
        title: "Add authentication",
        prompt: "Add email/password auth.",
      },
      {
        id: "suggestion-1",
        title: "Add categories",
        prompt: "Let users group todos by category.",
      },
    ]);
  });

  it("strips a markdown code fence", () => {
    const text =
      'Here are some ideas:\n```json\n[{"title":"Add sign up","prompt":"Add a sign up page."}]\n```';
    const result = parseSuggestions(text);
    expect(result).toEqual([
      {
        id: "suggestion-0",
        title: "Add sign up",
        prompt: "Add a sign up page.",
      },
    ]);
  });

  it("extracts a JSON array embedded in prose", () => {
    const text =
      'Sure! [{"title":"Add search","prompt":"Add a search bar."}] Hope this helps.';
    const result = parseSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Add search");
  });

  it("drops items missing a title or prompt", () => {
    const text = JSON.stringify([
      { title: "Valid", prompt: "A valid prompt." },
      { title: "No prompt" },
      { prompt: "No title" },
      { title: "", prompt: "" },
    ]);
    const result = parseSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Valid");
  });

  it("caps the number of suggestions at 4", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `Title ${i}`,
      prompt: `Prompt ${i}`,
    }));
    const result = parseSuggestions(JSON.stringify(items));
    expect(result).toHaveLength(4);
  });

  it("returns an empty array for non-JSON or malformed input", () => {
    expect(parseSuggestions("no json here")).toEqual([]);
    expect(parseSuggestions("[not valid json]")).toEqual([]);
    expect(parseSuggestions("")).toEqual([]);
    expect(parseSuggestions('{"title":"obj not array"}')).toEqual([]);
  });
});

describe("hasCodeChanges", () => {
  it("returns true when the message writes a file", () => {
    expect(
      hasCodeChanges(
        '<dyad-write path="src/App.tsx">export default App</dyad-write>',
      ),
    ).toBe(true);
  });

  it("returns true when the message adds a dependency", () => {
    expect(
      hasCodeChanges(
        '<dyad-add-dependency packages="zod"></dyad-add-dependency>',
      ),
    ).toBe(true);
  });

  it("returns false for a plain chat reply", () => {
    expect(hasCodeChanges("Sure, here is how you could do that.")).toBe(false);
  });
});

describe("summarizeAssistantMessage", () => {
  it("prefers the chat summary tag when present", () => {
    const content =
      '<dyad-chat-summary>Todo app</dyad-chat-summary><dyad-write path="a.ts">x</dyad-write>';
    expect(summarizeAssistantMessage(content)).toBe("Todo app");
  });

  it("strips dyad tags when there is no summary", () => {
    const content =
      'I built it. <dyad-write path="a.ts">const a = 1;</dyad-write> Done.';
    const summary = summarizeAssistantMessage(content);
    expect(summary).toContain("I built it.");
    expect(summary).toContain("Done.");
    expect(summary).not.toContain("dyad-write");
    expect(summary).not.toContain("const a = 1;");
  });
});
