import { afterEach, describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument, fingerprintHtml } from "@/lib/blog/article-document";
import {
  isBlockingFinding,
  runFullDocumentEditorial,
  FULL_DOCUMENT_EDITORIAL_BLOCKING_CONFIDENCE_MIN,
  type FullDocumentFinding,
  type EditorialFindingCategory,
} from "@/lib/pipeline/full-document-editorial";
import type { ChatMessage } from "@/lib/services/deepseek";

afterEach(() => {
  delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
  delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
});

const KEYPHRASE = "how to start a cafe in hong kong";

function paragraphBlock(id: string, text: string) {
  return { id, type: "paragraph" as const, content: [{ type: "text" as const, text }] };
}

function cafeDocument(extra: Array<{ id: string; text: string }> = []): ArticleDocument {
  return {
    metadata: {
      title: "Starting a Cafe in Hong Kong",
      slug: "starting-a-cafe-in-hong-kong",
      metaDescription: "A practical guide to starting a cafe in Hong Kong.",
      excerpt: "A practical guide.",
      targetWordCount: 800,
      focusKeyphrase: KEYPHRASE,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: '<!-- wp:html --><div class="b2i-language-switcher">English</div><!-- /wp:html -->',
      fingerprint: "switcher",
    },
    introduction: {
      id: "intro",
      blocks: [paragraphBlock("intro-0", "Opening a cafe in Hong Kong starts with a clear plan and a steady routine. The right location matters as much as the menu.")],
      status: "generated",
    },
    sections: [{
      id: "section-0",
      heading: "Build a Direct Line to Your Customers",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        paragraphBlock("agreement-block", "Social media offers a direct line to your customers. They offer unprecedented reach and engagement opportunities if used correctly."),
        paragraphBlock("orphan-block", "That comment shows how even big chains think carefully about who they serve and when."),
        paragraphBlock("clean-block", "A weekly content routine keeps the brand visible without burning out the team. Simple examples turn daily questions into useful posts. Staff can gather honest feedback during quiet morning hours and turn it into better service decisions. Consistency matters more than any single clever campaign."),
        ...extra.map((entry) => paragraphBlock(entry.id, entry.text)),
      ],
      status: "generated",
    }, {
      id: "section-1",
      heading: "Price the Menu for Long Term Survival",
      headingLevel: 2,
      sectionType: "main",
      blocks: [
        paragraphBlock("pricing-block", "Local teams can share useful lessons from daily work with clear and honest words. Simple examples help busy owners understand the idea and take a practical next step. Regular replies also show customers that a real person is listening to their needs."),
        paragraphBlock("pricing-clean-block", "A small weekly plan keeps the work steady without adding stress to the whole team. Owners can note common questions and turn those questions into helpful future posts. This approach builds trust slowly and gives the business a clear voice in Hong Kong."),
        paragraphBlock("pricing-third-block", "Cafe owners can review supplier prices every quarter with a simple spreadsheet. Small menu changes protect margins without confusing loyal regulars. Loyalty cards reward repeat visits and reduce the need for paid advertising."),
      ],
      status: "generated",
    }],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      blocks: [paragraphBlock("conclusion-0", "Start small, listen to regulars, and keep the routine steady. That is the honest path forward.")],
      status: "generated",
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function finding(overrides: Partial<FullDocumentFinding> & {
  findingId: string;
  category: EditorialFindingCategory;
  blockIds: string[];
}): Record<string, unknown> {
  return {
    severity: "high",
    publishability: "stylistic",
    message: "Concise diagnostic reason.",
    evidenceIds: [],
    brandRuleIds: [],
    confidence: 0.95,
    source: "model",
    ...overrides,
  };
}

function scriptedAi(handlers: Record<string, (messages: ChatMessage[]) => string>): (
  messages: ChatMessage[],
  options?: unknown,
  label?: string,
) => Promise<{ content: string }> {
  return async (messages, _options, label) => {
    const handler = handlers[label ?? ""];
    if (!handler) throw new Error(`unexpected AI call label: ${label}`);
    return { content: handler(messages) };
  };
}

const p = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

function run(
  doc: ArticleDocument,
  handlers: Record<string, (messages: ChatMessage[]) => string>,
) {
  return runFullDocumentEditorial({
    doc,
    keyphrase: KEYPHRASE,
    research: [],
    aiCall: scriptedAi(handlers),
  });
}

const verifiedClean = (findingId: string) => JSON.stringify({
  resolved: [{ findingId, resolved: true }],
  newBlockingFindings: [],
});

// ── 1. Taxonomy ──

describe("Stage 3Q publishability taxonomy", () => {
  it("a blocking label plus a blocking category plus high confidence is blocking", () => {
    const f: FullDocumentFinding = {
      findingId: "f1", category: "pronoun-agreement", severity: "high", publishability: "blocking",
      blockIds: ["section:section-0:agreement-block"], message: "They refers to singular Social media.",
      evidenceIds: [], brandRuleIds: [], confidence: 0.95, source: "model",
    };
    expect(isBlockingFinding(f)).toBe(true);
  });

  it("raw severity alone can never make a style finding blocking", () => {
    const f: FullDocumentFinding = {
      findingId: "f2", category: "punchier-wording", severity: "critical", publishability: "blocking",
      blockIds: ["section:section-0:clean-block"], message: "Could be punchier.",
      evidenceIds: [], brandRuleIds: [], confidence: 0.95, source: "model",
    };
    expect(isBlockingFinding(f)).toBe(false);
    const g: FullDocumentFinding = {
      findingId: "f3", category: "awkward-english", severity: "critical", publishability: "blocking",
      blockIds: ["section:section-0:clean-block"], message: "Awkward phrasing.",
      evidenceIds: [], brandRuleIds: [], confidence: 0.95, source: "model",
    };
    expect(isBlockingFinding(g)).toBe(false);
  });

  it("a blocking-category finding below the confidence contract is stylistic", () => {
    const f: FullDocumentFinding = {
      findingId: "f4", category: "pronoun-agreement", severity: "high", publishability: "blocking",
      blockIds: ["section:section-0:agreement-block"], message: "Possibly ambiguous pronoun.",
      evidenceIds: [], brandRuleIds: [], confidence: FULL_DOCUMENT_EDITORIAL_BLOCKING_CONFIDENCE_MIN - 0.2,
      source: "model",
    };
    expect(isBlockingFinding(f)).toBe(false);
  });

  it("a missing publishability label defaults to stylistic (nonblocking)", () => {
    const f: FullDocumentFinding = {
      findingId: "f5", category: "contradiction", severity: "critical", publishability: "stylistic",
      blockIds: ["section:section-0:clean-block"], message: "Legacy output without a label.",
      evidenceIds: [], brandRuleIds: [], confidence: 0.95, source: "model",
    };
    expect(isBlockingFinding(f)).toBe(false);
  });
});

// ── 2. Project-25 replay: orphan reference ──

describe("Stage 3Q project-25 orphan reference replay", () => {
  it("an orphan That-comment with no surviving antecedent is repaired by the AI patch", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "orphan-1", category: "orphan-reference", publishability: "blocking", blockIds: ["section:section-0:orphan-block"], message: "That comment has no surviving antecedent in the article.", confidence: 0.95 }),
      ] }),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:orphan-block", replacementHtml: p("Big chains also think carefully about who they serve and when."), reason: "Resolve orphan reference without an antecedent." }] }),
      "final-document-acceptance": () => JSON.stringify({ decisions: [{ blockId: "section:section-0:orphan-block", decision: "accept", reasonCodes: [] }] }),
      "final-document-verification": () => verifiedClean("orphan-1"),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(1);
    expect(outcome.verified).toBe(true);
    const rendered = renderArticleDocument(outcome.doc);
    expect(rendered).not.toContain("That comment");
    expect(rendered).toContain("Big chains also think carefully about who they serve and when.");
    expect(fingerprintHtml(rendered)).not.toBe(before);
  });

  it("an unrepairable orphan block is safely removed when the AI patch is rejected", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "orphan-2", category: "orphan-reference", publishability: "blocking", blockIds: ["section:section-0:orphan-block"], message: "That comment has no surviving antecedent in the article.", confidence: 0.95 }),
      ] }),
      // The AI proposes a rewrite, but the independent semantic acceptance
      // rejects it; the block is then deterministically removed.
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:orphan-block", replacementHtml: p("That comment shows how even big chains stay focused."), reason: "Tweak orphan sentence." }] }),
      "final-document-acceptance": () => JSON.stringify({ decisions: [{ blockId: "section:section-0:orphan-block", decision: "reject", reasonCodes: ["orphan-remains"] }] }),
      "final-document-verification": () => verifiedClean("orphan-2"),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.verified).toBe(true);
    const rendered = renderArticleDocument(outcome.doc);
    expect(rendered).not.toContain("That comment");
    const removal = outcome.patches.find((patch) => patch.blockId === "section:section-0:orphan-block" && patch.accepted);
    expect(removal?.accepted).toBe(true);
    expect(fingerprintHtml(rendered)).not.toBe(before);
  });

  it("a valid That-comment with a surviving preceding comment is NOT changed", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument([
      { id: "quote-block", text: "Regulars tell us the coffee matters more than the decor, one owner explained." },
    ]);
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      // The model correctly sees a surviving antecedent and reports nothing.
      "final-document-diagnosis": () => JSON.stringify({ findings: [] }),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(0);
    expect(outcome.selectedUnitIds).toEqual([]);
    expect(renderArticleDocument(outcome.doc)).toBe(renderArticleDocument(doc));
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });
});

// ── 3. Project-25 replay: pronoun/antecedent agreement ──

describe("Stage 3Q project-25 agreement replay", () => {
  it("They offer... is surgically repaired to It offers... with the same meaning", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "agree-1", category: "pronoun-agreement", publishability: "blocking", blockIds: ["section:section-0:agreement-block"], message: "They (plural) cannot refer to Social media (singular).", confidence: 0.97 }),
      ] }),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly."), reason: "Fix pronoun/antecedent number agreement." }] }),
      "final-document-acceptance": () => JSON.stringify({ decisions: [{ blockId: "section:section-0:agreement-block", decision: "accept", reasonCodes: [] }] }),
      "final-document-verification": () => verifiedClean("agree-1"),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(1);
    expect(outcome.verified).toBe(true);
    const rendered = renderArticleDocument(outcome.doc);
    expect(rendered).toContain("Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly.");
    expect(rendered).not.toContain("They offer");
    expect(fingerprintHtml(rendered)).not.toBe(before);
  });

  it("an ambiguous pronoun finding stays stylistic and never blocks", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "agree-2", category: "pronoun-agreement", publishability: "stylistic", blockIds: ["section:section-0:agreement-block"], message: "Ambiguous whether They refers to customers or social media.", confidence: 0.6 }),
      ] }),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(0);
    expect(outcome.selectedUnitIds).toEqual([]);
    expect(renderArticleDocument(outcome.doc)).toBe(renderArticleDocument(doc));
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });
});

// ── 4. Style controls ──

describe("Stage 3Q style controls", () => {
  it("repeated Remember, openers and conversational rhetorical fragments never block", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument([
      { id: "remember-block", text: "Remember, keep the playlist short and repeat the crowd-pleasers." },
      { id: "rhetorical-block", text: "After all, what could be simpler?" },
    ]);
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "style-1", category: "repeated-opener", publishability: "stylistic", severity: "high", blockIds: ["section:section-0:remember-block"], message: "Repeated Remember, opener.", confidence: 0.9 }),
        finding({ findingId: "style-2", category: "rhetorical-fragment", publishability: "stylistic", severity: "medium", blockIds: ["section:section-0:rhetorical-block"], message: "Intentional rhetorical question.", confidence: 0.7 }),
      ] }),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(0);
    expect(outcome.stylisticCount).toBe(2);
    expect(outcome.selectedUnitIds).toEqual([]);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a high-severity stylistic preference never becomes a publication blocker", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "style-3", category: "punchier-wording", publishability: "stylistic", severity: "critical", blockIds: ["section:section-0:clean-block"], message: "Wording could be punchier.", confidence: 0.98 }),
      ] }),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(0);
  });
});

// ── 5. Adversarial safety ──

describe("Stage 3Q adversarial safety", () => {
  const blockingAgreementFinding = (findingId = "adv-1") => JSON.stringify({ findings: [
    finding({ findingId, category: "pronoun-agreement", publishability: "blocking", blockIds: ["section:section-0:agreement-block"], message: "They cannot refer to singular Social media.", confidence: 0.97 }),
  ] });

  const acceptDecision = (blockId: string) => JSON.stringify({ decisions: [{ blockId, decision: "accept", reasonCodes: [] }] });

  it("an unsupported factual addition is rejected", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding(),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers 12% more reach if used correctly."), reason: "Add reach statistic." }] }),
    });
    expect(outcome.accepted).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a changed number is rejected", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument([{ id: "num-block", text: "Cafe margins sit around 12 percent in the first year. The team adjusts the menu twice a month." }]);
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "adv-2", category: "cohesion-defect", publishability: "blocking", blockIds: ["section:section-0:num-block"], message: "Cohesion defect.", confidence: 0.95 }),
      ] }),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:num-block", replacementHtml: p("Cafe margins sit around 20 percent in the first year. The team adjusts the menu twice a month."), reason: "Fix margin figure." }] }),
    });
    expect(outcome.accepted).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a new quotation/source attribution is rejected", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding("adv-3"),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers unprecedented reach according to a study."), reason: "Add source." }] }),
    });
    expect(outcome.accepted).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a changed link destination is rejected", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument([{ id: "link-block", text: "Visit our guide for more detail." }]);
    doc.sections[0].blocks[doc.sections[0].blocks.length - 1] = {
      id: "link-block",
      type: "paragraph",
      content: [
        { type: "text", text: "Visit " },
        { type: "link", href: "/blog/cafe-guide", text: "our guide" },
        { type: "text", text: " for more detail." },
      ],
    };
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "adv-4", category: "cohesion-defect", publishability: "blocking", blockIds: ["section:section-0:link-block"], message: "Cohesion defect.", confidence: 0.95 }),
      ] }),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:link-block", replacementHtml: `<!-- wp:paragraph --><p>Visit <a href="/blog/other-guide">our guide</a> for more detail.</p><!-- /wp:paragraph -->`, reason: "Update link." }] }),
    });
    expect(outcome.accepted).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a keyphrase or word-count violation is rejected", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const padding = Array.from({ length: 40 }, (_, i) => `Additional filler sentence number ${i} adds words without meaning.`).join(" ");
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding("adv-5"),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p(`Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly. ${padding}`), reason: "Expand block." }] }),
    });
    expect(outcome.accepted).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a protected block cannot be mutated", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await runFullDocumentEditorial({
      doc,
      keyphrase: KEYPHRASE,
      research: [],
      protectedBlockIds: ["section:section-0:clean-block"],
      aiCall: scriptedAi({
        "final-document-diagnosis": () => JSON.stringify({ findings: [
          finding({ findingId: "adv-6", category: "cohesion-defect", publishability: "blocking", blockIds: ["section:section-0:clean-block"], message: "Cohesion defect.", confidence: 0.95 }),
        ] }),
      }),
    });
    expect(outcome.accepted).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a valid antecedent is preserved when the agreement block is fixed", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument([
      { id: "customers-block", text: "Customers appreciate fast replies and honest answers. They keep coming back when the service feels human." },
    ]);
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding("adv-7"),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly."), reason: "Fix agreement." }] }),
      "final-document-acceptance": () => acceptDecision("section:section-0:agreement-block"),
      "final-document-verification": () => verifiedClean("adv-7"),
    });
    expect(outcome.accepted).toBe(true);
    const rendered = renderArticleDocument(outcome.doc);
    expect(rendered).toContain("Customers appreciate fast replies and honest answers. They keep coming back when the service feels human.");
    expect(rendered).toContain("It offers unprecedented reach");
  });

  it("an unresolved proven blocking defect fails closed", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding("adv-8"),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly."), reason: "Fix agreement." }] }),
      "final-document-acceptance": () => acceptDecision("section:section-0:agreement-block"),
      "final-document-verification": () => JSON.stringify({ resolved: [{ findingId: "adv-8", resolved: false }], newBlockingFindings: [] }),
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.verified).toBe(false);
    expect(outcome.unresolvedFindingIds).toContain("adv-8");
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a patch that introduces a NEW blocking defect fails closed", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding("adv-9"),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly."), reason: "Fix agreement." }] }),
      "final-document-acceptance": () => acceptDecision("section:section-0:agreement-block"),
      "final-document-verification": () => JSON.stringify({
        resolved: [{ findingId: "adv-9", resolved: true }],
        newBlockingFindings: [{ findingId: "new-orphan", category: "orphan-reference", blockIds: ["section:section-0:orphan-block"], message: "Patch created an orphan transition.", confidence: 0.9 }],
      }),
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.verified).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("a malformed verification response fails closed", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => blockingAgreementFinding("adv-10"),
      "final-document-patch": () => JSON.stringify({ edits: [{ blockId: "section:section-0:agreement-block", replacementHtml: p("Social media offers a direct line to your customers. It offers unprecedented reach and engagement opportunities if used correctly."), reason: "Fix agreement." }] }),
      "final-document-acceptance": () => acceptDecision("section:section-0:agreement-block"),
      "final-document-verification": () => "not json",
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.verified).toBe(false);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });

  it("stylistic findings never fail an otherwise clean article", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "style-4", category: "repeated-opener", publishability: "stylistic", blockIds: ["section:section-0:clean-block"], message: "Repeated opener.", confidence: 0.95 }),
        finding({ findingId: "style-5", category: "mechanical-english", publishability: "stylistic", blockIds: ["section:section-0:clean-block"], message: "Mechanical phrasing.", confidence: 0.9 }),
      ] }),
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.blockingCount).toBe(0);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });
});

// ── 6. Shadow mode separation ──

describe("Stage 3Q shadow mode separation", () => {
  it("shadow mode reports blocking and stylistic separately without mutating", async () => {
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "shadow";
    const doc = cafeDocument();
    const before = fingerprintHtml(renderArticleDocument(doc));
    const outcome = await run(doc, {
      "final-document-diagnosis": () => JSON.stringify({ findings: [
        finding({ findingId: "sh-block", category: "pronoun-agreement", publishability: "blocking", blockIds: ["section:section-0:agreement-block"], message: "Agreement defect.", confidence: 0.95 }),
        finding({ findingId: "sh-style", category: "repeated-opener", publishability: "stylistic", blockIds: ["section:section-0:clean-block"], message: "Repeated opener.", confidence: 0.9 }),
      ] }),
    });
    expect(outcome.status).toBe("shadow");
    expect(outcome.blockingCount).toBe(1);
    expect(outcome.stylisticCount).toBe(1);
    expect(outcome.unresolvedFindingIds).toEqual(["sh-block"]);
    expect(outcome.accepted).toBe(true);
    expect(fingerprintHtml(renderArticleDocument(outcome.doc))).toBe(before);
  });
});
