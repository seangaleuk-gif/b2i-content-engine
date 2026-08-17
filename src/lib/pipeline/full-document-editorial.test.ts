import { afterEach, describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import { parseFullDocumentDiagnosis, runFullDocumentEditorial } from "./full-document-editorial";
import { buildPolicy } from "@/lib/blog/final-article-policy";

function paragraph(id: string, text: string) {
  return { id, type: "paragraph" as const, content: [{ type: "text" as const, text }] };
}

function document(): ArticleDocument {
  return {
    metadata: {
      title: "Creator Marketing Guide for Hong Kong Brands",
      slug: "creator-marketing-guide",
      metaDescription: "A practical creator marketing guide for Hong Kong brands.",
      excerpt: "A practical creator marketing guide.",
      targetWordCount: 1200,
      focusKeyphrase: "creator marketing",
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: '<!-- wp:html --><div class="b2i-language-switcher">English</div><!-- /wp:html -->',
      fingerprint: "switcher",
    },
    introduction: { id: "intro", blocks: [paragraph("intro-0", "Start with a clear audience and measurable goal.")], status: "generated" },
    sections: [{
      id: "section-0",
      heading: "Choose the right creators",
      headingLevel: 2,
      sectionType: "main",
      blocks: [paragraph("section-0-block-0", "Review audience fit, creative quality and relevant experience.")],
      status: "generated",
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [paragraph("conclusion-0", "Use the evidence to improve the next campaign.")], status: "generated" },
    cta: {
      id: "cta",
      type: "cta",
      html: '<!-- wp:html --><a href="https://app.b2ihub.com/signup">Create Your Free Profile</a><!-- /wp:html -->',
      fingerprint: "cta",
    },
    faqSchema: null,
    insertedLinks: [],
  };
}

afterEach(() => {
  delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
  delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
});

describe("full-document editorial transaction", () => {
  it("strictly parses diagnosis findings", () => {
    const parsed = parseFullDocumentDiagnosis(JSON.stringify({ findings: [{
      findingId: "f1", category: "awkward-english", severity: "medium",
      blockIds: ["intro.block.0"], message: "Awkward transition",
      evidenceIds: [], brandRuleIds: [], confidence: 0.9,
    }] }));
    expect(parsed.findings[0].source).toBe("model");
    expect(() => parseFullDocumentDiagnosis('{"findings":[{"category":"invented"}]}')).toThrow();
  });

  it("shadow mode sees the complete document but cannot mutate it", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    const source = document();
    const before = renderArticleDocument(source);
    let prompt = "";
    const outcome = await runFullDocumentEditorial({
      doc: source, keyphrase: "creator marketing", research: [],
      aiCall: async (messages) => {
        prompt = messages.map((message) => message.content).join("\n");
        return { content: '{"findings":[]}' };
      },
    });
    expect(outcome.status).toBe("shadow");
    expect(outcome.callCount).toBe(1);
    expect(renderArticleDocument(outcome.doc)).toBe(before);
    expect(prompt).toContain("completeRenderedArticle");
    expect(prompt).toContain("languageSwitcher");
    expect(prompt).toContain("brandRules");
  });

  it("enforce mode accepts a clean document without a rewrite call", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const outcome = await runFullDocumentEditorial({
      doc: document(), keyphrase: "creator marketing", research: [],
      aiCall: async () => ({ content: '{"findings":[]}' }),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.selectedUnitIds).toEqual([]);
    expect(outcome.callCount).toBe(1);
  });

  it("enforce mode fails closed on unknown model-supplied block IDs", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const outcome = await runFullDocumentEditorial({
      doc: document(), keyphrase: "creator marketing", research: [],
      aiCall: async () => ({ content: JSON.stringify({ findings: [{
        findingId: "f-unknown", category: "contradiction", severity: "high",
        blockIds: ["invented.block.id"], message: "Conflicting recommendation",
        evidenceIds: [], brandRuleIds: [], confidence: 0.9,
      }] }) }),
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.diagnostics[0]).toContain("unknown block");
  });

  it("keeps shadow non-blocking and makes enforce strict in the shared final policy", () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    expect(buildPolicy(1200, undefined, undefined, "creator marketing").requireFullDocumentEditorialAcceptance).toBe(false);
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const policy = buildPolicy(1200, undefined, undefined, "creator marketing");
    expect(policy.requireFullDocumentEditorialAcceptance).toBe(true);
    expect(policy.enforcePublicationQuality).toBe(true);
    expect(policy.maxRepeatedIdeaPairs).toBe(0);
  });
});

describe("final-document diagnosis compact contract", () => {
  afterEach(() => {
    delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
    delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
  });

  it("the diagnosis prompt demands a compact findings-only response and forbids echoing the article", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    let prompt = "";
    const outcome = await runFullDocumentEditorial({
      doc: document(), keyphrase: "creator marketing", research: [],
      aiCall: async (messages) => {
        prompt = messages.map((message) => message.content).join("\n");
        return { content: '{"findings":[]}' };
      },
    });
    expect(outcome.status).toBe("shadow");
    expect(prompt).toContain("Do NOT reproduce, echo, paraphrase");
    expect(prompt).toContain("At most 30 findings");
    expect(prompt).toContain("at most 240 characters");
    expect(prompt).toContain("never include block HTML");
    expect(prompt).toContain("Return only genuine findings. Do not manufacture findings to reach the maximum count. Order findings by severity and editorial impact.");
  });

  it("a production-scale (~17k char) input still returns bounded findings", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    const source = document();
    source.sections = Array.from({ length: 12 }, (_, sectionIndex) => ({
      id: `section-${sectionIndex}`,
      heading: `Section ${sectionIndex}`,
      headingLevel: 2,
      sectionType: "main" as const,
      status: "generated" as const,
      blocks: Array.from({ length: 8 }, (_, blockIndex) =>
        paragraph(`section-${sectionIndex}-block-${blockIndex}`, `Paragraph ${sectionIndex}-${blockIndex}: `.padEnd(180, "x"))),
    }));
    const rendered = renderArticleDocument(source);
    expect(rendered.length).toBeGreaterThan(16000);

    const outcome = await runFullDocumentEditorial({
      doc: source, keyphrase: "creator marketing", research: [],
      aiCall: async () => ({ content: JSON.stringify({ findings: [
        {
          findingId: "f1", category: "awkward-english", severity: "medium",
          blockIds: ["section:section-0:section-0-block-0"], message: "Awkward phrasing in this paragraph.",
          evidenceIds: [], brandRuleIds: [], confidence: 0.8,
        },
        {
          findingId: "f2", category: "cross-section-repetition", severity: "high",
          blockIds: ["section:section-2:section-2-block-0", "section:section-2:section-2-block-1"],
          message: "Two paragraphs repeat the same idea.",
          evidenceIds: [], brandRuleIds: [], confidence: 0.9,
        },
      ] }) }),
    });
    expect(outcome.findings.length).toBe(2);
    expect(outcome.callCount).toBe(1);
    expect(renderArticleDocument(outcome.doc)).toBe(rendered);
  });

  it("an oversized diagnosis response fails safely instead of silently yielding empty findings", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    const source = document();
    const before = renderArticleDocument(source);
    // Production runaway shape: valid JSON with an empty findings array plus a
    // huge ignored field (~113k chars in production).
    const runaway = JSON.stringify({ findings: [], articleEcho: "x".repeat(50_000) });
    expect(runaway.length).toBeGreaterThan(48_000);
    const outcome = await runFullDocumentEditorial({
      doc: source, keyphrase: "creator marketing", research: [],
      aiCall: async () => ({ content: runaway }),
    });
    expect(outcome.diagnostics[0]).toContain("diagnosis failed");
    expect(outcome.diagnostics[0]).toContain("too large");
    expect(outcome.status).toBe("shadow");
    expect(outcome.findings).toHaveLength(0);
    // Shadow mode stays non-blocking and never mutates the document.
    expect(outcome.accepted).toBe(true);
    expect(renderArticleDocument(outcome.doc)).toBe(before);
  });

  it("a malformed diagnosis response fails safely and never mutates the document", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    const source = document();
    const before = renderArticleDocument(source);
    const outcome = await runFullDocumentEditorial({
      doc: source, keyphrase: "creator marketing", research: [],
      aiCall: async () => ({ content: "not json at all" }),
    });
    expect(outcome.status).toBe("shadow");
    expect(outcome.accepted).toBe(true);
    expect(renderArticleDocument(outcome.doc)).toBe(before);
  });
});

describe("final-document diagnosis parser bounds", () => {
  it("rejects a finding whose message exceeds the character bound", () => {
    expect(() => parseFullDocumentDiagnosis(JSON.stringify({ findings: [{
      findingId: "f1", category: "awkward-english", severity: "medium",
      blockIds: ["intro.block.0"], message: "x".repeat(241), evidenceIds: [], brandRuleIds: [], confidence: 0.9,
    }] }))).toThrow("exceeds");
  });

  it("rejects a finding that references too many block IDs", () => {
    expect(() => parseFullDocumentDiagnosis(JSON.stringify({ findings: [{
      findingId: "f1", category: "awkward-english", severity: "medium",
      blockIds: Array.from({ length: 9 }, (_, i) => `b${i}`),
      message: "Too many references.", evidenceIds: [], brandRuleIds: [], confidence: 0.9,
    }] }))).toThrow("too many blockIds");
  });

  it("rejects an oversized raw response before parsing", () => {
    const oversized = JSON.stringify({ findings: [], articleEcho: "y".repeat(50_000) });
    expect(oversized.length).toBeGreaterThan(48_000);
    expect(() => parseFullDocumentDiagnosis(oversized)).toThrow("too large");
  });

  it("still accepts compact findings within every bound", () => {
    const parsed = parseFullDocumentDiagnosis(JSON.stringify({ findings: [
      {
        findingId: "f1", category: "unsupported-claim", severity: "high",
        blockIds: ["section-0-block-0", "section-1-block-2"],
        message: "No research supports this claim.",
        evidenceIds: ["research-1", "research-2"], brandRuleIds: ["b2i-no-unsupported-guarantees"],
        confidence: 0.95,
      },
    ] }));
    expect(parsed.findings[0].source).toBe("model");
    expect(parsed.findings[0].blockIds).toHaveLength(2);
  });
});
