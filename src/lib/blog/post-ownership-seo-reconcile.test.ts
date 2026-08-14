import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { renderArticleDocument, countCanonicalVisibleWords } from "@/lib/blog/article-document";
import { getFirstNReadableWords, extractH2Texts } from "@/lib/seo/seo-text-utils";
import {
  buildNaturalHeading,
  enforceEditorialH2Keyphrase,
  reconcilePostOwnershipKeyphrase,
} from "./post-ownership-seo-reconcile";
import { buildClaimOwnershipLedger } from "./claim-ownership";
import { computeKeyphraseDensity, englishKeyphraseDensity } from "@/lib/content-standards";
import { countExactPhrase, extractReadableText } from "@/lib/seo/seo-text-utils";
import { assessHeadingNaturalness, assessHeadingTextNaturalness } from "@/lib/blog/content-relevance";

const KEYPHRASE = "threads marketing hong kong";
const RESEARCH = [
  {
    title: "Hong Kong Threads audience",
    snippet: "Threads has 2.4 million monthly active users in Hong Kong.",
    url: "https://example.com/audience",
  },
];

const PROSE_SENTENCES = [
  "A simple marketing plan helps a small business stay consistent and clear.",
  "Local owners can list the questions customers actually ask every week.",
  "Turning those questions into short posts builds trust over time.",
  "A weekly routine keeps the work steady without adding extra stress.",
  "Reviews and replies show that a real person is listening to needs.",
  "Measuring profile visits and messages shows which ideas are working.",
  "Consistency matters more than a single perfect post or large budget.",
  "A clear voice helps a local business stand out in a busy market.",
  "Small steps, repeated regularly, create steady and honest growth.",
  "Focus on the people you serve and the results will follow naturally.",
];

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function proseBlocks(idPrefix: string, count: number): EditorialBlock[] {
  const blocks: EditorialBlock[] = [];
  for (let index = 0; index < count; index++) {
    const first = PROSE_SENTENCES[(index * 2) % PROSE_SENTENCES.length];
    const second = PROSE_SENTENCES[(index * 2 + 1) % PROSE_SENTENCES.length];
    blocks.push(paragraph(`${idPrefix}-${index}`, `${first} ${second}`));
  }
  return blocks;
}

function makeDocument(options?: {
  keyphraseInH2?: boolean;
  keyphraseInFirst100?: boolean;
}): ArticleDocument {
  const kp = KEYPHRASE;
  const heading = options?.keyphraseInH2
    ? `Threads Marketing Hong Kong: A Practical Local Guide`
    : "Practical Content Plans for Local Teams";
  const introFirst = options?.keyphraseInFirst100
    ? `This guide to ${kp} gives local owners a clear place to start.`
    : "This guide gives local owners a clear place to start with a focused plan.";
  return {
    metadata: {
      title: "Threads Marketing Hong Kong Guide",
      slug: "threads-marketing-hong-kong",
      metaDescription: "A practical guide.",
      excerpt: "A practical guide.",
      targetWordCount: 2500,
      focusKeyphrase: kp,
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      status: "generated",
      blocks: [
        paragraph("intro-1", `${introFirst} Keep the routine small and honest so it stays sustainable.`),
        ...proseBlocks("intro", 6),
      ],
    },
    sections: [
      {
        id: "section-0",
        heading,
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph("s0-1", "A clear audience profile helps a small team choose the right conversations."),
          ...proseBlocks("s0", 8),
        ],
      },
      {
        id: "section-1",
        heading: "Measure Results and Improve",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          paragraph("s1-1", "Review profile visits and replies to see which ideas are working."),
          ...proseBlocks("s1", 8),
        ],
      },
      {
        id: "faq",
        heading: "Frequently Asked Questions",
        headingLevel: 2,
        sectionType: "faq-heading",
        status: "generated",
        blocks: [],
      },
    ],
    visibleFaq: [
      {
        question: "How should a local team start?",
        answerHtml: "",
        answerText: "Start with one useful topic and improve it from real replies.",
      },
    ],
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: [paragraph("conc-1", "Start with one useful topic and improve it from real replies."), ...proseBlocks("conc", 4)],
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("post-ownership SEO reconciliation", () => {
  it("does not create a duplicated-location H2 while restoring a soft SEO placement", () => {
    const heading = "Hong Kong Digital Marketing Strategy";
    const keyphrase = "hong kong marketing trends 2026";
    expect(buildNaturalHeading(heading, keyphrase)).toBe(heading);
  });

  it("restores the exact keyphrase in one H2 and the first 100 words", () => {
    const doc = makeDocument();
    const result = reconcilePostOwnershipKeyphrase(doc, KEYPHRASE, RESEARCH);

    expect(result.h2KeyphraseRestored).toBe(true);
    expect(result.first100KeyphraseRestored).toBe(true);
    expect(result.changedComponentIds.length).toBeGreaterThanOrEqual(1);

    const html = renderArticleDocument(doc);
    const h2Texts = extractH2Texts(html);
    expect(h2Texts.some((h) => h.toLowerCase().includes(KEYPHRASE))).toBe(true);
    const first100 = getFirstNReadableWords(html, 100).toLowerCase();
    expect(first100.includes(KEYPHRASE)).toBe(true);
  });

  it("keeps keyphrase density inside 0.5%–3% after restoration", () => {
    const { warningBelow, stuffingAbove } = englishKeyphraseDensity();
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = makeDocument();
      reconcilePostOwnershipKeyphrase(doc, KEYPHRASE, RESEARCH);
      const html = renderArticleDocument(doc);
      const count = countExactPhrase(extractReadableText(html), KEYPHRASE);
      const density = computeKeyphraseDensity(count, KEYPHRASE, countCanonicalVisibleWords(doc));
      expect(density).toBeGreaterThanOrEqual(warningBelow);
      expect(density).toBeLessThanOrEqual(stuffingAbove);
    }
  });

  it("leaves an already-compliant article unchanged", () => {
    const doc = makeDocument({ keyphraseInH2: true, keyphraseInFirst100: true });
    const before = renderArticleDocument(doc);
    const result = reconcilePostOwnershipKeyphrase(doc, KEYPHRASE, RESEARCH);
    expect(result.h2KeyphraseRestored).toBe(false);
    expect(result.first100KeyphraseRestored).toBe(false);
    expect(result.changedComponentIds).toEqual([]);
    expect(renderArticleDocument(doc)).toBe(before);
  });

  it("never introduces ownership violations or unsupported claims", () => {
    const doc = makeDocument();
    const ledger = buildClaimOwnershipLedger(
      doc.sections.map((s) => ({ id: s.id, heading: s.heading, sectionType: s.sectionType })),
      RESEARCH,
    );
    const result = reconcilePostOwnershipKeyphrase(doc, KEYPHRASE, RESEARCH, ledger);
    expect(result.ownershipViolationsAfter).toBe(0);
  });

  it("does not touch protected blocks (CTA, switcher, FAQ/schema, links)", () => {
    const doc = makeDocument();
    const ctaHtml = '<!-- wp:html --><div class="cta"><h2>Ready to grow?</h2><a href="https://app.b2ihub.com/signup">Go</a></div><!-- /wp:html -->';
    doc.cta = { id: "cta", type: "cta", html: ctaHtml, fingerprint: "cta" };
    const switcherHtml = '<!-- wp:html --><div class="b2i-language-switcher"><span>English</span></div><!-- /wp:html -->';
    doc.languageSwitcher = { id: "ls", type: "language-switcher", html: switcherHtml, fingerprint: "ls" };
    const faqBefore = doc.visibleFaq[0].answerText;
    const schemaHtml = '<!-- wp:html --><script type="application/ld+json">{"@type":"FAQPage"}</script><!-- /wp:html -->';
    doc.faqSchema = { id: "faq-schema", type: "faq-schema", html: schemaHtml, fingerprint: "schema" };

    reconcilePostOwnershipKeyphrase(doc, KEYPHRASE, RESEARCH);

    expect(doc.cta!.html).toBe(ctaHtml);
    expect(doc.languageSwitcher!.html).toBe(switcherHtml);
    expect(doc.faqSchema!.html).toBe(schemaHtml);
    expect(doc.visibleFaq[0].answerText).toBe(faqBefore);
  });
});

// ── Authoritative save-boundary editorial-H2 enforcement ──

const TREND_KEYPHRASE = "hong kong marketing trends 2026";

function trendDoc(options?: {
  editorialKeyphraseHeading?: boolean;
  faqKeyphraseHeading?: boolean;
  firstHeading?: string;
}): ArticleDocument {
  const editorialHeading = options?.firstHeading
    ?? (options?.editorialKeyphraseHeading
      ? "Hong Kong Marketing Trends 2026: The State of Digital Marketing"
      : "The State of Digital Marketing in Hong Kong for 2026");
  const faqHeading = options?.faqKeyphraseHeading
    ? "Frequently Asked Questions About Hong Kong Marketing Trends 2026"
    : "Frequently Asked Questions";
  return {
    metadata: {
      title: "Hong Kong Marketing Trends 2026: What You Need to Know",
      slug: "hong-kong-marketing-trends-2026",
      metaDescription: "The Hong Kong marketing trends 2026 landscape and what it means for local teams.",
      excerpt: "A practical guide.",
      targetWordCount: 2500,
      focusKeyphrase: TREND_KEYPHRASE,
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      status: "generated",
      blocks: [
        paragraph("intro-1", "Local teams can plan their content around the Hong Kong marketing trends 2026 landscape."),
        ...proseBlocks("intro", 4),
      ],
    },
    sections: [
      {
        id: "section-0",
        heading: editorialHeading,
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [...proseBlocks("s0", 8)],
      },
      {
        id: "section-1",
        heading: "AI and Automation Reshape Campaigns",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [...proseBlocks("s1", 8)],
      },
      {
        id: "section-2",
        heading: "Data Privacy and First-Party Data",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [...proseBlocks("s2", 8)],
      },
      {
        id: "faq",
        heading: faqHeading,
        headingLevel: 2,
        sectionType: "faq-heading",
        status: "generated",
        blocks: [],
      },
    ],
    visibleFaq: [
      {
        question: "What is driving the Hong Kong marketing trends 2026?",
        answerHtml: "",
        answerText: "Consumer behaviour shifts and the growing role of digital platforms are the main drivers.",
      },
    ],
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: [...proseBlocks("conc", 4)],
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

describe("authoritative editorial-H2 keyphrase enforcement", () => {
  it("fails the editorial-H2 check when the keyphrase appears only in the FAQ heading", () => {
    const doc = trendDoc({ faqKeyphraseHeading: true });
    const faqHeadingBefore = doc.sections.find((s) => s.sectionType === "faq-heading")!.heading;
    const editorialBefore = doc.sections
      .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
      .map((s) => s.heading);
    expect(editorialBefore.some((h) => h.toLowerCase().includes(TREND_KEYPHRASE))).toBe(false);

    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);

    // The check detects the missing editorial placement and repairs it.
    expect(result.satisfied).toBe(true);
    expect(result.changedSectionId).not.toBeNull();
    const repaired = doc.sections.find((s) => s.id === result.changedSectionId)!;
    expect(repaired.heading.toLowerCase()).toContain(TREND_KEYPHRASE);
    // The FAQ heading never satisfies the editorial-H2 rule and stays intact.
    expect(doc.sections.find((s) => s.sectionType === "faq-heading")!.heading).toBe(faqHeadingBefore);
  });

  it("repairs a missing editorial H2 naturally with the exact keyphrase", () => {
    const doc = trendDoc();
    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    expect(result.satisfied).toBe(true);
    expect(result.headingAfter).toBe("Hong Kong Marketing Trends 2026: The State of Digital Marketing");
    const editorialHeadings = doc.sections
      .filter((s) => s.sectionType !== "faq-heading" && s.sectionType !== "conclusion-heading")
      .map((s) => s.heading);
    expect(editorialHeadings.some((h) => h.toLowerCase().includes(TREND_KEYPHRASE))).toBe(true);
    expect(assessHeadingNaturalness(doc, TREND_KEYPHRASE)).toEqual([]);
  });

  it("excludes FAQ and CTA headings from the editorial-H2 requirement", () => {
    const doc = trendDoc({ faqKeyphraseHeading: true });
    const ctaHtml = '<!-- wp:html --><div class="cta"><h2>Ready to grow?</h2><a href="https://app.b2ihub.com/signup">Go</a></div><!-- /wp:html -->';
    doc.cta = { id: "cta", type: "cta", html: ctaHtml, fingerprint: "cta" };
    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    expect(result.satisfied).toBe(true);
    expect(doc.cta!.html).toBe(ctaHtml);
    expect(doc.sections.find((s) => s.sectionType === "faq-heading")!.heading)
      .toBe("Frequently Asked Questions About Hong Kong Marketing Trends 2026");
  });

  it("rejects a duplicated topic/year keyphrase heading that cannot be repaired safely", () => {
    const doc = trendDoc({ firstHeading: "The State of Digital Marketing in Hong Kong for 2026: Hong Kong Marketing Trends 2026" });
    // The duplicated construction is unnatural before enforcement.
    expect(assessHeadingTextNaturalness(doc.sections[0].heading, TREND_KEYPHRASE, doc.sections[0].id).length).toBeGreaterThan(0);

    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    // The natural reconciliation helpers refuse to drop a distinct colon topic
    // ("Trends"), so this duplicated concatenation cannot be repaired safely.
    // The guarantee must fail closed — persistence stays blocked.
    expect(result.satisfied).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(doc.sections[0].heading)
      .toBe("The State of Digital Marketing in Hong Kong for 2026: Hong Kong Marketing Trends 2026");
  });

  it("leaves a compliant article unchanged", () => {
    const doc = trendDoc({ editorialKeyphraseHeading: true });
    const before = renderArticleDocument(doc);
    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    expect(result.satisfied).toBe(true);
    expect(result.changedSectionId).toBeNull();
    expect(result.changedHeading).toBeNull();
    expect(renderArticleDocument(doc)).toBe(before);
  });

  it("keeps CTA, FAQ/schema, links, structure and word count unchanged when it repairs", () => {
    const doc = trendDoc();
    const faqBefore = doc.visibleFaq[0].answerText;
    const wcBefore = countCanonicalVisibleWords(doc);
    doc.cta = { id: "cta", type: "cta", html: '<!-- wp:html --><div class="cta"><h2>Ready?</h2><a href="https://app.b2ihub.com/signup">Go</a></div><!-- /wp:html -->', fingerprint: "cta" };
    doc.languageSwitcher = { id: "ls", type: "language-switcher", html: '<!-- wp:html --><div class="b2i-language-switcher"><span>English</span></div><!-- /wp:html -->', fingerprint: "ls" };
    const ctaBefore = doc.cta!.html;
    const switcherBefore = doc.languageSwitcher!.html;

    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    expect(result.satisfied).toBe(true);

    expect(doc.cta!.html).toBe(ctaBefore);
    expect(doc.languageSwitcher!.html).toBe(switcherBefore);
    expect(doc.visibleFaq[0].answerText).toBe(faqBefore);
    // Word count only changes by the heading word delta and the introduction,
    // FAQ, schema and link surfaces are untouched.
    expect(doc.visibleFaq).toHaveLength(1);
    expect(renderArticleDocument(doc).match(/app\.b2ihub\.com\/signup/g) ?? []).toHaveLength(1);
    expect(Math.abs(countCanonicalVisibleWords(doc) - wcBefore)).toBeLessThanOrEqual(3);
    // The repaired heading is the only structural difference.
    const after = renderArticleDocument(doc);
    const afterHeadings = extractH2Texts(after);
    expect(afterHeadings.some((h) => h.toLowerCase().includes(TREND_KEYPHRASE))).toBe(true);
  });

  it("reports natural-repair-unavailable without mutating (soft)", () => {
    // A heading with a repeated year that no natural repair can fix (the
    // keyphrase year collides with an existing year on both sides). The
    // function reports the outcome but must never force an awkward heading.
    const doc = trendDoc({ firstHeading: "Budgeting for 2026 in Hong Kong for 2026" });
    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    expect(result.satisfied).toBe(false);
    expect(result.reasons).toContain("natural repair could not produce a keyphrase-bearing editorial H2");
    // The document is left unmodified — no partial repair and no throw.
    expect(doc.sections[0].heading).toBe("Budgeting for 2026 in Hong Kong for 2026");
  });

  it("keeps a natural but unrepairable editorial H2 unchanged (soft)", () => {
    // "Budgeting for 2026 in Hong Kong" is natural yet cannot be naturally
    // combined with the exact keyphrase without a duplicated location. This is
    // the production-shaped case: satisfied=false must not mutate or throw.
    const doc = trendDoc({ firstHeading: "Budgeting for 2026 in Hong Kong" });
    expect(assessHeadingTextNaturalness(doc.sections[0].heading, TREND_KEYPHRASE, doc.sections[0].id)).toEqual([]);
    const before = renderArticleDocument(doc);
    const result = enforceEditorialH2Keyphrase(doc, TREND_KEYPHRASE);
    expect(result.satisfied).toBe(false);
    expect(result.reasons).toContain("natural repair could not produce a keyphrase-bearing editorial H2");
    expect(renderArticleDocument(doc)).toBe(before);
    expect(doc.sections[0].heading).toBe("Budgeting for 2026 in Hong Kong");
  });
});
