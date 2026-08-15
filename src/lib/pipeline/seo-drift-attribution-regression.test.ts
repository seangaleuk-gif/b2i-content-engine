import { describe, expect, it } from "vitest";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import {
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";
import { canonicalKeyphraseMetrics } from "@/lib/blog/final-seo-reconcile";
import { reconcilePostOwnershipKeyphrase } from "@/lib/blog/post-ownership-seo-reconcile";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";
import { englishWordTolerance } from "@/lib/content-standards";

const KP = "hong kong marketing trends";

function claim(text: string, sentenceText?: string): ScannedClaim {
  return {
    text,
    htmlPosition: 0,
    category: "platform_metric",
    supported: false,
    sectionIndex: 0,
    ...(sentenceText ? { sentenceText } : {}),
  };
}

function paragraph(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

const FILLER = [
  "Local teams can share useful lessons from daily work with clear and honest words.",
  "Simple examples help busy owners understand the idea and take a practical next step.",
  "Regular replies also show customers that a real person is listening to their needs.",
  "A small weekly plan keeps the work steady without adding stress to the whole team.",
  "Owners can note common questions and turn those questions into helpful future posts.",
  "This approach builds trust slowly and gives the business a clear voice in Hong Kong.",
];

const KP_SENTENCES = [
  "hong kong marketing trends shape local budgets in 2026.",
  "Brands track hong kong marketing trends to plan campaigns.",
  "Analysts study hong kong marketing trends every quarter.",
  "Agencies report hong kong marketing trends each year.",
];

function makeDoc(sectionHtml: string, extraSections?: string[]): ArticleDocument {
  const sections: ArticleSection[] = [
    {
      id: "section-2",
      heading: "Practical guide to hong kong marketing trends",
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(sectionHtml, "section-2").blocks,
      status: "generated",
    },
  ];
  for (let index = 0; index < (extraSections?.length ?? 0); index++) {
    const html = extraSections![index];
    sections.push({
      id: `section-extra-${index}`,
      heading: `Supporting topic area number ${index + 1} for the guide`,
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(html, `section-extra-${index}`).blocks,
      status: "generated",
    });
  }
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "", targetWordCount: 2500, focusKeyphrase: KP },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections,
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function realisticSectionHtml(withUnsupported: boolean): string {
  const fillers = [...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER];
  const blocks = [
    paragraph(`${KP_SENTENCES[0]} ${fillers[0]} ${fillers[1]}`),
    paragraph(`${KP_SENTENCES[1]} ${fillers[2]} ${fillers[3]}`),
    paragraph(`${KP_SENTENCES[2]} ${fillers[4]} ${fillers[5]}`),
    paragraph(`${KP_SENTENCES[3]} ${fillers[6]} ${fillers[7]}`),
  ];
  if (withUnsupported) {
    blocks.push(
      paragraph("Claims about hong kong marketing trends reaching 80% are not supported by the supplied research."),
    );
  }
  return blocks.join("\n\n");
}

function extraSectionHtml(): string {
  return [...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER, ...FILLER]
    .map((sentence) => paragraph(sentence))
    .join("\n\n");
}

describe("removal-attributed SEO drift (factual-scan ownership gap)", () => {
  it("removing an unsupported sentence that contains the keyphrase may commit", () => {
    const sectionHtml = realisticSectionHtml(true);
    const previous = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    const prevOcc = canonicalKeyphraseMetrics(previous, KP).occurrences;

    const out = removeUnsupportedSentences(sectionHtml, [
      claim(
        "hong kong marketing trends reaching 80% are not supported",
        "Claims about hong kong marketing trends reaching 80% are not supported by the supplied research.",
      ),
    ]);
    const candidate = makeDoc(out.html, [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    const candOcc = canonicalKeyphraseMetrics(candidate, KP).occurrences;
    expect(candOcc).toBe(prevOcc - 1);

    // With the removal-attributed allowance, the occurrence decrease is
    // mechanically attributable and must NOT be a violation.
    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
      allowRemovalAttributedSeoDrift: true,
    });
    expect(result.violations.some((v) => v.category === "seo")).toBe(false);
  });

  it("without the allowance the same removal still fails closed (no silent weakening)", () => {
    const sectionHtml = realisticSectionHtml(true);
    const previous = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    const out = removeUnsupportedSentences(sectionHtml, [
      claim(
        "hong kong marketing trends reaching 80% are not supported",
        "Claims about hong kong marketing trends reaching 80% are not supported by the supplied research.",
      ),
    ]);
    const candidate = makeDoc(out.html, [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);

    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
    });
    expect(result.violations.some((v) => v.category === "seo" && v.message.includes("occurrences changed"))).toBe(true);
  });

  it("unrelated SEO manipulation (keyphrase insertion) still rolls back", () => {
    const previous = makeDoc(realisticSectionHtml(false), [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    // Insert a keyphrase occurrence the stage never removed — a direct SEO
    // mutation that must fail even with the removal-attributed allowance.
    const original = parseWordPressEditorialBlocks(realisticSectionHtml(false), "section-2").blocks;
    const blocks = structuredClone(original);
    const first = blocks[0];
    if (first?.type === "paragraph") {
      first.content = [
        { type: "text", text: `hong kong marketing trends dominate planning. ` },
        ...first.content,
      ];
    }
    const inserted = makeDoc(
      renderArticleDocument({
        ...previous,
        sections: [{ ...previous.sections[0], blocks }],
      }),
      [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()],
    );

    const result = validateArticleIntegrityContract(inserted, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
      allowRemovalAttributedSeoDrift: true,
    });
    expect(result.violations.some((v) => v.category === "seo" && v.message.includes("occurrences changed"))).toBe(true);
  });

  it("heading manipulation is never attributable and fails closed", () => {
    const previous = makeDoc(realisticSectionHtml(false), [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    // The stage removes the keyphrase from an H2 heading — a heading edit is
    // never a factual/ownership sentence removal, so it must fail even with
    // the removal-attributed allowance enabled.
    const candidate = makeDoc(realisticSectionHtml(false), [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    candidate.sections[0].heading = "A practical guide for local teams";
    expect(canonicalKeyphraseMetrics(candidate, KP).occurrences).toBe(
      canonicalKeyphraseMetrics(previous, KP).occurrences - 1,
    );

    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
      allowRemovalAttributedSeoDrift: true,
    });
    expect(result.violations.some((v) => v.category === "seo" && v.message.includes("occurrences changed"))).toBe(true);
  });

  it("derived drift is accepted at the owner and reaches post-ownership reconciliation", () => {
    const sectionHtml = realisticSectionHtml(true);
    const previous = makeDoc(sectionHtml, [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);
    const out = removeUnsupportedSentences(sectionHtml, [
      claim(
        "hong kong marketing trends reaching 80% are not supported",
        "Claims about hong kong marketing trends reaching 80% are not supported by the supplied research.",
      ),
    ]);
    const candidate = makeDoc(out.html, [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]);

    const result = validateArticleIntegrityContract(candidate, {
      keyphrase: KP,
      previous,
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
      allowRemovalAttributedSeoDrift: true,
    });
    expect(result.violations.some((v) => v.category === "seo")).toBe(false);

    // The downstream owner restores SEO targets after the removal.
    const reconcile = reconcilePostOwnershipKeyphrase(candidate, KP, [], undefined);
    expect(reconcile.keyphraseCountAfter).toBeGreaterThanOrEqual(canonicalKeyphraseMetrics(candidate, KP).occurrences);
  });

  it("hard SEO safety limits and final validation remain fail-closed", () => {
    // Absolute density limit still enforced by the contract.
    const stuffed = makeDoc(
      paragraph(`${Array(25).fill(KP).join(". ")}.`),
      [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()],
    );
    const stuffedResult = validateArticleIntegrityContract(stuffed, {
      keyphrase: KP,
      previous: makeDoc(realisticSectionHtml(false), [extraSectionHtml(), extraSectionHtml(), extraSectionHtml()]),
      ownedCategories: new Set(["factual", "word-count", "protected-content"]),
      allowRemovalAttributedSeoDrift: true,
    });
    expect(stuffedResult.violations.some((v) => v.category === "seo" && v.message.includes("density"))).toBe(true);

    // Final validation policy unchanged and fail-closed on stuffing.
    const range = englishWordTolerance(2500);
    const policy = buildPolicy(2500, range.min, range.max, KP);
    const metrics = analyzeFinalArticle(
      renderArticleDocument(stuffed),
      KP,
      "T",
      "D",
      2500,
    );
    const verdict = evaluatePolicy(metrics, policy);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.some((reason) => /kp stuffing|density|keyphrase/i.test(reason))).toBe(true);
  });
});
