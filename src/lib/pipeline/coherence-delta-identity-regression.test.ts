import { describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { validateArticleIntegrityContract, type ContractCategory } from "@/lib/blog/article-integrity-contract";
import { validateCoherence, coherenceViolationIdentity } from "@/lib/blog/coherence";
import { normalizeParagraphs } from "@/lib/services/section-expander";

/** Coherent long paragraph appended to every fixture so the section is never
 *  "thin" (>= MIN_SECTION_WORDS) and coherence findings are isolated to the
 *  transition under test. */
const FILLER =
  "Local teams can share useful lessons from their daily work with clear and honest words. " +
  "Simple examples help busy owners understand the idea and take a practical next step. " +
  "Regular replies also show customers that a real person is listening to their needs throughout the week.";

function paragraph(id: string, text: string): ArticleDocument["sections"][number]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDoc(blocks: Array<{ id: string; type: "paragraph"; text: string }>): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: "marketing" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{
      id: "section-0",
      heading: "Building a Routine",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [...blocks.map((block) => paragraph(block.id, block.text)), paragraph("filler", FILLER)],
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function coherenceOnly(owned: boolean) {
  return {
    keyphrase: "marketing",
    ownedCategories: new Set<ContractCategory>(owned ? ["coherence"] : []),
  };
}

const ORPHAN_1 = "So, teams should review their results every single week.";
const ORPHAN_2 = "However, teams should adapt their plan as they learn.";
// A complete-sentence Source citation (external-links inserts full-sentence
// Source blocks); coherence treats it as citation metadata, never an
// antecedent, so the orphan stays orphaned after the insertion.
const SOURCE_CITATION = "Source: Teams that review their results every week see steady improvement.";

describe("A. paragraph normalization never introduces an orphan transition", () => {
  it("a long paragraph whose split would open a chunk with a transition is not split before that sentence", () => {
    // 6 sentences; the 4th starts with "So," — splitting at the 3-sentence
    // boundary would make "So, ..." the opener of the next chunk (orphan).
    const longText =
      "Local teams share useful lessons from daily work. Simple examples help busy owners understand the idea. " +
      "Regular replies show customers that a real person listens. " +
      "So, what should teams review each week? Teams can note common questions and turn them into future posts. " +
      "This approach builds trust steadily across the whole team.";
    const html = `<!-- wp:paragraph --><p>${longText}</p><!-- /wp:paragraph -->`;
    const { html: normalized } = normalizeParagraphs(html, 3);
    const chunks = [...normalized.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].trim());
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(/^(?:so|instead|however|therefore)\s*[,:]/i.test(chunk), chunk).toBe(false);
    }
    // The transition sentence stays mid-paragraph, never a chunk opener.
    const transitionChunk = chunks.find((chunk) => chunk.includes("So, what should teams review"));
    expect(transitionChunk).toBeTruthy();
    expect(transitionChunk!.startsWith("So,")).toBe(false);
  });

  it("the split document is coherence-clean", () => {
    const longText =
      "Local teams share useful lessons from daily work. Simple examples help busy owners understand the idea. " +
      "Regular replies show customers that a real person listens. " +
      "So, what should teams review each week? Teams can note common questions and turn them into future posts. " +
      "This approach builds trust steadily across the whole team.";
    const html = `<!-- wp:paragraph --><p>${longText}</p><!-- /wp:paragraph -->`;
    const { html: normalized } = normalizeParagraphs(html, 3);
    const doc = makeDoc(
      [...normalized.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m, index) => ({ id: `b${index}`, type: "paragraph", text: m[1].trim() })),
    );
    expect(validateCoherence(doc)).toEqual([]);
  });

  it("normal splitting without transitions is unaffected", () => {
    const longText =
      "Local teams share useful lessons from daily work. Simple examples help busy owners understand the idea. " +
      "Regular replies show customers that a real person listens. Teams can note common questions and turn them into future posts. " +
      "This approach builds trust steadily across the whole team.";
    const html = `<!-- wp:paragraph --><p>${longText}</p><!-- /wp:paragraph -->`;
    const { html: normalized, splitCount } = normalizeParagraphs(html, 3);
    expect(splitCount).toBeGreaterThan(0);
    const doc = makeDoc(
      [...normalized.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m, index) => ({ id: `b${index}`, type: "paragraph", text: m[1].trim() })),
    );
    expect(validateCoherence(doc)).toEqual([]);
  });
});

describe("B. stable delta-violation identity", () => {
  it("a pre-existing orphan-transition reindexed by an inserted Source block is recognised as the same pre-existing violation", () => {
    const previous = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: ORPHAN_1 },
    ]);
    expect(validateCoherence(previous).some((v) => v.type === "orphan-transition")).toBe(true);

    // external-links inserts a Source block BEFORE it: the unchanged violation
    // moves to a later index. The contract must NOT treat it as newly introduced.
    const candidate = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: SOURCE_CITATION },
      { id: "section-0-wp-1", type: "paragraph", text: ORPHAN_1 },
    ]);
    const result = validateArticleIntegrityContract(candidate, {
      ...coherenceOnly(false),
      previous,
    });
    expect(result.violations.some((v) => v.category === "coherence")).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("external-links insertion with only block reindexing is accepted (identity stable, diagnostics keep current id)", () => {
    const previous = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: ORPHAN_1 },
    ]);
    const candidate = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: SOURCE_CITATION },
      { id: "section-0-wp-1", type: "paragraph", text: ORPHAN_1 },
    ]);
    const result = validateArticleIntegrityContract(candidate, {
      ...coherenceOnly(false),
      previous,
    });
    expect(result.valid).toBe(true);
    // Diagnostics still report the CURRENT block location of the violation.
    const current = validateCoherence(candidate).find((v) => v.type === "orphan-transition");
    expect(current?.blockId).toBeTruthy();
  });

  it("a genuinely new orphan transition created by a stage is recognised as introduced and rejected", () => {
    const previous = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: "Good paragraph one with enough content to stay complete." },
    ]);
    expect(validateCoherence(previous)).toEqual([]);
    const candidate = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: ORPHAN_2 },
    ]);
    const result = validateArticleIntegrityContract(candidate, {
      ...coherenceOnly(false),
      previous,
    });
    expect(result.violations.some((v) => v.category === "coherence")).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("an existing violation whose offending text changes is recognised as new", () => {
    const previous = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: ORPHAN_1 },
    ]);
    const candidate = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: "However, teams should change their whole approach today." },
    ]);
    const result = validateArticleIntegrityContract(candidate, {
      ...coherenceOnly(false),
      previous,
    });
    expect(result.violations.some((v) => v.category === "coherence")).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("a genuinely resolved violation is recognised as resolved", () => {
    const previous = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: ORPHAN_1 },
    ]);
    const candidate = makeDoc([
      { id: "section-0-wp-0", type: "paragraph", text: "Teams should review their results every single week." },
    ]);
    expect(validateCoherence(candidate)).toEqual([]);
    const result = validateArticleIntegrityContract(candidate, {
      ...coherenceOnly(false),
      previous,
    });
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("other integrity categories keep their delta behaviour (links)", () => {
    const linkPara = (href: string): ArticleDocument["sections"][number]["blocks"][number] => ({
      id: "section-0-wp-0",
      type: "paragraph",
      content: [
        { type: "text", text: "See the " },
        { type: "link", text: "guide", href },
        { type: "text", text: " for details." },
      ],
    });
    const previous: ArticleDocument = makeDoc([]);
    previous.sections[0].blocks = [linkPara("/blog/guide-a"), paragraph("filler", FILLER)];
    const candidate: ArticleDocument = makeDoc([]);
    candidate.sections[0].blocks = [linkPara("/blog/guide-b"), paragraph("filler", FILLER)];
    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: "marketing",
      ownedCategories: new Set(),
      previous,
    });
    expect(result.violations.some((v) => v.category === "links")).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("coherenceViolationIdentity is stable under reindexing and sensitive to content", () => {
    const a = { componentId: "section-0", blockId: "section-0-wp-9", type: "orphan-transition" as const, snippet: ORPHAN_1 };
    const b = { componentId: "section-0", blockId: "section-0-wp-10", type: "orphan-transition" as const, snippet: ORPHAN_1 };
    const c = { componentId: "section-0", blockId: "section-0-wp-10", type: "orphan-transition" as const, snippet: ORPHAN_2 };
    expect(coherenceViolationIdentity(a)).toBe(coherenceViolationIdentity(b));
    expect(coherenceViolationIdentity(a)).not.toBe(coherenceViolationIdentity(c));
  });
});
