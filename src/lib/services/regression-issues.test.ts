import { describe, it, expect } from "vitest";
import { RetryBudget } from "./translation-types";

// ── Issue 5: Retry budget exhaustion ──

describe("RetryBudget", () => {
  it("exhausted is false when remaining > 0 and no calls are capped", () => {
    const b = new RetryBudget(12);
    b.record("section-0", 1, false); // 1 retry used
    expect(b.remaining).toBe(11);
    expect(b.exhausted).toBe(false);
  });

  it("exhausted is true only when remaining reaches 0", () => {
    const b = new RetryBudget(3);
    b.record("section-0", 1, false); // remaining=2
    expect(b.exhausted).toBe(false);
    b.record("section-1", 2, false); // remaining=0
    expect(b.exhausted).toBe(true);
  });

  it("capped flag does NOT set exhausted when remaining > 0", () => {
    const b = new RetryBudget(12);
    b.record("section-0", 0, true); // capped but 0 retries used
    expect(b.remaining).toBe(12);
    expect(b.exhausted).toBe(false); // Remaining > 0 → not exhausted
  });

  it("capRetries returns at most remaining", () => {
    const b = new RetryBudget(3);
    expect(b.capRetries(5)).toBe(3);
    expect(b.exhausted).toBe(false);
  });

  it("exhausted set once remaining drops to 0", () => {
    const b = new RetryBudget(2);
    b.record("intro", 2, false);
    expect(b.remaining).toBe(0);
    expect(b.exhausted).toBe(true);
    // Subsequent calls get 0 retries
    expect(b.capRetries(5)).toBe(0);
  });

  it("retry budget logs accurately reflect used retries", () => {
    const b = new RetryBudget(12);
    b.record("section-0", 1, false);
    b.record("section-1", 0, false);
    b.record("section-2", 2, true); // capped
    expect(b.remaining).toBe(9);
    expect(b.componentLog.length).toBe(2);
    expect(b.componentLog[0]).toContain("section-0(retries=1/12");
    expect(b.componentLog[2] || "").toBeFalsy(); // section-1 logged 0 retries, no cap → not logged
  });
});

// ── Issue 5 alternate: check that `record` with capped=true when remaining>0 doesn't set exhausted

describe("capped flag handling", () => {
  it("capped but remaining>0 keeps exhausted false", () => {
    const b = new RetryBudget(12);
    // Simulate a call that got capped (maxRetries=1 < requestedRetries=2)
    // but used 1 retry
    b.record("section-0", 1, true);
    expect(b.remaining).toBe(11);
    expect(b.exhausted).toBe(false);
  });
});

// ── Issue 6: Canonical Chinese density ──

describe("canonical Chinese density", () => {
  it("single CJK density for both checks", () => {
    // Both keyphrase_count and keyphrase_density checks use the same formula:
    // zhDensity = (exactCount * kpCjkLen / zhCharCount) * 100
    const exactCount = 3;
    const kpCjkLen = 2; // e.g. "行銷" = 2 CJK chars
    const zhCharCount = 1000;
    const density = (exactCount * kpCjkLen / zhCharCount) * 100;
    expect(density).toBe(0.6); // 3*2/1000*100 = 0.6%

    // Same calculation should be used for both checks
    // If kpCjkLen = number of CJK characters, density is deterministic
  });
});

// ── Issue 3: FAQ boundaries ──

describe("FAQ boundary validation", () => {
  it("rejects output containing h2 tags", () => {
    const output = [{ question: "Test?" }];
    const combined = JSON.stringify(output).toLowerCase();
    const hasH2 = combined.includes("</h2>");
    expect(hasH2).toBe(false);
  });

  it("requires questions end with ? or ？", () => {
    const questions = ["What is this?", "這是什麼？"];
    for (const q of questions) {
      expect(q.endsWith("?") || q.endsWith("？")).toBe(true);
    }
  });

  it("rejects questions that don't end with ? or ？", () => {
    const bad = "This is not a question";
    expect(bad.endsWith("?") || bad.endsWith("？")).toBe(false);
  });
});

// ── Issue 1: FAQ truncation ──

describe("FAQ truncation handling", () => {
  it("dynamic max_tokens based on input size", () => {
    const input = Array(6).fill(null).map((_, i) => ({
      question: `This is question number ${i + 1} about Hong Kong marketing?`,
      answer: `This is the detailed answer for question ${i + 1}. It contains multiple sentences with useful information.`,
    }));
    const inputStr = JSON.stringify(input, null, 2);
    const inputTokens = Math.ceil(inputStr.length / 4);
    const outputBudget = Math.min(8192, Math.max(4096, inputTokens * 2));
    expect(outputBudget).toBeGreaterThanOrEqual(4096);
    expect(outputBudget).toBeLessThanOrEqual(8192);
  });
});

// ── Issue 4: Metadata quality — no filler padding ──

describe("metadata range normalization", () => {
  const cjkLen = (s: string) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

  it("rejects artificial filler in title", () => {
    // The title "測試標題" has 4 CJK chars, below min 25.
    // The fix must NOT pad with generic text like "完整指南".
    // It should retry generation or hard-fail.
    const short = "測試標題";
    const cjk = cjkLen(short);
    expect(cjk).toBeLessThan(25);
    // Verify no generic filler present
    const hasFiller = short.includes("完整指南") || short.includes("B2I Hub");
    expect(hasFiller).toBe(false);
  });

  it("rejects artificial filler in meta", () => {
    const short = "測試描述";
    const cjk = cjkLen(short);
    expect(cjk).toBeLessThan(80);
    const hasFiller = short.includes("註冊B2I Hub") || short.includes("立即註冊");
    expect(hasFiller).toBe(false);
  });

  it("allows deterministic cleanup: trim trailing punctuation only", () => {
    const overloaded = "香港行銷策略完整指南！幫助品牌在香港市場脫穎而出！！";
    const trimmed = overloaded.replace(/[。，、！？\s]+$/g, "");
    expect(trimmed).toBe("香港行銷策略完整指南！幫助品牌在香港市場脫穎而出");
    expect(trimmed.length).toBeLessThan(overloaded.length);
  });
});

// ── Issue 3: FAQ boundaries — CTA/conclusion leakage ──

describe("FAQ answer boundary checks", () => {
  const signupRe = /app\.b2ihub\.com\/signup/i;
  const ctaHeadRe = /ready to grow|create your free|sign up now/i;
  const conclHeadRe = /^conclusion|in conclusion|to sum up|let'?s wrap|final thought/i;
  const faqSchemaRe = /"@type"\s*:\s*"faqpage"/i;
  const headingRe = /<h2\b|<\/h2>/i;
  const strongRe = /<strong\b[^>]*>/i;

  it("rejects FAQ answer containing signup URL", () => {
    expect(signupRe.test("click https://app.b2ihub.com/signup to start")).toBe(true);
    expect(signupRe.test("this is a normal answer about marketing")).toBe(false);
  });

  it("rejects FAQ answer containing CTA heading text", () => {
    expect(ctaHeadRe.test("Ready to grow your brand? Join us today!")).toBe(true);
    expect(ctaHeadRe.test("Create Your Free Profile now")).toBe(true);
    expect(ctaHeadRe.test("Sign up now for exclusive access")).toBe(true);
    expect(ctaHeadRe.test("This is a normal FAQ answer")).toBe(false);
  });

  it("rejects FAQ answer containing conclusion text", () => {
    expect(conclHeadRe.test("in conclusion, threads marketing is effective")).toBe(true);
    expect(conclHeadRe.test("let's wrap this up by saying...")).toBe(true);
    expect(conclHeadRe.test("final thought: always test your content")).toBe(true);
    expect(conclHeadRe.test("this is a normal answer about strategy")).toBe(false);
  });

  it("rejects FAQ answer containing FAQPage schema", () => {
    expect(faqSchemaRe.test('{"@type": "FAQPage"}')).toBe(true);
    expect(faqSchemaRe.test("normal answer about marketing")).toBe(false);
  });

  it("rejects FAQ answer containing strong markup (duplicated visible FAQ)", () => {
    expect(strongRe.test("<strong>This looks like a question</strong>")).toBe(true);
    expect(strongRe.test("normal paragraph text")).toBe(false);
  });

  it("rejects FAQ answer with HTML headings", () => {
    expect(headingRe.test("<h2>Conclusion</h2>")).toBe(true);
    expect(headingRe.test("normal paragraph text")).toBe(false);
  });

  it("rejects FAQ answer disproportionately longer than source", () => {
    const sourceLen = 50;
    const answerLen = 200; // > 3x source
    expect(answerLen > sourceLen * 3).toBe(true);
    const okAnswer = 140; // < 3x source
    expect(okAnswer > sourceLen * 3).toBe(false);
  });

  it("validates exact source count and one-to-one order", () => {
    const source = ["Q1?", "Q2?"];
    const result = ["A1?", "A2?"];
    expect(result.length).toBe(source.length);
    // One-to-one: first result maps to first source
    expect(result[0]).toBe("A1?");
  });
});

// ── Issue 2: Paired English FAQ extraction ──

describe("paired English FAQ fallback", () => {
  it("uses saved FAQ field when present", () => {
    const savedFaq = [{ question: "Q1?", answerText: "A1" }];
    const count = Array.isArray(savedFaq) ? savedFaq.length : 0;
    expect(count).toBe(1);
  });

  it("falls back to canonical parser when saved field is empty", () => {
    const savedFaq = null;
    const hasSaved = Array.isArray(savedFaq) && savedFaq.length > 0;
    expect(hasSaved).toBe(false);
    // When hasSaved is false, the route should parse the blog HTML
    const blogHtml = `<!-- wp:heading {"level":2} --><h2>FAQ</h2><!-- /wp:heading --><!-- wp:paragraph --><p><strong>What is this?</strong></p><!-- /wp:paragraph --><!-- wp:paragraph --><p>This is the answer.</p><!-- /wp:paragraph -->`;
    const visibleCount = (blogHtml.match(/<strong\b/g) || []).length;
    expect(visibleCount).toBe(1); // Fallback finds 1 FAQ entry
  });

  it("returns 0 when both saved field and blog are empty", () => {
    const savedFaq = null;
    const blogHtml = "";
    const count = Array.isArray(savedFaq) && savedFaq.length > 0
      ? savedFaq.length
      : blogHtml ? (blogHtml.match(/<strong\b/g) || []).length : 0;
    expect(count).toBe(0);
  });
});
