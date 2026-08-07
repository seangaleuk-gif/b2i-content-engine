import { describe, expect, it } from "vitest";
import type { ArticleDocument, EditorialBlock } from "@/lib/blog/article-document";
import { renderArticleDocument, countCanonicalVisibleWords } from "@/lib/blog/article-document";
import { getFirstNReadableWords, extractH2Texts } from "@/lib/seo/seo-text-utils";
import { reconcilePostOwnershipKeyphrase } from "./post-ownership-seo-reconcile";
import { buildClaimOwnershipLedger } from "./claim-ownership";
import { computeKeyphraseDensity, englishKeyphraseDensity } from "@/lib/content-standards";
import { countExactPhrase, extractReadableText } from "@/lib/seo/seo-text-utils";

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
