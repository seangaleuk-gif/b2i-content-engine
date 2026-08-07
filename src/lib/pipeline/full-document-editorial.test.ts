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
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const policy = buildPolicy(1200, undefined, undefined, "creator marketing");
    expect(policy.requireFullDocumentEditorialAcceptance).toBe(true);
    expect(policy.enforcePublicationQuality).toBe(true);
    expect(policy.maxRepeatedIdeaPairs).toBe(0);
  });
});
