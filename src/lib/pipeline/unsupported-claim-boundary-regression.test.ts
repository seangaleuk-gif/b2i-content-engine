import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  parseWordPressEditorialBlocks,
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import {
  scanFactualRisks,
  scanUnsupportedClaimsInDocument,
  removeUnsupportedSentences,
} from "@/lib/blog/factual-risk-scanner";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";
import { PipelineDebugTrace, traceContextFor } from "@/lib/pipeline/pipeline-debug-trace";

const KEYPHRASE = "hong kong marketing trends";

// The EXACT production unsupported claim from the latest production run:
// detected at claim-check, flagged unsupported by factual-scan, reported as
// removed (aggregate count) but the specific paragraph was skipped because the
// claim sentence carries a protected inline link, then discovered again by
// final-QC. The paragraph shape mirrors the quarantined external-links
// project-13 article (section with heading content + inline link).
const PRODUCTION_CLAIM = "The old playbook of interrupt, repeat, and hope doesn’t work here anymore";

function paragraph(html: string): string {
  return `<!-- wp:paragraph --><p>${html}</p><!-- /wp:paragraph -->`;
}

function section(id: string, heading: string, html: string): ArticleSection {
  return {
    id,
    heading,
    headingLevel: 2,
    sectionType: "main",
    blocks: parseWordPressEditorialBlocks(html, id).blocks,
    status: "generated",
  };
}

function makeDoc(sectionHtml: string, extraSections: ArticleSection[] = []): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 2500, focusKeyphrase: KEYPHRASE },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      blocks: parseWordPressEditorialBlocks(
        [paragraph("Local teams can share useful lessons from daily work with clear and honest words.")].join("\n\n"),
        "intro",
      ).blocks,
      status: "generated",
    },
    sections: [
      section("section-0", "How Hong Kong Consumer Behaviour Is Changing", sectionHtml),
      ...extraSections,
      { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", blocks: [], status: "generated" },
    ],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      blocks: parseWordPressEditorialBlocks(
        [paragraph("This is a complete conclusion sentence for the guide.")].join("\n\n"),
        "conclusion",
      ).blocks,
      status: "generated",
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

const LINKED_CLAIM_PARAGRAPH =
  paragraph(`${PRODUCTION_CLAIM}, as our <a href="/blog/guide">marketing guide</a> shows.`);

describe("unsupported-claim enforcement boundary (production gap)", () => {
  it("reproduces the exact production shape: the link-protected claim is skipped while another claim is removed", () => {
    const doc = makeDoc([
      LINKED_CLAIM_PARAGRAPH,
      paragraph("A separate unsupported claim: 85% of local teams report rising costs."),
    ].join("\n\n"));
    const html = renderArticleDocument(doc);
    const risk = scanFactualRisks(html, KEYPHRASE, []);
    const unsupported = risk.claims.filter((c) => !c.supported);
    expect(
      unsupported.some((c) => c.text.includes("old playbook of interrupt, repeat, and hope")),
    ).toBe(true);
    expect(unsupported.some((c) => c.category === "percentage" && c.text === "85%")).toBe(true);

    // The producer removes the OTHER claim but MUST skip the link-protected one.
    const cleanup = removeUnsupportedSentences(html, unsupported, {});
    expect(cleanup.sentencesRemoved).toBeGreaterThan(0);
    expect(cleanup.html).toContain("old playbook of interrupt, repeat, and hope");
    expect(cleanup.html).not.toContain("85%");

    // The authoritative canonical scanner still sees the retained claim.
    const parsed = parseArticleDocumentFromHtml(cleanup.html, doc);
    const located = scanUnsupportedClaimsInDocument(parsed.doc ?? doc, KEYPHRASE, []);
    expect(located.some((c) => c.text.includes("old playbook of interrupt, repeat, and hope"))).toBe(true);
  });

  it("the canonical scanner locates the retained claim to component/block", () => {
    const doc = makeDoc([
      LINKED_CLAIM_PARAGRAPH,
      paragraph("A separate unsupported claim: 85% of local teams report rising costs."),
    ].join("\n\n"));
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    const claim = located.find((c) => c.text.includes("old playbook of interrupt, repeat, and hope"));
    expect(claim).toBeDefined();
    expect(claim!.componentId).toBe("section-0");
    expect(claim!.blockId).toBe("section-0-wp-0");
  });

  it("supported claims are never flagged by the canonical scanner", () => {
    const research = [
      { url: "https://example.com/guide", title: "Marketing Guide", snippet: "Hong Kong consumers are more empowered than ever and expect brands to keep up." },
    ];
    const doc = makeDoc(
      [paragraph("Hong Kong consumers are more empowered than ever. They compare, they ask, and they expect brands to keep up.")].join("\n\n"),
    );
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, research);
    expect(located).toEqual([]);
  });

  it("multiple unsupported claims: only safely-removable ones leave, the link-protected one is located", () => {
    const doc = makeDoc([
      LINKED_CLAIM_PARAGRAPH,
      paragraph("Teams that ignore the shift see 78% lower engagement."),
      paragraph("Brands across the city report 42% more enquiries."),
    ].join("\n\n"));
    const html = renderArticleDocument(doc);
    const unsupported = scanFactualRisks(html, KEYPHRASE, []).claims.filter((c) => !c.supported);
    const cleanup = removeUnsupportedSentences(html, unsupported, {});
    expect(cleanup.html).toContain("old playbook of interrupt, repeat, and hope");
    const located = scanUnsupportedClaimsInDocument(
      parseArticleDocumentFromHtml(cleanup.html, doc).doc ?? doc,
      KEYPHRASE, [],
    );
    expect(located.length).toBe(1);
    expect(located[0].text).toContain("old playbook of interrupt, repeat, and hope");
  });

  it("final-QC cannot discover an unsupported claim that the factual boundaries scan with the same scanner", () => {
    // Both the boundary verification and the final gate use
    // scanUnsupportedClaimsInDocument over the canonical document; a doc that
    // fails the boundary necessarily fails final-QC's identical check.
    const doc = makeDoc([
      LINKED_CLAIM_PARAGRAPH,
      paragraph("A separate unsupported claim: 85% of local teams report rising costs."),
    ].join("\n\n"));
    const located = scanUnsupportedClaimsInDocument(doc, KEYPHRASE, []);
    expect(located.length).toBeGreaterThan(0);
    // The contract treats this as a genuine failure when it is not owned: the
    // factual claim set present in the candidate is unchanged, so a NON-owning
    // stage must reject the delta — proving the same scanner is authoritative.
    const contract = validateArticleIntegrityContract(doc, {
      keyphrase: KEYPHRASE,
      research: [],
      previous: makeDoc([paragraph("A clean paragraph that shares nothing with the claim.")].join("\n\n")),
      wordMin: 1,
      wordMax: 100000,
      ownedCategories: new Set(),
    });
    // The candidate introduces the unsupported claims vs the clean snapshot.
    expect(contract.valid).toBe(false);
    expect(contract.violations.some((v) => v.category === "factual")).toBe(true);
  });

  it("the trace reports the retained claim as present (never resolved) and removed claims as resolved", () => {
    const doc = makeDoc([
      LINKED_CLAIM_PARAGRAPH,
      paragraph("A separate unsupported claim: 85% of local teams report rising costs."),
    ].join("\n\n"));
    const cleanedHtml = removeUnsupportedSentences(
      renderArticleDocument(doc),
      scanFactualRisks(renderArticleDocument(doc), KEYPHRASE, []).claims.filter((c) => !c.supported),
      {},
    ).html;
    const cleaned = parseArticleDocumentFromHtml(cleanedHtml, doc).doc ?? doc;

    const trace = new PipelineDebugTrace();
    const ctx = traceContextFor({ keyphrase: KEYPHRASE, ctx: { research: [] } });
    trace.beginStage("factual-scan", JSON.stringify(doc), ctx);
    trace.endStage("factual-scan", cleaned, ctx, true, false);
    const record = trace.recordsFor("factual-scan")[0];
    const resolvedFactual = record.resolved.filter((v) => v.category === "factual");
    // The 85% claim was removed â†’ reported as resolved.
    expect(resolvedFactual.some((v) => v.key.includes("85%"))).toBe(true);
    // The link-protected playbook claim survives â†’ never resolved.
    expect(
      resolvedFactual.some((v) => v.key.includes("old playbook of interrupt, repeat, and hope")),
    ).toBe(false);
  });

  it("production fixture regression: the quarantined external-links article shape fails the boundary, not final-QC only", () => {
    const fixturePath = path.resolve(__dirname, "../../../fixtures/external-links-ar-question.json");
    if (!fs.existsSync(fixturePath)) return;
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ArticleDocument;
    // Inject the production unsupported claim into the AR section with a link.
    const ar = fixture.sections.find((s) => s.id === "section-4");
    if (!ar) return;
    ar.blocks.unshift({
      id: "section-4-wp-injected",
      type: "paragraph",
      content: [
        { type: "text", text: `${PRODUCTION_CLAIM}, as our ` },
        { type: "link", text: "marketing guide", href: "/blog/guide", sourceType: "internal" },
        { type: "text", text: " shows." },
      ],
    });
    const located = scanUnsupportedClaimsInDocument(fixture, KEYPHRASE, []);
    expect(located.some((c) => c.text.includes("old playbook of interrupt, repeat, and hope"))).toBe(true);
  });
});

