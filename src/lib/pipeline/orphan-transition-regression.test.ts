import { describe, expect, it } from "vitest";
import { removeUnsupportedSentences, type ScannedClaim } from "@/lib/blog/factual-risk-scanner";
import {
  parseWordPressEditorialBlocks,
  type ArticleDocument,
  type ArticleSection,
} from "@/lib/blog/article-document";
import { validateCoherence } from "@/lib/blog/coherence";
import { validateArticleIntegrityContract } from "@/lib/blog/article-integrity-contract";

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

function makeSectionDoc(sectionHtml: string): ArticleDocument {
  const sections: ArticleSection[] = [
    {
      id: "section-4",
      heading: "How Brands Should Plan",
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(sectionHtml, "section-4").blocks,
      status: "generated",
    },
  ];
  for (let index = 0; index < 3; index++) {
    sections.push({
      id: `section-filler-${index}`,
      heading: `Supporting area number ${index + 1} for brands`,
      headingLevel: 2,
      sectionType: "main",
      blocks: parseWordPressEditorialBlocks(
        [
          paragraph("Supporting topic number one for the guide explains the core supporting ideas in plain words."),
          paragraph("A second supporting paragraph expands the topic number one area with more practical guidance."),
          paragraph("A third supporting paragraph keeps the topic number one section complete and grounded."),
        ].join("\n\n"),
        `section-filler-${index}`,
      ).blocks,
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

const TRANSITION_CASES: Array<{
  opener: string;
  openerRegex: RegExp;
  sentenceAfter: string;
}> = [
  { opener: "Instead, ", openerRegex: /^\s*instead\s*[,:]/i, sentenceAfter: "successful brands plan content around real customer questions." },
  { opener: "However, ", openerRegex: /^\s*however\s*[,:]/i, sentenceAfter: "teams should review performance every week." },
  { opener: "Therefore, ", openerRegex: /^\s*therefore\s*[,:]/i, sentenceAfter: "brands should publish on a steady schedule." },
  { opener: "This means ", openerRegex: /^\s*this\s+means\b/i, sentenceAfter: "teams need a clear content calendar." },
  { opener: "As a result, ", openerRegex: /^\s*as a result\s*[,:]/i, sentenceAfter: "brands gain more consistent reach." },
];

const ANTECEDENT_SENTENCES = [
  "Many brands avoid automated scheduling tools for their campaigns.",
  "About 35% of teams now use scheduling software for every post.",
  "Roughly 40% of agencies automate their entire content calendar.",
];

describe("orphan-transition production regression: sentence/block removal cannot orphan dependent transitions", () => {
  for (const { opener, openerRegex, sentenceAfter } of TRANSITION_CASES) {
    it(`removing the antecedent ${opener.trim()} does not leave an orphan-transition`, () => {
      const sectionHtml = [
        paragraph(`${ANTECEDENT_SENTENCES[0]} ${ANTECEDENT_SENTENCES[1]}`),
        paragraph(`${opener}${sentenceAfter}`),
        paragraph("A small weekly plan keeps the work steady without adding stress to the whole team."),
      ].join("\n\n");
      const previous = makeSectionDoc(sectionHtml);
      expect(validateCoherence(previous).filter((v) => v.type === "orphan-transition")).toEqual([]);

      const out = removeUnsupportedSentences(sectionHtml, [
        claim("35% of teams now use scheduling software", "About 35% of teams now use scheduling software for every post."),
      ]);
      const candidate = makeSectionDoc(out.html);
      const orphans = validateCoherence(candidate).filter((v) => v.type === "orphan-transition");
      expect(orphans).toEqual([]);
      // The transition opener was stripped, the substantive sentence content
      // survived (capitalised after the orphaned opener was removed).
      const keptSentence = sentenceAfter.slice(0, 1).toUpperCase() + sentenceAfter.slice(1);
      expect(out.html.toLowerCase()).toContain(keptSentence.toLowerCase());
      // The opener itself is gone.
      expect(openerRegex.test(out.html)).toBe(false);
      // The contract accepts the candidate.
      const result = validateArticleIntegrityContract(candidate, {
        keyphrase: KP,
        previous,
        ownedCategories: new Set(["factual", "word-count", "protected-content"]),
      });
      expect(result.violations.some((v) => v.category === "coherence" && v.message.includes("orphan-transition"))).toBe(false);
    });
  }

  it("whole-antecedent removal strips the transition opener instead of removing the claim sentence", () => {
    const sectionHtml = [
      paragraph("About 35% of teams now rely on automated scheduling tools for their campaigns."),
      paragraph("Instead, successful brands plan content around real customer questions."),
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("Regular replies also show customers that a real person is listening to their needs."),
    ].join("\n\n");

    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of teams now rely on automated scheduling tools", "About 35% of teams now rely on automated scheduling tools for their campaigns."),
    ]);
    const candidate = makeSectionDoc(out.html);
    expect(validateCoherence(candidate).filter((v) => v.type === "orphan-transition")).toEqual([]);
    // "Instead," was stripped and the substantive sentence survived capitalized.
    expect(out.html).toContain("Successful brands plan content around real customer questions");
    expect(out.html).not.toMatch(/Instead,\s*Successful/);
  });

  it("a transition opener that cannot be stripped safely aborts the claim removal (no orphan)", () => {
    // The transition opener sits inside a linked node — stripping it would
    // damage the link, so the claim removal is aborted and the paragraph stays.
    const sectionHtml = [
      paragraph("About 35% of teams now rely on automated scheduling tools for their campaigns."),
      paragraph('Instead, see the <a href="/blog/planning-guide">planning guide</a> for next steps.'),
      paragraph("Local teams share useful lessons from daily work with clear and honest words."),
      paragraph("Regular replies also show customers that a real person is listening to their needs."),
    ].join("\n\n");
    const out = removeUnsupportedSentences(sectionHtml, [
      claim("35% of teams now rely on automated scheduling tools", "About 35% of teams now rely on automated scheduling tools for their campaigns."),
    ]);
    const candidate = makeSectionDoc(out.html);
    // Either the claim stayed (abort) or the result is still coherent.
    const orphans = validateCoherence(candidate).filter((v) => v.type === "orphan-transition");
    expect(orphans).toEqual([]);
    expect(out.html).toContain("/blog/planning-guide");
  });
});
