import { describe, it, expect, afterEach } from "vitest";
import {
  resolveModelRouting,
  resolveResolvedBudgets,
  isCoherentChunkLabel,
  isEditorialPolishLabel,
  isEditorialBilingualLabel,
  isEditorialMonolingualLabel,
} from "./deepseek-model-routing";

afterEach(() => {
  delete process.env.DEEPSEEK_TRANSLATION_MODEL;
  delete process.env.DEEPSEEK_TRANSLATION_THINKING;
  delete process.env.DEEPSEEK_TRANSLATION_REASONING_EFFORT;
  delete process.env.DEEPSEEK_TRANSLATION_MAX_TOKENS;
  delete process.env.DEEPSEEK_TRANSLATION_TIMEOUT_MS;
  delete process.env.DEEPSEEK_EDITORIAL_MODEL;
  delete process.env.DEEPSEEK_EDITORIAL_THINKING;
  delete process.env.DEEPSEEK_EDITORIAL_REASONING_EFFORT;
  delete process.env.DEEPSEEK_EDITORIAL_MAX_TOKENS;
  delete process.env.DEEPSEEK_EDITORIAL_TIMEOUT_MS;
});

describe("deepseek model + thinking + budget routing", () => {
  it("routes the single full-document translation call to thinking-disabled V4 Flash", () => {
    const r = resolveModelRouting("document-context-shadow-chunk-0");
    expect(isCoherentChunkLabel("document-context-shadow-chunk-0")).toBe(true);
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.thinkingMode).toBe("disabled");
    expect(r.reasoningEffort).toBeUndefined();
  });

  it("routes the bounded editorial-review call to thinking-enabled V4 Flash at medium effort", () => {
    const r = resolveModelRouting("document-context-editorial-review");
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.thinkingMode).toBe("enabled");
    expect(r.reasoningEffort).toBe("medium");
  });

  it("routes editorial-polish labels to thinking-disabled V4 Flash (no reasoning fallback)", () => {
    const r = resolveModelRouting("document-context-shadow-editorial-polish");
    expect(isEditorialPolishLabel("document-context-shadow-editorial-polish")).toBe(true);
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.thinkingMode).toBe("disabled");
    expect(r.reasoningEffort).toBeUndefined();
  });

  it("routes bilingual revision labels to thinking-disabled V4 Flash", () => {
    for (const label of ["editorial-bilingual-a", "editorial-bilingual-b"]) {
      expect(isEditorialBilingualLabel(label)).toBe(true);
      const r = resolveModelRouting(label);
      expect(r.model).toBe("deepseek-v4-flash");
      expect(r.thinkingMode).toBe("disabled");
      expect(r.reasoningEffort).toBeUndefined();
      expect(r.maxTokens).toBe(32768);
      expect(r.timeoutMs).toBe(180000);
    }
  });

  it("routes the monolingual proofread label to thinking-disabled V4 Flash with the editorial budget", () => {
    expect(isEditorialMonolingualLabel("editorial-monolingual-proofread")).toBe(true);
    const r = resolveModelRouting("editorial-monolingual-proofread");
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.thinkingMode).toBe("disabled");
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.maxTokens).toBe(32768);
    expect(r.timeoutMs).toBe(180000);
  });

  it("the full-document translation call uses the large output budget to avoid truncation", () => {
    const r = resolveModelRouting("document-context-shadow-chunk-0");
    expect(r.maxTokens).toBe(65536);
    expect(r.timeoutMs).toBe(180000);
  });

  it("the bounded editorial-review call uses the same large output budget and timeout", () => {
    const r = resolveModelRouting("document-context-editorial-review");
    expect(r.maxTokens).toBe(65536);
    expect(r.timeoutMs).toBe(180000);
  });

  it("editorial calls default to maxTokens=32768 and timeout=180000, never inheriting the translation limit", () => {
    const r = resolveModelRouting("document-context-shadow-editorial-polish");
    expect(r.maxTokens).toBe(32768);
    expect(r.timeoutMs).toBe(180000);
    expect(r.maxTokens).not.toBe(65536);
  });

  it("respects the translation model override but thinking stays disabled and the budget is fixed high", () => {
    process.env.DEEPSEEK_TRANSLATION_MODEL = "custom-translate";
    // Legacy thinking/budget env vars no longer change the single call.
    process.env.DEEPSEEK_TRANSLATION_THINKING = "false";
    process.env.DEEPSEEK_TRANSLATION_MAX_TOKENS = "9000";
    process.env.DEEPSEEK_TRANSLATION_TIMEOUT_MS = "70000";
    const r = resolveModelRouting("document-context-shadow-chunk-0");
    expect(r.model).toBe("custom-translate");
    expect(r.thinkingMode).toBe("disabled");
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.maxTokens).toBe(65536);
    expect(r.timeoutMs).toBe(180000);
    // Editorial budget is untouched by translation overrides.
    const e = resolveModelRouting("document-context-shadow-editorial-polish");
    expect(e.maxTokens).toBe(32768);
  });

  it("the translation call ignores the legacy reasoning-effort override (thinking stays disabled)", () => {
    process.env.DEEPSEEK_TRANSLATION_REASONING_EFFORT = "high";
    const r = resolveModelRouting("document-context-shadow-chunk-0");
    expect(r.thinkingMode).toBe("disabled");
    expect(r.reasoningEffort).toBeUndefined();
  });

  it("respects editorial env overrides independently (thinking stays disabled)", () => {
    process.env.DEEPSEEK_EDITORIAL_MODEL = "custom-editorial";
    process.env.DEEPSEEK_EDITORIAL_THINKING = "false";
    process.env.DEEPSEEK_EDITORIAL_REASONING_EFFORT = "medium";
    process.env.DEEPSEEK_EDITORIAL_MAX_TOKENS = "20000";
    process.env.DEEPSEEK_EDITORIAL_TIMEOUT_MS = "240000";
    const r = resolveModelRouting("document-context-shadow-editorial-polish");
    expect(r.model).toBe("custom-editorial");
    // Thinking is forced disabled for editorial calls regardless of env.
    expect(r.thinkingMode).toBe("disabled");
    expect(r.reasoningEffort).toBeUndefined();
    expect(r.maxTokens).toBe(20000);
    expect(r.timeoutMs).toBe(240000);
    const c = resolveModelRouting("document-context-shadow-chunk-0");
    expect(c.maxTokens).toBe(65536);
  });

  it("the provider safety cap permits 65,536 and blocks values above it", () => {
    process.env.DEEPSEEK_EDITORIAL_MAX_TOKENS = "70000";
    expect(resolveModelRouting("document-context-shadow-editorial-polish").maxTokens).toBe(65536);
    // A value exactly at the new cap is permitted.
    process.env.DEEPSEEK_EDITORIAL_MAX_TOKENS = "65536";
    expect(resolveModelRouting("document-context-shadow-editorial-polish").maxTokens).toBe(65536);
  });

  it("exposes resolved budgets through diagnostics", () => {
    const budgets = resolveResolvedBudgets();
    expect(budgets.translation).toEqual({ maxTokens: 65536, timeoutMs: 180000 });
    expect(budgets.editorial).toEqual({ maxTokens: 32768, timeoutMs: 180000 });
  });

  it("uses documented defaults when env vars are unset", () => {
    const t = resolveModelRouting("document-context-shadow-chunk-1");
    expect(t.model).toBe("deepseek-v4-flash");
    expect(t.thinkingMode).toBe("disabled");
    expect(t.reasoningEffort).toBeUndefined();
    expect(t.maxTokens).toBe(65536);
    const r = resolveModelRouting("document-context-editorial-review");
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.thinkingMode).toBe("enabled");
    expect(r.reasoningEffort).toBe("medium");
    expect(r.maxTokens).toBe(65536);
    expect(r.timeoutMs).toBe(180000);
    const e = resolveModelRouting("document-context-shadow-editorial-polish");
    expect(e.model).toBe("deepseek-v4-flash");
    expect(e.thinkingMode).toBe("disabled");
    expect(e.reasoningEffort).toBeUndefined();
    expect(e.maxTokens).toBe(32768);
  });
});
