import { describe, it, expect } from "vitest";
import {
  parseWithJsonDiagnostics,
  buildRedactedSnippet,
  extractFirstBalancedJsonObject,
} from "./document-context-json-recovery";

describe("document-context-json-recovery: diagnostics", () => {
  it("preserves the original parse error message", () => {
    const { parsed, diagnostics } = parseWithJsonDiagnostics('{"units":[{"sourceUnitId":"a","text":"x"}');
    expect(parsed).toBeNull();
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.errorMessage).toMatch(/JSON/i);
  });

  it("extracts the reported character position", () => {
    const { diagnostics } = parseWithJsonDiagnostics('{"units":[{"sourceUnitId":"a","text":"x"}');
    expect(diagnostics!.position).toBeTypeOf("number");
    expect(diagnostics!.position).toBeGreaterThanOrEqual(0);
  });

  it("logs a bounded redacted snippet around the position", () => {
    // Extra trailing characters after a complete object yield a positioned error
    // ("...after JSON at position N").
    const content = '{"units":[]}}';
    const { diagnostics } = parseWithJsonDiagnostics(content);
    expect(diagnostics!.position).toBeTypeOf("number");
    expect(diagnostics!.snippet).not.toBeNull();
    expect(diagnostics!.snippet!.length).toBeLessThanOrEqual(400 + 2);
    // Redacts URLs.
    const redacted = buildRedactedSnippet('before https://ykone.com/x after', 10);
    expect(redacted).not.toContain("https://ykone.com/x");
  });

  it("reports recovered=false when the first parse fails", () => {
    const { diagnostics } = parseWithJsonDiagnostics("not json at all");
    expect(diagnostics!.recovered).toBe(false);
  });
});

describe("document-context-json-recovery: balanced-object extraction", () => {
  it("extracts a complete object with a harmless prose prefix", () => {
    const slice = extractFirstBalancedJsonObject('Sure, here it is:\n{"units":[]}');
    expect(slice).toBe('{"units":[]}');
  });

  it("extracts a complete object with a harmless prose suffix", () => {
    const slice = extractFirstBalancedJsonObject('{"units":[]}\nHope that helps!');
    expect(slice).toBe('{"units":[]}');
  });

  it("respects braces inside strings", () => {
    const slice = extractFirstBalancedJsonObject('{"units":[{"sourceUnitId":"a","text":"a {braced} b"}]}');
    expect(slice).toBe('{"units":[{"sourceUnitId":"a","text":"a {braced} b"}]}');
    // The string brace must not close the object.
    expect(() => JSON.parse(slice!)).not.toThrow();
  });

  it("respects escaped quotes inside strings", () => {
    const content = '{"units":[{"sourceUnitId":"a","text":"she said \\"hi\\" {x}"}]} trailing';
    const slice = extractFirstBalancedJsonObject(content);
    expect(JSON.parse(slice!)).toEqual({ units: [{ sourceUnitId: "a", text: 'she said "hi" {x}' }] });
  });

  it("returns null when no balanced object exists", () => {
    expect(extractFirstBalancedJsonObject('{"units":[')).toBeNull();
    expect(extractFirstBalancedJsonObject("no braces here")).toBeNull();
  });
});

describe("document-context-json-recovery: recovery integration decisions", () => {
  const good = { units: [] };
  const goodStr = JSON.stringify(good);

  it("a malformed internal JSON object still fails to parse after extraction", () => {
    // Unbalanced interior (a stray unmatched quote) cannot be repaired.
    const bad = 'prefix {"units":[{"sourceUnitId":"a","text":"unclosed';
    const slice = extractFirstBalancedJsonObject(bad);
    // Either no balanced slice or the slice itself fails JSON.parse.
    if (slice !== null) {
      expect(() => JSON.parse(slice)).toThrow();
    }
    const { parsed } = parseWithJsonDiagnostics(bad);
    expect(parsed).toBeNull();
  });

  it("recovery preserves a wrapped complete object", () => {
    const wrapped = `Note: ${goodStr} — end`;
    const slice = extractFirstBalancedJsonObject(wrapped);
    expect(slice).toBe(goodStr);
    expect(JSON.parse(slice!)).toEqual(good);
  });

  it("does not invent content for a genuinely partial object", () => {
    // An incomplete object (missing closing brace) has no balanced slice.
    const partial = 'prefix {"units":[{"sourceUnitId":"a","text":"x"}';
    expect(extractFirstBalancedJsonObject(partial)).toBeNull();
  });
});
