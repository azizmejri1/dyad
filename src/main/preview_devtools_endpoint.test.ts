import { describe, expect, it } from "vitest";
import {
  findPreviewTarget,
  parseDevToolsActivePort,
} from "./preview_devtools_endpoint";

describe("parseDevToolsActivePort", () => {
  it("builds a loopback endpoint from the two-line file", () => {
    expect(
      parseDevToolsActivePort("54321\n/devtools/browser/abc-123\n"),
    ).toEqual({
      port: 54321,
      browserWsEndpoint: "ws://127.0.0.1:54321/devtools/browser/abc-123",
    });
  });

  it("rejects a file that is missing the browser path", () => {
    expect(parseDevToolsActivePort("54321")).toBeNull();
    expect(parseDevToolsActivePort("54321\n")).toBeNull();
  });

  it("rejects a path that is not a browser endpoint", () => {
    // A page path would scope the connection to one page and break Browser.*.
    expect(parseDevToolsActivePort("54321\n/devtools/page/abc-123")).toBeNull();
  });

  it("rejects out-of-range and non-numeric ports", () => {
    expect(parseDevToolsActivePort("0\n/devtools/browser/a")).toBeNull();
    expect(parseDevToolsActivePort("99999\n/devtools/browser/a")).toBeNull();
    expect(parseDevToolsActivePort("abc\n/devtools/browser/a")).toBeNull();
    expect(parseDevToolsActivePort("")).toBeNull();
  });
});

describe("findPreviewTarget", () => {
  const renderer = {
    id: "renderer",
    type: "page",
    url: "file:///app/index.html",
  };
  const preview = {
    id: "preview",
    type: "page",
    url: "http://localhost:32100/",
  };

  it("matches the preview by URL rather than by position", () => {
    expect(
      findPreviewTarget([renderer, preview], "http://localhost:32100"),
    ).toBe("preview");
  });

  it("ignores a trailing-slash mismatch", () => {
    expect(
      findPreviewTarget(
        [{ ...preview, url: "http://localhost:32100" }],
        "http://localhost:32100/",
      ),
    ).toBe("preview");
  });

  it("never returns a non-page target", () => {
    const worker = {
      id: "sw",
      type: "service_worker",
      url: "http://localhost:32100/",
    };
    expect(findPreviewTarget([worker], "http://localhost:32100/")).toBeNull();
  });

  it("returns null when the preview has not appeared yet", () => {
    expect(findPreviewTarget([renderer], "http://localhost:32100/")).toBeNull();
    expect(findPreviewTarget([], "http://localhost:32100/")).toBeNull();
  });
});
