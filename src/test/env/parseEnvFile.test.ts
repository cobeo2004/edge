import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../../env/parseEnvFile.js";

describe("parseEnvFile", () => {
  it("parses basic KEY=VALUE pairs", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("skips comments and blank lines", () => {
    const input = `
# This is a comment
FOO=bar

# Another comment
BAZ=qux
`;
    expect(parseEnvFile(input)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles double-quoted values", () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  it("handles single-quoted values", () => {
    expect(parseEnvFile("FOO='hello world'")).toEqual({ FOO: "hello world" });
  });

  it("preserves inline # in quoted values", () => {
    expect(parseEnvFile('FOO="value # not a comment"')).toEqual({
      FOO: "value # not a comment",
    });
  });

  it("strips inline comments from unquoted values", () => {
    expect(parseEnvFile("FOO=bar # this is a comment")).toEqual({ FOO: "bar" });
  });

  it("handles empty values", () => {
    expect(parseEnvFile("FOO=")).toEqual({ FOO: "" });
  });

  it("handles values with equals signs", () => {
    expect(parseEnvFile("FOO=bar=baz")).toEqual({ FOO: "bar=baz" });
  });

  it("trims whitespace around keys and values", () => {
    expect(parseEnvFile("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
  });

  it("skips lines without =", () => {
    expect(parseEnvFile("NOEQ\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});
