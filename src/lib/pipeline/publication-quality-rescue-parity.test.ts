import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { countCanonicalVisibleWords } from "@/lib/blog/article-document";
import {
  analyzePublicationQuality,
  keyphraseExclusionSet,
  scanMalformedProseInDocument,
} from "@/lib/blog/publication-quality";
import { extractParagraphTexts } from "@/lib/seo/seo-text-utils";
import { analyzeSentenceCompleteness, analyzeSentenceCompletenessDeterministic } from "@/lib/blog/sentence-completeness";
import { scanSentenceQualityInDocument, licensedRepeatedWordSpansFromEvidence } from "@/lib/blog/sentence-quality";
import { analyzeFinalArticle, buildPolicy, evaluatePolicy } from "@/lib/blog/final-article-policy";

afterEach(() => {
  delete process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS;
  delete process.env.ENABLE_FULL_DOCUMENT_EDITORIAL;
  delete process.env.FULL_DOCUMENT_EDITORIAL_MODE;
});

const ENCODED_COPULA_1 = "The modern Hong Kong shopper isn&#39;t one single type of person.";
const ENCODED_COPULA_2 = "It&#39;s rarely just the product.";
const DECODED_COPULA_1 = "The modern Hong Kong shopper isn't one single type of person.";
const DECODED_COPULA_2 = "It's rarely just the product.";

const PROJECT26_SNAPSHOT = path.resolve(
  "src",
  "lib",
  "__live-fixtures__",
  "2026-08-18T12-20-57-700Z_final-validation_project-26.json",
);

function loadSnapshot(): { articleDoc: ArticleDocument; blog: string } {
  const raw = fs.readFileSync(PROJECT26_SNAPSHOT, "utf8");
  const snap = JSON.parse(raw) as { documents: { articleDoc: ArticleDocument; blog: string } };
  return snap.documents;
}

// Research covering the article's attributed claims (the 50% incentive) and the
// DON DON DONKI entity, mirroring what the pipeline stage had available.
const RESEARCH: Array<{ title?: string; snippet?: string; url?: string }> = [
  {
    title: "DON DON DONKI expands in Hong Kong",
    snippet:
      "DON DON DONKI operates several stores across the city and is known as a leading retail channel for Asian-origin packaged goods and international food and beauty brands.",
    url: "https://example.com/don-don-donki-hong-kong",
  },
  {
    title: "Hong Kong Retail Management Association service guidance",
    snippet:
      "The Hong Kong Retail Management Association recommends outlets recognise service performance in retail outlets, such as offering 50% off for new members as a reward for strong service.",
    url: "https://example.com/hkrma-service-guidance",
  },
];

// ── 1. Root fix: HTML-encoded copular contractions at the shared authority ──

describe("shared completeness authority decodes HTML entities", () => {
  it("encoded contractions are now judged identical to decoded ones", () => {
    process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS = "true";
    for (const [encoded, decoded] of [
      [ENCODED_COPULA_1, DECODED_COPULA_1],
      [ENCODED_COPULA_2, DECODED_COPULA_2],
    ] as Array<[string, string]>) {
      const encodedVerdict = analyzeSentenceCompleteness(encoded, "paragraph");
      const decodedVerdict = analyzeSentenceCompleteness(decoded, "paragraph");
      expect(encodedVerdict.complete, encoded).toBe(true);
      expect(decodedVerdict.complete, decoded).toBe(true);
    }
  });

  it("the raw encoded text would still fail the shadow-free deterministic core — the decode is the mechanism", () => {
    expect(analyzeSentenceCompletenessDeterministic(ENCODED_COPULA_1, "paragraph").complete).toBe(false);
    expect(analyzeSentenceCompletenessDeterministic(DECODED_COPULA_1, "paragraph").complete).toBe(true);
    expect(analyzeSentenceCompletenessDeterministic(ENCODED_COPULA_2, "paragraph").complete).toBe(false);
    expect(analyzeSentenceCompletenessDeterministic(DECODED_COPULA_2, "paragraph").complete).toBe(true);
  });

  it("works without the hybrid flag too (deterministic path) and stays consistent", () => {
    for (const [encoded, decoded] of [
      [ENCODED_COPULA_1, DECODED_COPULA_1],
      [ENCODED_COPULA_2, DECODED_COPULA_2],
    ] as Array<[string, string]>) {
      const encodedVerdict = analyzeSentenceCompleteness(encoded, "paragraph");
      const decodedVerdict = analyzeSentenceCompleteness(decoded, "paragraph");
      expect(encodedVerdict.complete).toBe(decodedVerdict.complete);
      expect(encodedVerdict.complete).toBe(true);
    }
  });
});

// ── 2. Exact Project-26 replay ──

describe("project-26 final-save replay", () => {
  it("proves the 2 legacy malformed findings are the HTML-encoded copular sentences", () => {
    process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS = "true";
    const { blog } = loadSnapshot();
    const paragraphs = extractParagraphTexts(blog);
    // The exact two paragraphs that carried the false findings (before the fix
    // they were flagged by the shared completeness core because of the HTML
    // entity encoding; the wrapper now decodes them identically to the
    // canonical doc text).
    const culprits = paragraphs.filter((text) =>
      text.includes("isn&#39;t one single type of person") || text.includes("It&#39;s rarely just the product"),
    );
    expect(culprits.length).toBe(2);
    for (const culprit of culprits) {
      // Pre-fix state: the raw encoded text fails the shadow-free deterministic
      // core (this is exactly what produced malformed prose issues=2).
      expect(analyzeSentenceCompletenessDeterministic(culprit, "paragraph").complete).toBe(false);
      // Post-fix state: the shared authority decodes and accepts it.
      expect(analyzeSentenceCompleteness(culprit, "paragraph").complete).toBe(true);
    }
    // The user-suspected sentences were NOT among the findings — they were
    // already rescued in both the canonical and the legacy path.
    expect(paragraphs.some((text) => text.includes("They&#39;re your repeat customers"))).toBe(true);
  });

  it("canonical malformed = 0 and publication/final-policy malformed = 0, editorial no longer tanked", () => {
    process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS = "true";
    const { articleDoc, blog } = loadSnapshot();
    const keyphrase = articleDoc.metadata.focusKeyphrase;

    expect(scanMalformedProseInDocument(articleDoc)).toEqual([]);
    const legacy = analyzePublicationQuality(blog, keyphraseExclusionSet(keyphrase));
    expect(legacy.malformedProseCount).toBe(0);
    // Editorial score recovers from 8 (with the -80 false penalty) to >= 80.
    expect(legacy.editorialScore).toBeGreaterThanOrEqual(80);
  });

  it("sentence-quality violations = 0 when the pipeline evidence licenses the entity", () => {
    process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS = "true";
    const { articleDoc } = loadSnapshot();
    const spans = licensedRepeatedWordSpansFromEvidence(RESEARCH);
    const findings = scanSentenceQualityInDocument(articleDoc, { licensedRepeatedWordSpans: spans });
    expect(findings).toEqual([]);
  });

  it("final policy passes — only the [SOFT] H2 keyphrase reason remains", () => {
    process.env.ENABLE_HYBRID_SENTENCE_COMPLETENESS = "true";
    process.env.ENABLE_FULL_DOCUMENT_EDITORIAL = "true";
    process.env.FULL_DOCUMENT_EDITORIAL_MODE = "enforce";
    const { articleDoc, blog } = loadSnapshot();
    const keyphrase = articleDoc.metadata.focusKeyphrase;
    const wordCount = countCanonicalVisibleWords(articleDoc);

    const metrics = analyzeFinalArticle(
      blog,
      keyphrase,
      articleDoc.metadata.title,
      articleDoc.metadata.metaDescription,
      2500,
      wordCount,
      {
        articleDoc,
        research: RESEARCH,
        // The Stage 3Q editor committed successfully in the live run:
        // blocking=1 accepted=1 unresolvedBlocking=0 verified=true.
        fullDocumentEditorial: {
          accepted: true,
          mode: "enforce",
          unresolvedFindingIds: [],
          mandatoryOverflow: false,
          patches: [{ accepted: true }],
        },
      },
    );
    expect(metrics.malformedProseCount).toBe(0);
    expect(metrics.malformedProseBlockCount).toBe(0);
    expect(metrics.sentenceQualityViolationCount).toBe(0);
    expect(metrics.editorialScore ?? 0).toBeGreaterThanOrEqual(80);

    const policy = buildPolicy(2500, 2125, 2875, keyphrase);
    const verdict = evaluatePolicy(metrics, policy);
    expect(verdict.passed).toBe(true);
    // The only remaining signal is the nonblocking soft H2 keyphrase hint.
    expect(verdict.reasons).toEqual(["[SOFT] no H2 keyphrase"]);
  });
});
