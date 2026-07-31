import { afterEach, describe, expect, it, vi } from "vitest";
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
  applyEdits,
  buildPolishPrompt,
  buildSectionSummaries,
  countExactKeyphrase,
  detectMalformedProse,
  extractAllLinks,
  findMalformedEditableBlocks,
  extractEditableBlocks,
  extractNumericClaims,
  findProseOnlyEditableBlockIds,
  findRepeatedEditableBlockIds,
  findWeakenedEditableBlockIds,
  isEditorialPolishEnabled,
  normalizeLinkSpacing,
  repairDeterministicMalformedProse,
  runEditorialPolish,
  validateCandidate,
  type PolishEdit,
} from "./editorial-polish";

const KEY_PHRASE = "threads marketing hong kong";

function paragraph(id: string, text: string): EditorialBlock {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeDocument(): ArticleDocument {
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
        paragraph(
          "intro-paragraph",
          "Threads marketing Hong Kong teams use effectively begins with useful conversation, not a stream of announcements. This guide shows small teams how to plan those conversations with a clear commercial purpose.",
        ),
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
          paragraph(
            "audience-paragraph-one",
            "A clear audience helps a small team choose relevant topics, answer useful questions, and avoid generic promotional posts that give readers no reason to reply.",
          ),
          paragraph(
            "audience-paragraph-two",
            "A clear audience helps a small team choose relevant topics, answer useful questions, and avoid generic promotional posts that give readers no reason to reply.",
          ),
          {
            id: "audience-h3",
            type: "subheading",
            level: 3,
            content: [{ type: "text", text: "Turn audience knowledge into useful prompts" }],
          },
          {
            id: "audience-list",
            type: "list",
            ordered: false,
            items: [
              [{ type: "text", text: "Write down the questions customers ask before buying." }],
              [{ type: "text", text: "Choose one question that invites a practical reply." }],
            ],
          },
        ],
      },
      {
        id: "section-links",
        heading: "Build Conversations That Support a Business Goal",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [
          {
            id: "linked-paragraph",
            type: "paragraph",
            content: [
              { type: "text", text: "Read the official guidance for business in" },
              {
                type: "link",
                text: "Hong Kong",
                href: "https://www.example.com/research",
                sourceType: "editorial-external",
              },
              { type: "text", text: "before setting a campaign objective." },
            ],
          },
          paragraph(
            "measurement-paragraph",
            "Choose a response that matters to the business, then review whether the discussion produced useful questions, relevant enquiries, or clearer customer language.",
          ),
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
          "Start with a defined audience and one useful conversation goal. Review real replies, keep the strongest themes, and refine the next post from what customers actually ask.",
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

function blockByText(doc: ArticleDocument, text: string) {
  const block = extractEditableBlocks(doc).find((item) => item.html.includes(text));
  if (!block) throw new Error(`Editable block not found: ${text}`);
  return block;
}

function edit(
  blockId: string,
  replacementHtml: string,
  reason = "Improved clarity",
): PolishEdit {
  return { blockId, replacementHtml, reason };
}

function response(edits: PolishEdit[]): string {
  return JSON.stringify({ edits });
}

afterEach(() => {
  delete process.env.ENABLE_EDITORIAL_POLISH;
});

describe("editorial feature flag and extraction", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(isEditorialPolishEnabled()).toBe(false);
    process.env.ENABLE_EDITORIAL_POLISH = "true";
    expect(isEditorialPolishEnabled()).toBe(true);
  });

  it("extracts paragraphs, list text and existing H3s with stable opaque IDs", () => {
    const doc = makeDocument();
    const first = extractEditableBlocks(doc);
    const second = extractEditableBlocks(structuredClone(doc));
    expect(first.map((item) => item.blockId)).toEqual(second.map((item) => item.blockId));
    expect(first.some((item) => item.type === "paragraph")).toBe(true);
    expect(first.some((item) => item.type === "list")).toBe(true);
    expect(first.some((item) => item.type === "subheading")).toBe(true);
    expect(first.some((item) => item.blockId.startsWith("introduction:"))).toBe(true);
    expect(first.some((item) => item.blockId.startsWith("conclusion:"))).toBe(true);
    expect(first.every((item) => !item.blockId.includes("faq-heading"))).toBe(true);
  });

  it("can scope a targeted repair to only the supplied block IDs", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const editable = extractEditableBlocks(doc, [], [target.blockId]);
    expect(editable.map((item) => item.blockId)).toEqual([target.blockId]);
  });

  it("selects only the weaker occurrence from each repeated idea cluster", () => {
    const doc = makeDocument();
    const repeated = findRepeatedEditableBlockIds(doc);
    const duplicates = extractEditableBlocks(doc)
      .filter((item) => item.html.includes("A clear audience helps"))
      .map((item) => item.blockId);
    expect(duplicates).toHaveLength(2);
    expect(repeated).toHaveLength(1);
    expect(duplicates).toContain(repeated[0]);
  });

  it("excludes evidence-locked blocks from the AI request", () => {
    const doc = makeDocument();
    const factual = blockByText(doc, "A clear audience helps");
    const editable = extractEditableBlocks(doc, [factual.blockId]);
    expect(editable.some((item) => item.blockId === factual.blockId)).toBe(false);
    expect(editable.length).toBe(extractEditableBlocks(doc).length - 1);
  });

  it("scopes the prose-only fallback to fact-free blocks", () => {
    const doc = makeDocument();
    doc.sections[0].blocks.push(
      paragraph("numeric-paragraph", "The campaign reached 25% more people after the change."),
    );
    const ids = findProseOnlyEditableBlockIds(doc, KEY_PHRASE, [], {});
    const linked = blockByText(doc, "official guidance");
    const numeric = blockByText(doc, "25% more people");
    const ordinary = blockByText(doc, "response that matters");
    expect(ids).not.toContain(linked.blockId);
    expect(ids).not.toContain(numeric.blockId);
    expect(ids).toContain(ordinary.blockId);
  });

  it("targets only abrupt fact-free blocks in components weakened by cleanup", () => {
    const doc = makeDocument();
    doc.sections[0].blocks.push(
      paragraph("abrupt-paragraph", "However, this needs a clearer transition."),
    );
    doc.sections[1].blocks.push(
      paragraph("unaffected-short", "However, this other section was not changed."),
    );
    const ids = findWeakenedEditableBlockIds(
      doc,
      ["section-audience"],
      KEY_PHRASE,
      [],
      {},
    );
    expect(ids).toContain(blockByText(doc, "clearer transition").blockId);
    expect(ids).not.toContain(blockByText(doc, "other section was not changed").blockId);
  });

  it("gives the editor article-wide section memory without FAQ copy", () => {
    const summaries = buildSectionSummaries(makeDocument());
    expect(summaries[0].heading).toBe("Introduction");
    expect(summaries.at(-1)?.heading).toBe("Conclusion");
    expect(summaries.some((item) => /Frequently Asked Questions/i.test(item.heading))).toBe(false);
  });

  it("prompts for structured edits and explicitly protects facts, URLs and structure", () => {
    const doc = makeDocument();
    const messages = buildPolishPrompt({
      blocks: extractEditableBlocks(doc),
      sectionSummaries: buildSectionSummaries(doc),
      keyphrase: KEY_PHRASE,
      title: doc.metadata.title,
      metaDescription: doc.metadata.metaDescription,
    });
    const prompt = messages.map((message) => message.content).join("\n");
    expect(prompt).toContain('"edits"');
    expect(prompt).toContain("Preserve every href exactly");
    expect(prompt).toContain("Do not invent facts");
    expect(prompt).toContain("Do not add, remove, merge, split or reorder blocks");
  });

  it("explains the fact-free fallback boundary to the editor", () => {
    const doc = makeDocument();
    const messages = buildPolishPrompt({
      blocks: extractEditableBlocks(doc),
      sectionSummaries: buildSectionSummaries(doc),
      keyphrase: KEY_PHRASE,
      title: doc.metadata.title,
      metaDescription: doc.metadata.metaDescription,
      mode: "prose-only",
    });
    const prompt = messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("fact-free editorial fallback");
    expect(prompt).toContain("raise the article to its editorial quality threshold");
  });
});

describe("deterministic safeguards", () => {
  it("preserves spaces around inline anchors in parser-owned content", async () => {
    const doc = makeDocument();
    const ai = vi.fn().mockResolvedValue({ content: response([]) });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(true);
    expect(result.result.spacingFixesApplied).toBe(2);
    expect(renderArticleDocument(result.doc)).toContain(
      'business in <a href="https://www.example.com/research">Hong Kong</a> before',
    );
  });

  it("repairs raw anchor spacing deterministically", () => {
    expect(
      normalizeLinkSpacing('business in<a href="https://example.com">Hong Kong</a>today'),
    ).toBe('business in <a href="https://example.com">Hong Kong</a> today');
  });

  it("collects links in exact order and classifies their destinations", () => {
    const links = extractAllLinks(makeDocument());
    expect(links.map((item) => item.href)).toEqual(["https://www.example.com/research"]);
    expect(links[0].isInternal).toBe(false);
  });

  it("counts only visible numeric expressions, not WordPress heading levels", () => {
    expect(
      extractNumericClaims(
        '<!-- wp:heading {"level":3} --><h3>Plan for 5% growth</h3><!-- /wp:heading -->',
      ),
    ).toEqual(["5%"]);
  });

  it("uses the canonical document word counter", () => {
    const doc = makeDocument();
    const result = validateCandidate(doc, structuredClone(doc), KEY_PHRASE);
    expect(result.passed).toBe(true);
    expect(countCanonicalVisibleWords(doc)).toBeGreaterThan(0);
  });

  it("detects malformed fragments before commit", () => {
    const doc = makeDocument();
    doc.sections[0].blocks[0] = paragraph(
      "broken",
      'Threads rewards conversation. " instead of listing products.',
    );
    expect(detectMalformedProse(doc).some((issue) => issue.includes("quotation"))).toBe(true);
  });


  it("resolves malformed prose to stable block IDs and exact issue labels", () => {
    const doc = makeDocument();
    doc.sections[1].blocks[1] = paragraph(
      "broken-ending",
      "Choose a useful response before publishing. Avoid ending the plan with.",
    );
    const issues = findMalformedEditableBlocks(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0].blockId).toContain("broken-ending");
    expect(issues[0].issues).toContain("incomplete sentence ending");
    expect(detectMalformedProse(doc)[0]).toContain(issues[0].blockId);
  });

  it("deterministically trims only the trailing broken sentence", () => {
    const doc = makeDocument();
    doc.sections[1].blocks[1] = paragraph(
      "broken-ending",
      "Choose a useful response before publishing. Avoid ending the plan with.",
    );
    const result = repairDeterministicMalformedProse(doc, 1);
    expect(result.repairedBlockIds).toHaveLength(1);
    expect(result.removedBlockIds).toHaveLength(0);
    expect(findMalformedEditableBlocks(doc)).toHaveLength(0);
    expect(renderArticleDocument(doc)).toContain("Choose a useful response before publishing.");
    expect(renderArticleDocument(doc)).not.toContain("Avoid ending the plan with.");
  });

  it("removes a short evidence-free malformed paragraph when trimming is impossible", () => {
    const doc = makeDocument();
    doc.sections[1].blocks[1] = paragraph(
      "broken-only",
      "A campaign plan should finish with.",
    );
    const result = repairDeterministicMalformedProse(doc, 1, {}, true);
    expect(result.removedBlockIds).toHaveLength(1);
    expect(findMalformedEditableBlocks(doc)).toHaveLength(0);
    expect(renderArticleDocument(doc)).not.toContain("finish with.");
  });

  it("includes stable malformed issue ownership in the targeted prompt", () => {
    const doc = makeDocument();
    doc.sections[1].blocks[1] = paragraph("broken-ending", "A campaign plan should finish with.");
    const target = findMalformedEditableBlocks(doc)[0];
    const prompt = buildPolishPrompt({
      blocks: extractEditableBlocks(doc, [], [target.blockId]),
      sectionSummaries: buildSectionSummaries(doc),
      keyphrase: KEY_PHRASE,
      title: doc.metadata.title,
      metaDescription: doc.metadata.metaDescription,
      mode: "malformed",
      malformedIssuesByBlockId: { [target.blockId]: target.issues },
    }).map((message) => message.content).join("\n");
    expect(prompt).toContain("targeted malformed-prose repair pass");
    expect(prompt).toContain(target.blockId);
    expect(prompt).toContain("incomplete sentence ending");
  });
});

describe("targeted malformed-prose repair", () => {
  it("retries with stable block IDs and commits only when every malformed block is repaired", async () => {
    const doc = makeDocument();
    doc.sections[0].blocks[0] = paragraph(
      "broken-quote-one",
      'A clear audience prevents generic posts. "This unfinished fragment needs repair.',
    );
    doc.sections[1].blocks[1] = paragraph(
      "broken-quote-two",
      'Measure useful replies before changing direction. "This second fragment also needs repair.',
    );
    const malformed = findMalformedEditableBlocks(doc);
    const first = malformed[0];
    const second = malformed[1];
    const firstFix = edit(
      first.blockId,
      "<!-- wp:paragraph --><p>A clear audience prevents generic posts. This gives each discussion a specific purpose.</p><!-- /wp:paragraph -->",
      "Completed the unfinished fragment",
    );
    const secondFix = edit(
      second.blockId,
      "<!-- wp:paragraph --><p>Measure useful replies before changing direction. This keeps the next decision tied to the campaign goal.</p><!-- /wp:paragraph -->",
      "Completed the unfinished fragment",
    );
    const ai = vi.fn()
      .mockResolvedValueOnce({ content: response([firstFix]) })
      .mockResolvedValueOnce({ content: response([firstFix, secondFix]) });

    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      maxAttempts: 2,
      editableBlockIds: malformed.map((issue) => issue.blockId),
      mode: "malformed",
      malformedIssuesByBlockId: Object.fromEntries(
        malformed.map((issue) => [issue.blockId, issue.issues]),
      ),
    });

    expect(result.result.accepted).toBe(true);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1][0].at(-1)?.content).toContain(second.blockId);
    expect(findMalformedEditableBlocks(result.doc)).toHaveLength(0);
    expect(renderArticleDocument(doc)).toContain("unfinished fragment");
  });
});

describe("atomic edit application", () => {
  it("commits a valid paragraph replacement to a clone", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const candidate = applyEdits(doc, [
      edit(
        target.blockId,
        "<!-- wp:paragraph --><p>Define the response the business needs, then compare replies with that objective and record the customer language worth using next.</p><!-- /wp:paragraph -->",
      ),
    ]);
    expect(candidate).not.toBe(doc);
    expect(renderArticleDocument(candidate)).toContain("Define the response");
    expect(renderArticleDocument(doc)).not.toContain("Define the response");
  });

  it("rejects an unknown or protected block ID", () => {
    expect(() =>
      applyEdits(makeDocument(), [
        edit(
          "faq:protected:answer",
          "<!-- wp:paragraph --><p>Changed FAQ.</p><!-- /wp:paragraph -->",
        ),
      ]),
    ).toThrow(/Unknown or protected/);
  });

  it("rejects duplicate targets instead of applying a partial proposal", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const replacement =
      "<!-- wp:paragraph --><p>Define the useful business response, then assess each discussion against that objective and record what the audience asks.</p><!-- /wp:paragraph -->";
    expect(() =>
      applyEdits(doc, [
        edit(target.blockId, replacement),
        edit(target.blockId, replacement),
      ]),
    ).toThrow(/Duplicate edit/);
  });

  it("allows better anchor wording while preserving the exact href", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "official guidance");
    const candidate = applyEdits(doc, [
      edit(
        target.blockId,
        '<!-- wp:paragraph --><p>Read the official guidance for business in <a href="https://www.example.com/research">Hong Kong business guidance</a> before setting a campaign objective.</p><!-- /wp:paragraph -->',
      ),
    ]);
    expect(extractAllLinks(candidate).map((item) => item.href)).toEqual(
      extractAllLinks(doc).map((item) => item.href),
    );
  });

  it("rejects changed href values or link counts", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "official guidance");
    expect(() =>
      applyEdits(doc, [
        edit(
          target.blockId,
          '<!-- wp:paragraph --><p>Review <a href="https://evil.example">this source</a> before planning.</p><!-- /wp:paragraph -->',
        ),
      ]),
    ).toThrow(/href values or link count changed/);
  });

  it("rejects added, removed or changed numeric facts", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    expect(() =>
      applyEdits(doc, [
        edit(
          target.blockId,
          "<!-- wp:paragraph --><p>Set a 10% engagement target before reviewing replies.</p><!-- /wp:paragraph -->",
        ),
      ]),
    ).toThrow(/numeric facts changed/);
  });

  it("allows surrounding prose to improve while preserving the exact factual sentence", () => {
    const doc = makeDocument();
    doc.sections[1].blocks.push(
      paragraph(
        "fact-with-context",
        "Small teams should define the purpose before publishing. According to Marketing-Interactive, awareness reached 66% in 2025.",
      ),
    );
    const target = blockByText(doc, "define the purpose");
    const candidate = applyEdits(doc, [
      edit(
        target.blockId,
        "<!-- wp:paragraph --><p>Choose the business outcome before drafting the first post. According to Marketing-Interactive, awareness reached 66% in 2025.</p><!-- /wp:paragraph -->",
      ),
    ]);
    expect(renderArticleDocument(candidate)).toContain("Choose the business outcome");
    expect(renderArticleDocument(candidate)).toContain(
      "According to Marketing-Interactive, awareness reached 66% in 2025.",
    );
  });

  it("keeps decimal factual sentences intact while editing surrounding prose", () => {
    const doc = makeDocument();
    const factualSentence = "Hong Kong had 2.4 million monthly active Threads users in 2025.";
    doc.sections[1].blocks.push(
      paragraph("decimal-fact", `${factualSentence} The surrounding explanation can be improved.`),
    );
    const target = blockByText(doc, "2.4 million");
    const candidate = applyEdits(
      doc,
      [edit(
        target.blockId,
        `<!-- wp:paragraph --><p>${factualSentence} Businesses can improve the explanation without changing the verified fact.</p><!-- /wp:paragraph -->`,
      )],
      [],
      undefined,
      { [target.blockId]: [factualSentence] },
    );
    expect(renderArticleDocument(candidate)).toContain("Businesses can improve");
    expect(renderArticleDocument(candidate)).toContain(factualSentence);
  });

  it("rejects a semantic rewrite even when it preserves the same number", () => {
    const doc = makeDocument();
    doc.sections[1].blocks.push(
      paragraph("numeric-fact", "The saved research reports 10% growth for this segment."),
    );
    const target = blockByText(doc, "reports 10% growth");
    expect(() =>
      applyEdits(doc, [
        edit(
          target.blockId,
          "<!-- wp:paragraph --><p>The saved research disproves 10% growth for this segment.</p><!-- /wp:paragraph -->",
        ),
      ]),
    ).toThrow(/sentence containing a number/);
  });

  it("rejects block-type changes and malformed WordPress blocks", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    expect(() =>
      applyEdits(doc, [
        edit(
          target.blockId,
          '<!-- wp:list {"ordered":false} --><ul><li>Changed</li></ul><!-- /wp:list -->',
        ),
      ]),
    ).toThrow(/block type changed/);
    expect(() =>
      applyEdits(doc, [edit(target.blockId, "<p>Not a WordPress block</p>")]),
    ).toThrow(/exactly one WordPress block/);
  });

  it("preserves list type, item count and item order", () => {
    const doc = makeDocument();
    const target = blockByText(doc, "questions customers ask");
    const candidate = applyEdits(doc, [
      edit(
        target.blockId,
        '<!-- wp:list {"ordered":false} --><ul><li>Record the questions customers ask before they buy.</li><li>Pick one question that can start a useful discussion.</li></ul><!-- /wp:list -->',
      ),
    ]);
    const list = candidate.sections[0].blocks.find((block) => block.id === "audience-list");
    expect(list?.type).toBe("list");
    if (list?.type === "list") expect(list.items).toHaveLength(2);
    expect(() =>
      applyEdits(doc, [
        edit(
          target.blockId,
          '<!-- wp:list {"ordered":false} --><ul><li>Only one item.</li></ul><!-- /wp:list -->',
        ),
      ]),
    ).toThrow(/list structure changed/);
  });
});

describe("candidate validation", () => {
  it.each([
    ["FAQ", (doc: ArticleDocument) => { doc.visibleFaq[0].question = "Changed?"; }],
    ["CTA", (doc: ArticleDocument) => { if (doc.cta) doc.cta.html = "changed"; }],
    ["schema", (doc: ArticleDocument) => { if (doc.faqSchema) doc.faqSchema.html = "changed"; }],
    ["language switcher", (doc: ArticleDocument) => { doc.languageSwitcher = null; }],
    ["title", (doc: ArticleDocument) => { doc.metadata.title = "Changed title"; }],
    ["H2 structure", (doc: ArticleDocument) => { doc.sections.pop(); }],
  ])("rejects protected %s changes", (_label: string, mutate: (doc: ArticleDocument) => void) => {
    const original = makeDocument();
    const candidate = structuredClone(original);
    mutate(candidate);
    expect(validateCandidate(original, candidate, KEY_PHRASE).passed).toBe(false);
  });

  it("rejects candidates outside the ten-percent word tolerance", () => {
    const original = makeDocument();
    const candidate = structuredClone(original);
    const block = candidate.sections[0].blocks[0];
    if (block.type === "paragraph") block.content[0].text += ` ${"padding ".repeat(100)}`;
    const result = validateCandidate(original, candidate, KEY_PHRASE);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => /word count/i.test(reason))).toBe(true);
  });

  it("rejects when full production validation rejects", () => {
    const original = makeDocument();
    const candidate = structuredClone(original);
    const result = validateCandidate(original, candidate, KEY_PHRASE, () => ({
      passed: false,
      reasons: ["external source requirement failed"],
    }));
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain(
      "production validation: external source requirement failed",
    );
  });
});

describe("editorial transaction", () => {
  it("recovers a valid JSON object from a fenced response", async () => {
    const doc = makeDocument();
    const ai = vi.fn().mockResolvedValue({ content: "```json\n{\"edits\":[]}\n```" });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(true);
    expect(result.result.reason).toContain("wrapper recovery");
  });

  it("commits a valid edit and reports before/after metrics", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          target.blockId,
          "<!-- wp:paragraph --><p>Define the business response that would make the conversation useful, then compare replies with that goal and save the customer language worth reusing.</p><!-- /wp:paragraph -->",
          "Made the advice specific",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(true);
    expect(result.result.appliedEdits).toBe(1);
    expect(result.result.inputWordCount).toBe(countCanonicalVisibleWords(doc));
    expect(result.result.internalLinksAfter).toBe(result.result.internalLinksBefore);
    expect(result.result.externalLinksAfter).toBe(result.result.externalLinksBefore);
  });

  it("removes a repeated idea without changing article structure", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "A clear audience helps");
    const duplicateTarget = extractEditableBlocks(doc).filter((item) =>
      item.html.includes("A clear audience helps"),
    )[1];
    expect(duplicateTarget).toBeDefined();
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          duplicateTarget.blockId,
          "<!-- wp:paragraph --><p>Use recent customer questions to choose one focused prompt, then prepare a follow-up that moves the most useful replies towards the next business step.</p><!-- /wp:paragraph -->",
          "Removed a repeated explanation",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(target).toBeDefined();
    expect(result.result.accepted).toBe(true);
    expect(result.result.repeatedParagraphsRemoved).toBeGreaterThanOrEqual(1);
  });

  it("retries one rejected proposal and can commit the corrected transaction", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const ai = vi
      .fn()
      .mockResolvedValueOnce({ content: "not json" })
      .mockResolvedValueOnce({
        content: response([
          edit(
            target.blockId,
            "<!-- wp:paragraph --><p>Define the useful response first, then compare the discussion with that goal and keep the customer language that can sharpen the next post.</p><!-- /wp:paragraph -->",
          ),
        ]),
      });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai);
    expect(result.result.accepted).toBe(true);
    expect(result.result.attempts).toBe(2);
    expect(ai).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed edits and restores the exact original object", async () => {
    const doc = makeDocument();
    const originalHtml = renderArticleDocument(doc);
    const ai = vi.fn().mockResolvedValue({ content: "not valid json" });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(false);
    expect(result.doc).toBe(doc);
    expect(renderArticleDocument(result.doc)).toBe(originalHtml);
  });

  it("rejects the whole proposal when one edit is unknown", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          target.blockId,
          "<!-- wp:paragraph --><p>Define the useful response before reviewing the conversation and recording customer language.</p><!-- /wp:paragraph -->",
        ),
        edit(
          "protected:faq:answer",
          "<!-- wp:paragraph --><p>Changed FAQ.</p><!-- /wp:paragraph -->",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(false);
    expect(result.result.appliedEdits).toBe(0);
    expect(result.doc).toBe(doc);
  });

  it("rejects unsupported statistics proposed by the editor", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          target.blockId,
          "<!-- wp:paragraph --><p>Aim for 10% engagement before reviewing the replies.</p><!-- /wp:paragraph -->",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(false);
    expect(result.result.newNumericClaims).toBe(0);
    expect(result.doc).toBe(doc);
  });

  it("allows a fact-free fallback after a broad numeric rewrite is rejected", async () => {
    const doc = makeDocument();
    doc.sections[0].blocks.push(
      paragraph("numeric-baseline", "The approved survey result is 25%."),
    );
    const numericTarget = blockByText(doc, "approved survey result");
    const broadAi = vi.fn().mockResolvedValue({
      content: response([
        edit(
          numericTarget.blockId,
          "<!-- wp:paragraph --><p>The approved survey result is 30%.</p><!-- /wp:paragraph -->",
        ),
      ]),
    });
    const broad = await runEditorialPolish(doc, KEY_PHRASE, broadAi, { maxAttempts: 1 });
    expect(broad.result.accepted).toBe(false);
    expect(broad.result.reason).toContain("numeric facts changed");

    const proseOnlyIds = findProseOnlyEditableBlockIds(doc, KEY_PHRASE, [], {});
    expect(proseOnlyIds).not.toContain(numericTarget.blockId);
    const proseTarget = blockByText(doc, "response that matters");
    expect(proseOnlyIds).toContain(proseTarget.blockId);
    const fallbackAi = vi.fn().mockResolvedValue({
      content: response([
        edit(
          proseTarget.blockId,
          "<!-- wp:paragraph --><p>Define the useful business response first, then review the discussion against that goal and keep the customer language that can sharpen the next post.</p><!-- /wp:paragraph -->",
        ),
      ]),
    });
    const fallback = await runEditorialPolish(doc, KEY_PHRASE, fallbackAi, {
      maxAttempts: 1,
      mode: "prose-only",
      editableBlockIds: proseOnlyIds,
    });
    expect(fallback.result.accepted).toBe(true);
    expect(renderArticleDocument(fallback.doc)).toContain("25%");
    expect(renderArticleDocument(fallback.doc)).not.toContain("30%");
  });

  it("rejects an edit targeting an evidence-locked block", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          target.blockId,
          "<!-- wp:paragraph --><p>Changed factual evidence wording.</p><!-- /wp:paragraph -->",
        ),
      ]),
    });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      maxAttempts: 1,
      protectedBlockIds: [target.blockId],
    });
    expect(result.result.accepted).toBe(false);
    expect(result.result.reason).toContain("Unknown or protected blockId");
    expect(result.doc).toBe(doc);
  });

  it("rejects atomically when production validation fails", async () => {
    const doc = makeDocument();
    const ai = vi.fn().mockResolvedValue({ content: response([]) });
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, {
      maxAttempts: 1,
      validateProductionCandidate: () => ({
        passed: false,
        reasons: ["final policy failed"],
      }),
    });
    expect(result.result.accepted).toBe(false);
    expect(result.result.reason).toContain("production validation");
    expect(result.doc).toBe(doc);
  });

  it("never increases the exact keyphrase count", async () => {
    const doc = makeDocument();
    const target = blockByText(doc, "response that matters");
    const ai = vi.fn().mockResolvedValue({
      content: response([
        edit(
          target.blockId,
          `<!-- wp:paragraph --><p>${KEY_PHRASE} ${KEY_PHRASE} should guide every reply.</p><!-- /wp:paragraph -->`,
        ),
      ]),
    });
    const before = countExactKeyphrase(renderArticleDocument(doc), KEY_PHRASE);
    const result = await runEditorialPolish(doc, KEY_PHRASE, ai, { maxAttempts: 1 });
    expect(result.result.accepted).toBe(false);
    expect(result.result.keyphraseAfter).toBe(before);
  });

  it("excludes wp:html schema, CTA and switcher text from keyphrase counting", () => {
    const html = `<!-- wp:paragraph --><p>${KEY_PHRASE} appears once in editorial prose.</p><!-- /wp:paragraph -->
<!-- wp:html --><script type="application/ld+json">{"text":"${KEY_PHRASE}"}</script><!-- /wp:html -->
<!-- wp:html --><div>${KEY_PHRASE}</div><!-- /wp:html -->`;
    expect(countExactKeyphrase(html, KEY_PHRASE)).toBe(1);
  });
});
