import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleDocument, ArticleSection, EditorialBlock } from "@/lib/blog/article-document";
import {
  renderFaqSchema,
  fingerprintHtml,
} from "@/lib/blog/article-document";
import { buildPolicy } from "@/lib/blog/final-article-policy";
import { createPipelineState } from "@/lib/pipeline/blog-generation-pipeline";
import type { GenerationResult } from "@/lib/services/blog-generation-service";
import { buildClaimOwnershipLedger } from "@/lib/blog/claim-ownership";
import { CANONICAL_ENGLISH_CTA_HTML, CANONICAL_ENGLISH_CTA_FINGERPRINT } from "@/lib/blog/canonical-cta";
import { pairedSlugs, renderLanguageSwitcher } from "@/lib/services/article-postprocessors";

const mocks = vi.hoisted(() => ({
  createVersion: vi.fn(),
  updateProject: vi.fn(),
  getNextVersionNumber: vi.fn(),
  runBlogGeneration: vi.fn(),
}));

vi.mock("@/lib/services/auth", () => ({
  getCurrentUserId: vi.fn(async () => "user-1"),
}));

vi.mock("@/lib/services/project-authorization", () => ({
  requireProjectAccess: vi.fn(async () => ({ id: 1, content: "previous" })),
}));

vi.mock("@/lib/repositories", () => ({
  projectRepository: {
    update: mocks.updateProject,
    findByIdAndUser: vi.fn(),
  },
  blogVersionRepository: {
    create: mocks.createVersion,
    getNextVersionNumber: mocks.getNextVersionNumber,
    findById: vi.fn(),
    findByProject: vi.fn(),
    delete: vi.fn(),
  },
  aiLogRepository: { create: vi.fn() },
}));

vi.mock("@/lib/services/blog-generation-service", () => ({
  runBlogGeneration: mocks.runBlogGeneration,
}));

import { POST } from "@/app/api/generate-blog/route";

function invalidGenerationResult(): GenerationResult {
  const doc: ArticleDocument = {
    metadata: {
      title: "Too short",
      slug: "too-short",
      metaDescription: "Too short.",
      excerpt: "",
      targetWordCount: 2500,
      focusKeyphrase: "missing keyphrase",
    },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  const pipelineState = createPipelineState({
    userId: "user-1",
    projectId: "1",
    keyphrase: doc.metadata.focusKeyphrase,
    requestedWordCount: 2500,
    articleDoc: doc,
    h2Headings: [],
    intro: "",
    conclusion: "",
    wordsPerSection: 300,
    exactKeyphraseTarget: 8,
    policy: buildPolicy(2500),
    ctx: { research: [] },
    wordMin: 2125,
    wordMax: 2875,
    systemPrompt: "test",
    userMessage: "test",
  });
  return {
    generated: {
      title: doc.metadata.title,
      slug: doc.metadata.slug,
      metaDescription: doc.metadata.metaDescription,
      excerpt: "",
      blog: pipelineState.blog,
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
    },
    pipelineState,
    qualityReport: null,
    h2Headings: [],
    wordMin: 2125,
    wordMax: 2875,
    retryCount: 0,
    componentRegens: 0,
    estimatedTokens: 0,
    systemPrompt: "test",
    userMessage: "test",
  };
}

// ── Valid-article fixture that passes every gate except claim ownership ──

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

function paragraphHtml(text: string): string {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
}

function proseBlock(count: number): string {
  const sentences: string[] = [];
  for (let index = 0; index < count; index++) {
    sentences.push(PROSE_SENTENCES[(index + count) % PROSE_SENTENCES.length]);
  }
  return paragraphHtml(sentences.join(" "));
}

function parseIntroBlocks(html: string): EditorialBlock[] {
  const blocks: EditorialBlock[] = [];
  const re = /<!--\s*wp:paragraph\s*-->\s*<p>([\s\S]*?)<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push({ id: `b-${blocks.length}`, type: "paragraph", content: [{ type: "text", text: m[1] }] });
  }
  return blocks;
}

const VALID_KEYPHRASE = "hong kong sme marketing";
const VALID_SLUG = "hong-kong-sme-marketing-practical-local-guide";

function buildValidArticle(options?: { faqClaim?: boolean; orphanTransition?: boolean; sentenceQualityViolation?: boolean; boilerplateViolation?: boolean }): {
  doc: ArticleDocument;
  pipelineState: ReturnType<typeof createPipelineState>;
} {
  const slugs = pairedSlugs(VALID_SLUG);
  const switcherHtml = renderLanguageSwitcher({
    currentLanguage: "en",
    englishSlug: slugs.englishSlug,
    chineseSlug: slugs.chineseSlug,
  });
  const sections: ArticleSection[] = [
    { id: "s0", heading: "Why Hong Kong SMEs Need a Plan", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s1", heading: "Steps to a Simple Marketing Routine", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s2", heading: "Measuring What Matters", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s3", heading: "Common Mistakes to Avoid", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s4", heading: "Building a Consistent Local Voice", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "s5", heading: "Improving the Plan Over Time", headingLevel: 2, sectionType: "main", blocks: [], status: "generated" },
    { id: "faq-section", heading: "Frequently Asked Questions", headingLevel: 2, sectionType: "faq-heading", blocks: [], status: "generated" },
  ];
  const faqs = options?.faqClaim
    ? [
        {
          question: "How many users does Threads have in Hong Kong?",
          answerHtml: "",
          answerText: "Threads has 2.4 million monthly active users in Hong Kong as of the latest figures.",
        },
        { question: "What is practical step one for local businesses?", answerHtml: "", answerText: "Start with a useful routine and review real customer questions each week." },
        { question: "How often should a small team post?", answerHtml: "", answerText: "Post a few times a week using a simple, honest routine." },
        { question: "Do small brands need paid ads on Threads?", answerHtml: "", answerText: "Most local teams start with organic content before testing paid options." },
      ]
    : [
        { question: "What is practical step one for local businesses?", answerHtml: "", answerText: "Start with a useful routine and review real customer questions each week." },
        { question: "How often should a small team post?", answerHtml: "", answerText: "Post a few times a week using a simple, honest routine." },
        { question: "Do small brands need paid ads on Threads?", answerHtml: "", answerText: "Most local teams start with organic content before testing paid options." },
        { question: "How can a team improve over time?", answerHtml: "", answerText: "Review real customer questions and adjust the routine each month." },
      ];
  const doc: ArticleDocument = {
    metadata: {
      title: "Hong Kong SME Marketing: A Practical Local Guide",
      slug: VALID_SLUG,
      metaDescription: "A practical guide to marketing for Hong Kong SMEs.",
      excerpt: "A practical local guide.",
      targetWordCount: 2500,
      focusKeyphrase: VALID_KEYPHRASE,
    },
    languageSwitcher: {
      id: "sw",
      type: "language-switcher",
      html: switcherHtml,
      fingerprint: fingerprintHtml(switcherHtml),
    },
    introduction: {
      id: "intro",
      blocks: parseIntroBlocks(Array.from({ length: 6 }, () => proseBlock(3)).join("\n\n")),
      status: "generated",
    },
    sections: sections.map((section, index) => {
      if (section.sectionType === "faq-heading") return section;
      const blocks = parseIntroBlocks(Array.from({ length: 10 + (index % 2) }, () => proseBlock(3)).join("\n\n"));
      if (options?.orphanTransition && index === 0) {
        blocks.unshift({
          id: "orphan-instead",
          type: "paragraph",
          content: [{ type: "text", text: "Instead, the brands winning attention are the ones that feel human and show up where people actually enjoy spending time." }],
        });
      }
      if (options?.sentenceQualityViolation && index === 1) {
        blocks.unshift({
          id: "corrupt-phrase",
          type: "paragraph",
          content: [{ type: "text", text: "This is part of the the changing Hong Kong market and it keeps growing every year." }],
        });
      }
      if (options?.boilerplateViolation && index === 2) {
        blocks.unshift({
          id: "copyright-note",
          type: "quote",
          content: [{ type: "text", text: "All rights belong to their respective owners." }],
        });
      }
      return { ...section, blocks };
    }),
    visibleFaq: faqs,
    conclusion: {
      id: "conclusion",
      blocks: parseIntroBlocks(Array.from({ length: 4 }, () => proseBlock(3)).join("\n\n")),
      status: "generated",
    },
    cta: {
      id: "cta",
      type: "cta",
      html: CANONICAL_ENGLISH_CTA_HTML,
      fingerprint: CANONICAL_ENGLISH_CTA_FINGERPRINT,
    },
    faqSchema: {
      id: "faq-schema",
      type: "faq-schema",
      html: renderFaqSchema(faqs),
      fingerprint: "schema",
    },
    insertedLinks: [],
  };

  const research = options?.faqClaim
    ? [
        {
          title: "Hong Kong Threads audience",
          snippet: "Threads has 2.4 million monthly active users in Hong Kong.",
          url: "https://example.com/audience",
        },
      ]
    : [];
  const ownershipSections = sections
    .filter((section) => section.sectionType !== "faq-heading")
    .map((section) => ({ id: section.id, heading: section.heading, sectionType: section.sectionType }));
  const claimOwnership = options?.faqClaim
    ? buildClaimOwnershipLedger(ownershipSections, research)
    : undefined;

  const range = { min: 2125, max: 2875 };
  const pipelineState = createPipelineState({
    userId: "user-1",
    projectId: "1",
    keyphrase: VALID_KEYPHRASE,
    requestedWordCount: 2500,
    articleDoc: doc,
    h2Headings: sections.map((s) => s.heading),
    intro: "",
    conclusion: "",
    wordsPerSection: 350,
    exactKeyphraseTarget: 9,
    policy: buildPolicy(2500, range.min, range.max, VALID_KEYPHRASE),
    ctx: { research, claimOwnership },
    wordMin: range.min,
    wordMax: range.max,
    systemPrompt: "test",
    userMessage: "test",
  });
  return { doc, pipelineState };
}

function ownershipViolationGenerationResult(): GenerationResult {
  const { doc, pipelineState } = buildValidArticle({ faqClaim: true });
  return {
    generated: {
      title: doc.metadata.title,
      slug: doc.metadata.slug,
      metaDescription: doc.metadata.metaDescription,
      excerpt: "",
      blog: pipelineState.blog,
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
    },
    pipelineState,
    qualityReport: null,
    h2Headings: doc.sections.map((s) => s.heading),
    wordMin: 2125,
    wordMax: 2875,
    retryCount: 0,
    componentRegens: 0,
    estimatedTokens: 0,
    systemPrompt: "test",
    userMessage: "test",
  };
}

function coherenceViolationGenerationResult(): GenerationResult {
  const { doc, pipelineState } = buildValidArticle({ orphanTransition: true });
  return {
    generated: {
      title: doc.metadata.title,
      slug: doc.metadata.slug,
      metaDescription: doc.metadata.metaDescription,
      excerpt: "",
      blog: pipelineState.blog,
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
    },
    pipelineState,
    qualityReport: null,
    h2Headings: doc.sections.map((s) => s.heading),
    wordMin: 2125,
    wordMax: 2875,
    retryCount: 0,
    componentRegens: 0,
    estimatedTokens: 0,
    systemPrompt: "test",
    userMessage: "test",
  };
}

function sentenceQualityViolationGenerationResult(): GenerationResult {
  const { doc, pipelineState } = buildValidArticle({ sentenceQualityViolation: true });
  return {
    generated: {
      title: doc.metadata.title,
      slug: doc.metadata.slug,
      metaDescription: doc.metadata.metaDescription,
      excerpt: "",
      blog: pipelineState.blog,
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
    },
    pipelineState,
    qualityReport: null,
    h2Headings: doc.sections.map((s) => s.heading),
    wordMin: 2125,
    wordMax: 2875,
    retryCount: 0,
    componentRegens: 0,
    estimatedTokens: 0,
    systemPrompt: "test",
    userMessage: "test",
  };
}

function boilerplateViolationGenerationResult(): GenerationResult {
  const { doc, pipelineState } = buildValidArticle({ boilerplateViolation: true });
  return {
    generated: {
      title: doc.metadata.title,
      slug: doc.metadata.slug,
      metaDescription: doc.metadata.metaDescription,
      excerpt: "",
      blog: pipelineState.blog,
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
    },
    pipelineState,
    qualityReport: null,
    h2Headings: doc.sections.map((s) => s.heading),
    wordMin: 2125,
    wordMax: 2875,
    retryCount: 0,
    componentRegens: 0,
    estimatedTokens: 0,
    systemPrompt: "test",
    userMessage: "test",
  };
}

describe("generate-blog persistence boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNextVersionNumber.mockResolvedValue(1);
    mocks.runBlogGeneration.mockResolvedValue(invalidGenerationResult());
  });

  it("does not start any database write when final validation fails", async () => {
    const response = await POST(new Request("http://localhost/api/generate-blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: 1 }),
    }));

    expect(response.status).toBe(422);
    expect(mocks.getNextVersionNumber).not.toHaveBeenCalled();
    expect(mocks.createVersion).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("unresolved claim-ownership violations prevent saving and publishing", async () => {
    mocks.runBlogGeneration.mockResolvedValue(ownershipViolationGenerationResult());
    const response = await POST(new Request("http://localhost/api/generate-blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: 1 }),
    }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("claim ownership violations");
    expect(mocks.getNextVersionNumber).not.toHaveBeenCalled();
    expect(mocks.createVersion).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("failed coherence validation blocks all database writes", async () => {
    mocks.runBlogGeneration.mockResolvedValue(coherenceViolationGenerationResult());
    const response = await POST(new Request("http://localhost/api/generate-blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: 1 }),
    }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("coherence violations");
    expect(mocks.getNextVersionNumber).not.toHaveBeenCalled();
    expect(mocks.createVersion).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("failed deterministic sentence-quality QC blocks all database writes", async () => {
    mocks.runBlogGeneration.mockResolvedValue(sentenceQualityViolationGenerationResult());
    const response = await POST(new Request("http://localhost/api/generate-blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: 1 }),
    }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("sentence quality violations");
    expect(mocks.getNextVersionNumber).not.toHaveBeenCalled();
    expect(mocks.createVersion).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("source boilerplate in a quote block blocks all database writes", async () => {
    mocks.runBlogGeneration.mockResolvedValue(boilerplateViolationGenerationResult());
    const response = await POST(new Request("http://localhost/api/generate-blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: 1 }),
    }));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain("source boilerplate blocks");
    expect(mocks.getNextVersionNumber).not.toHaveBeenCalled();
    expect(mocks.createVersion).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});
