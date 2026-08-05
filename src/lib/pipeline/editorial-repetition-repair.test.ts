import { describe, expect, it, vi } from "vitest";
import {
  countCanonicalVisibleWords,
  fingerprintHtml,
  renderArticleDocument,
  renderFaqSchema,
  type ArticleDocument,
  type EditorialBlock,
  type FaqEntry,
} from "@/lib/blog/article-document";
import {
  applyDeterministicRepetitionFallback,
  findRepetitionPairTargets,
  runEditorialPolish,
  type PolishEdit,
} from "./editorial-polish";
import {
  countRepeatedIdeaPairs,
  findRepeatedIdeaPairs,
} from "@/lib/blog/publication-quality";

const KEY_PHRASE = "threads marketing hong kong";

const INTRO_TEXT =
  "If you run a small business in Hong Kong, you have probably heard about Threads and seen how useful it can be.";
const ECHO_TEXT =
  "If you run a small or medium business in Hong Kong, you have probably heard about Threads and seen how useful it can be. The real question is whether it fits your marketing plan.";
const UNIQUE_TAIL = "The real question is whether it fits your marketing plan.";

// Distinct filler paragraphs keep the fixture large enough that a single
// paragraph rewrite stays within the 10% word-count validation bound.
const FILLER_PARAGRAPHS = [
  "A clear audience helps a small team choose relevant topics and answer useful questions without generic promotional posts.",
  "Posting schedules vary by industry, so review reply patterns for two weeks before committing to a fixed routine.",
  "Local teams often pair short text updates with one clear question that invites customers to share their own experience.",
  "Measuring what works means watching replies, profile visits and saved posts rather than counting impressions alone.",
  "A weekly review of the best performing posts can show which topics deserve a longer follow-up thread.",
  "New followers usually arrive from shares, so a practical tip that people want to forward tends to outperform a polished announcement.",
  "Keeping a running list of customer questions makes it easier to plan posts that genuinely help the next reader.",
  "A simple content calendar that reserves time for replies and follow-ups keeps a small team consistent without extra tools.",
];

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDocument(overrides?: {
  introText?: string;
  sectionTexts?: string[];
}): ArticleDocument {
  const faq: FaqEntry[] = [
    {
      question: "How should an SME start?",
      answerHtml: "<p>Begin with one clear audience and a useful conversation.</p>",
      answerText: "Begin with one clear audience and a useful conversation.",
    },
    {
      question: "What should a team measure?",
      answerHtml: "<p>Measure replies and qualified conversations against the campaign goal.</p>",
      answerText: "Measure replies and qualified conversations against the campaign goal.",
    },
  ];
  const schema = renderFaqSchema(faq);
  const ctaHtml =
    '<!-- wp:html --><div><h2>Ready to grow your brand with Hong Kong creators?</h2><a href="https://app.b2ihub.com/signup">Create Your Free Profile</a></div><!-- /wp:html -->';
  const languageHtml =
    '<!-- wp:html --><div class="b2i-language-switcher"><span>English</span> | <a href="/blog/example-zh">繁體中文</a></div><!-- /wp:html -->';

  return {
    metadata: {
      title: "Threads Marketing Hong Kong: A Practical SME Guide",
      slug: "threads-marketing-hong-kong-guide",
      metaDescription:
        "A practical guide to Threads marketing Hong Kong businesses can use to build useful conversations with local audiences.",
      excerpt: "A practical Threads guide.",
      targetWordCount: 500,
      focusKeyphrase: KEY_PHRASE,
    },
    languageSwitcher: {
      id: "language-switcher",
      type: "language-switcher",
      html: languageHtml,
      fingerprint: fingerprintHtml(languageHtml),
    },
    introduction: {
      id: "introduction",
      status: "generated",
      blocks: [
        paragraph("intro-paragraph", overrides?.introText ?? INTRO_TEXT),
      ],
    },
    sections: [
      {
        id: "section-audience",
        heading: "Why Threads Marketing Hong Kong Teams Need a Clear Audience",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          ...(overrides?.sectionTexts
            ? overrides.sectionTexts.map((text, index) => paragraph(`section-block-${index}`, text))
            : [
                paragraph("section-echo", ECHO_TEXT),
              ]),
          ...FILLER_PARAGRAPHS.map((text, index) => paragraph(`filler-${index}`, text)),
        ],
      },
      {
        id: "faq-heading",
        heading: "Frequently Asked Questions",
        headingLevel: 2,
        sectionType: "faq-heading",
        status: "generated",
        blocks: [],
      },
    ],
    visibleFaq: faq,
    conclusion: {
      id: "conclusion",
      status: "generated",
      blocks: [
        paragraph(
          "conclusion-paragraph",
          "Start with a defined audience and one useful conversation goal, then refine the next post from what customers actually ask.",
        ),
      ],
    },
    cta: {
      id: "cta",
      type: "cta",
      html: ctaHtml,
      fingerprint: fingerprintHtml(ctaHtml),
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: schema,
      fingerprint: fingerprintHtml(schema),
    },
    insertedLinks: [],
  };
}

function edit(
  blockId: string,
  replacementHtml: string,
  reason = "Removed duplicated idea",
): PolishEdit {
  return { blockId, replacementHtml, reason };
}

function response(edits: PolishEdit[]): string {
  return JSON.stringify({ edits });
}

function htmlFor(blockId: string, text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

describe("repetition pair targeting", () => {
  it("detects the structural introduction/section echo and selects the later paragraph", () => {
    const doc = makeDocument();
    const targets = findRepetitionPairTargets(doc);
    expect(targets.length).toBe(1);
    const target = targets[0];
    // The later section paragraph is the replace target.
    expect(target.blockId).toBe("section:section-audience:section-echo");
    expect(target.componentId).toBe("section-audience");
    // The earlier introduction paragraph is preserved.
    expect(target.preserveBlockId).toBe("introduction:introduction:intro-paragraph");
    expect(target.preserveComponentKind).toBe("introduction");
    expect(target.overlap).toBeGreaterThanOrEqual(0.55);
    // The duplicated idea is the echoed opening sentence.
    expect(target.duplicatedIdea).toContain("you have probably heard about Threads");
  });

  it("does not create a repair target when paragraphs share only brands and the keyphrase", () => {
    const doc = makeDocument({
      introText:
        "Meta, Threads and Instagram help Hong Kong small businesses share practical updates with local customers every week.",
      sectionTexts: [
        "Meta, Threads and Instagram each serve a different role for Hong Kong teams, so compare where your audience spends time.",
      ],
    });
    expect(findRepeatedIdeaPairs([
      "Meta, Threads and Instagram help Hong Kong small businesses share practical updates with local customers every week.",
      "Meta, Threads and Instagram each serve a different role for Hong Kong teams, so compare where your audience spends time.",
    ])).toEqual([]);
    expect(findRepetitionPairTargets(doc)).toEqual([]);
  });

  it("does not flag paragraphs that share only the focus keyphrase", () => {
    const texts = [
      "Threads marketing Hong Kong works best when a shop answers customer questions honestly and quickly.",
      "A full Threads marketing Hong Kong plan also covers content formats, reply timing and audience research.",
    ];
    expect(findRepeatedIdeaPairs(texts)).toEqual([]);
  });

  it("does not flag same-subject paragraphs written in materially different language", () => {
    const texts = [
      "Start with one clear audience and choose topics those customers actually ask about.",
      "Begin by naming the people you want to reach, then select subjects they genuinely enquire about.",
    ];
    expect(findRepeatedIdeaPairs(texts)).toEqual([]);
  });

  it("still flags paraphrases that communicate substantially the same idea", () => {
    const texts = [
      "A consistent posting schedule helps a small Hong Kong business stay visible in the Threads feed.",
      "Posting on a consistent schedule keeps a small Hong Kong business visible in the Threads feed.",
    ];
    expect(findRepeatedIdeaPairs(texts).length).toBe(1);
  });

  it("flags the genuine introduction echo even though boilerplate topic words are shared", () => {
    const texts = [
      "If you run a small business in Hong Kong, you have probably heard about Threads and seen how useful it can be.",
      "If you run a small or medium business in Hong Kong, you have probably heard about Threads and seen how useful it can be.",
    ];
    expect(findRepeatedIdeaPairs(texts).length).toBe(1);
  });
});

describe("repetition repair with preserve/replace context", () => {
  it("accepts a rewrite that breaks the overlap and keeps the introduction byte-identical", async () => {
    const doc = makeDocument();
    const targets = findRepetitionPairTargets(doc);
    expect(targets.length).toBe(1);

    const introBefore = renderArticleDocument(doc).match(/<p>If you run a small business[\s\S]*?<\/p>/)?.[0];

    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit("section:section-audience:section-echo", htmlFor("section:section-audience:section-echo", UNIQUE_TAIL), "Replaced the echoed opening with a different transition"),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      mode: "repetition",
      editableBlockIds: targets.map((target) => target.blockId),
      repetitionTargets: targets,
      maxAttempts: 1,
    });

    expect(result.result.accepted).toBe(true);
    const rendered = renderArticleDocument(result.doc);
    expect(rendered).toContain(UNIQUE_TAIL);
    expect(rendered).toContain(INTRO_TEXT);
    // The introduction paragraph is byte-identical.
    expect(rendered.match(/<p>If you run a small business[\s\S]*?<\/p>/)?.[0]).toBe(introBefore);
    // The pair count decreased.
    expect(countRepeatedIdeaPairs([
      INTRO_TEXT,
      UNIQUE_TAIL,
    ])).toBe(0);
  });

  it("rejects a synonym-only rewrite that keeps the overlap above the threshold", async () => {
    const doc = makeDocument();
    const targets = findRepetitionPairTargets(doc);
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          "section:section-audience:section-echo",
          htmlFor(
            "section:section-audience:section-echo",
            "If you operate a small or medium enterprise in Hong Kong, you have likely heard about Threads and seen how useful it can be.",
          ),
          "Synonym-level rewrite",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      mode: "repetition",
      editableBlockIds: targets.map((target) => target.blockId),
      repetitionTargets: targets,
      maxAttempts: 1,
    });
    expect(result.result.accepted).toBe(false);
    expect(result.result.reason).toContain("Repetition overlap validation");
  });

  it("rejects an edit that targets the wrong block", async () => {
    const doc = makeDocument();
    const targets = findRepetitionPairTargets(doc);
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit("section:section-audience:filler-0", htmlFor("section:section-audience:filler-0", UNIQUE_TAIL), "Wrong block edit"),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      mode: "repetition",
      editableBlockIds: targets.map((target) => target.blockId),
      repetitionTargets: targets,
      maxAttempts: 1,
    });
    expect(result.result.accepted).toBe(false);
  });

  it("preserves the focus keyphrase once while removing the unnecessary duplicate", async () => {
    const keyphrasedIntro =
      "If you run a small business in Hong Kong, you have probably heard about Threads marketing Hong Kong and seen how useful it can be.";
    const keyphrasedEcho =
      "If you run a small or medium business in Hong Kong, you have probably heard about Threads marketing Hong Kong and seen how useful it can be. The real question is whether it fits your plan.";
    const doc = makeDocument({
      introText: keyphrasedIntro,
      sectionTexts: [
        keyphrasedEcho,
        "Teams that track their replies over a month can see which questions repeat and turn those into future posts.",
      ],
    });
    const targets = findRepetitionPairTargets(doc);
    expect(targets.length).toBe(1);

    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          "section:section-audience:section-block-0",
          htmlFor(
            "section:section-audience:section-block-0",
            "The real question is whether Threads marketing Hong Kong fits your plan.",
          ),
          "Kept one exact keyphrase occurrence and removed the echoed opening",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      mode: "repetition",
      editableBlockIds: targets.map((target) => target.blockId),
      repetitionTargets: targets,
      maxAttempts: 1,
    });
    expect(result.result.accepted).toBe(true);
    const rendered = renderArticleDocument(result.doc);
    // One exact keyphrase occurrence remains in the replaced block.
    expect(rendered).toContain("Threads marketing Hong Kong fits your plan");
    expect(countRepeatedIdeaPairs([
      keyphrasedIntro,
      "The real question is whether Threads marketing Hong Kong fits your plan.",
    ])).toBe(0);
  });

  it("keeps a protected percentage in the same stable block while reducing repetition", async () => {
    const numberedEcho =
      "If you run a small or medium business in Hong Kong, you have probably heard about Threads and seen how useful it can be. Around 36% of local teams now post weekly.";
    const doc = makeDocument({
      sectionTexts: [
        numberedEcho,
        "Teams that track their replies over a month can see which questions repeat and turn those into future posts.",
      ],
    });
    const targets = findRepetitionPairTargets(doc);
    expect(targets.length).toBe(1);

    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          "section:section-audience:section-block-0",
          htmlFor(
            "section:section-audience:section-block-0",
            "The real question is whether it fits your marketing plan. Around 36% of local teams now post weekly.",
          ),
          "Broke the echo while keeping the percentage sentence",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      mode: "repetition",
      editableBlockIds: targets.map((target) => target.blockId),
      repetitionTargets: targets,
      maxAttempts: 1,
    });
    expect(result.result.accepted).toBe(true);
    const replaced = result.doc.sections[0].blocks.find((block) => block.id === "section-block-0");
    expect(replaced).toBeDefined();
    const text = "content" in replaced! ? replaced.content.map((node) => node.text).join("") : "";
    expect(text).toContain("36%");
    expect(countRepeatedIdeaPairs([
      INTRO_TEXT,
      text,
    ])).toBe(0);
  });
});

describe("bounded deterministic repetition fallback", () => {
  it("activates after failed AI repair, drops the echoed sentence and keeps the unique tail", () => {
    const doc = makeDocument();
    const targets = findRepetitionPairTargets(doc);
    expect(targets.length).toBe(1);

    const result = applyDeterministicRepetitionFallback(doc, targets, {
      minimumWordCount: 100,
      keyphrase: KEY_PHRASE,
    });

    expect(result.applied.length).toBe(1);
    expect(result.applied[0].blockId).toBe("section:section-audience:section-echo");
    expect(result.applied[0].action).toBe("sentences-kept");
    expect(result.applied[0].after).toContain("The real question is whether it fits your marketing plan.");
    expect(result.applied[0].after).not.toContain("you have probably heard about Threads");

    // The introduction remains byte-identical.
    const rendered = renderArticleDocument(result.doc);
    expect(rendered).toContain(INTRO_TEXT);

    // The pair is broken and the article remains structurally valid.
    const replaced = result.doc.sections[0].blocks.find((block) => block.id === "section-echo");
    const text = "content" in replaced! ? replaced.content.map((node) => node.text).join("") : "";
    expect(countRepeatedIdeaPairs([INTRO_TEXT, text])).toBe(0);
    expect(countCanonicalVisibleWords(result.doc)).toBeGreaterThan(100);
  });

  it("removes the later paragraph when every sentence repeats the preserved idea and nothing is protected", () => {
    const pureEchoDoc = makeDocument({
      sectionTexts: [
        "If you run a small or medium business in Hong Kong, you have probably heard about Threads and seen how useful it can be.",
        "Teams that track their replies over a month can see which questions repeat and turn those into future posts.",
      ],
    });
    const targets = findRepetitionPairTargets(pureEchoDoc);
    expect(targets.length).toBe(1);

    const result = applyDeterministicRepetitionFallback(pureEchoDoc, targets, {
      minimumWordCount: 100,
      keyphrase: KEY_PHRASE,
    });

    expect(result.applied.length).toBe(1);
    expect(result.applied[0].action).toBe("removed");
    expect(
      result.doc.sections[0].blocks.some((block) => block.id === "section-block-0"),
    ).toBe(false);
    // Structure remains valid: the section still has its context paragraph.
    expect(result.doc.sections[0].blocks.length).toBeGreaterThan(0);
  });

  it("never drops a number-bearing sentence during the fallback", () => {
    const numberedEcho =
      "If you run a small or medium business in Hong Kong, you have probably heard about Threads and seen how useful it can be. Around 36% of local teams now post weekly.";
    const doc = makeDocument({
      sectionTexts: [
        numberedEcho,
        "Teams that track their replies over a month can see which questions repeat and turn those into future posts.",
      ],
    });
    const targets = findRepetitionPairTargets(doc);
    const result = applyDeterministicRepetitionFallback(doc, targets, {
      minimumWordCount: 100,
      keyphrase: KEY_PHRASE,
    });

    expect(result.applied.length).toBe(1);
    const replaced = result.doc.sections[0].blocks.find((block) => block.id === "section-block-0");
    const text = "content" in replaced! ? replaced.content.map((node) => node.text).join("") : "";
    expect(text).toContain("36%");
    expect(text).not.toContain("you have probably heard about Threads");
  });
});
