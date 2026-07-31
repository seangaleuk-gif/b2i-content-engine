// ── Factual-Risk Scanner ──
// Post-generation scan that flags unsupported precise claims in editable article content.
// Uses only supplied project research text — never the live web.
//
// Supported claims are retained.
// Unsupported claims in editable content trigger targeted regeneration.
// If regeneration still has unsupported claims, the offending sentence is removed.

import {
  parseWordPressEditorialBlocks,
  renderEditorialBlocksToWordPress,
  type EditorialBlock,
} from "@/lib/blog/article-document";

// ── Types ──

export interface FactualRisk {
  /** Array of claims found in the article text */
  claims: ScannedClaim[];
  /** Whether the article contains any high-risk (likely unsupported) claims */
  hasHighRisk: boolean;
}

export interface ScannedClaim {
  /** The exact claim text fragment */
  text: string;
  /** Position in the HTML where the claim starts */
  htmlPosition: number;
  /** The claim category */
  category: ClaimCategory;
  /** Whether this claim appears to be supported by research text */
  supported: boolean;
  /** Complete sentence containing the detected fragment. */
  sentenceText?: string;
  /** Stable source identifier when the complete claim is supported. */
  evidenceId?: string;
  /** Exact research sentence used to support the claim. */
  evidenceText?: string;
  /** Research URL associated with the supporting sentence. */
  evidenceUrl?: string;
  /** Deterministic explanation for support or rejection. */
  supportReason?: string;
  /** Section index (which H2 section this appears in) */
  sectionIndex: number;
}

export type ClaimCategory =
  | "percentage"
  | "currency_amount"
  | "date_claim"
  | "numerical_growth"
  | "platform_metric"
  | "platform_feature"
  | "platform_behavior"
  | "comparative_performance"
  | "publishing_cadence"
  | "testimonial_quote"
  | "unattributed_source"
  | "business_result";

export interface EvidenceLedgerEntry {
  evidenceId: string;
  title: string;
  snippet: string;
  url: string;
  approvedText: string;
  normalizedText: string;
  quantities: number[];
  geography: "hong-kong" | "global" | "unspecified";
  statisticQualifier: "average" | "median" | "unspecified";
  concepts: string[];
}

// ── Claim detection patterns ──

const CLAIM_PATTERNS: Array<{
  category: ClaimCategory;
  regex: RegExp;
  /** Generic quoted text must have explicit attribution before it is factual. */
  quotedText?: boolean;
}> = [
  // Percentages
  { category: "percentage", regex: /\d{1,3}(?:\.\d+)?%/gi },
  { category: "currency_amount", regex: /(?:HK\$|US\$|[$£€¥])\s*\d[\d,]*(?:\.\d+)?/gi },
  { category: "date_claim", regex: /\b(?:19|20)\d{2}\b/gi },
  {
    category: "platform_metric",
    regex: /\b(?:average|median)\s+engagement rate[^.!?]{0,100}?\d{1,3}(?:\.\d+)?%/gi,
  },
  {
    category: "platform_metric",
    regex: /\b\d{1,3}(?:\.\d+)?%[^.!?]{0,100}?(?:average|median)\s+engagement rate\b/gi,
  },
  // Numerical growth claims
  { category: "numerical_growth", regex: /(?:increased|decreased|grew|fell|rose|dropped|doubled|tripled|jumped|surged)\s+(?:by|from|to)\s+\d+/gi },
  { category: "numerical_growth", regex: /(?:jumped|surged|shot up|soared|plummeted|plunged)\s+(?:\d+)/gi },
  { category: "numerical_growth", regex: /\d+\s*(?:percent|per cent|times|x)\s+(?:increase|decrease|growth|drop|rise|fall|more)/gi },
  { category: "numerical_growth", regex: /\b\d+(?:\.\d+)?\s*x\s+(?:higher|lower|more|greater|better|faster)\b/gi },
  // Platform thresholds, recommended cadence and claimed peak-time windows
  { category: "platform_metric", regex: /\b\d[\d,]*\s+followers?\b/gi },
  {
    category: "platform_metric",
    regex: /\b\d+(?:\.\d+)?(?:,\d{3})*\s*(?:billion|million|thousand|bn|m|k)?\+?\s+(?:monthly active\s+|daily active\s+)?users?\b/gi,
  },
  { category: "publishing_cadence", regex: /\b\d+(?:\s*[–—-]\s*\d+)?\s+(?:posts?|threads?)\s+(?:per|a)\s+(?:day|week|month)\b/gi },
  { category: "publishing_cadence", regex: /\b(?:post|publish)\s+\d+(?:\s*[–—-]\s*\d+)?\s+times?\s+(?:per|a)\s+(?:day|week|month)\b/gi },
  { category: "platform_metric", regex: /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi },
  { category: "platform_metric", regex: /\b(?:within|during)\s+the\s+first\s+(?:hour|day|week)\b/gi },
  { category: "platform_metric", regex: /\b(?:target|aim for|benchmark of)\s+\d+(?:\s*[–—-]\s*\d+)?%/gi },
  // Dated or current platform-capability claims must be present in research.
  { category: "platform_feature", regex: /\bas of \d{4},?[^.!?]{0,140}\b(?:launched|available|supports?|allows?|offers?)\b[^.!?]*/gi },
  {
    category: "platform_feature",
    regex:
      /\bthreads\b[^.!?]{0,100}\b(?:ads?|advertising|analytics|insights|links?|features?)\b[^.!?]{0,100}\b(?:available|unavailable|launched|rolled out|supported|allowed|offered|does not|doesn't|is not|isn't|are not|aren't|now|currently|yet)\b[^.!?]*/gi,
  },
  {
    category: "platform_feature",
    regex:
      /\bthreads\b[^.!?]{0,100}\b(?:supports?|allows?|offers?|includes?|has launched)\b[^.!?]{0,80}\b(?:ads?|advertising|analytics|insights|links?|features?)\b[^.!?]*/gi,
  },
  {
    category: "platform_feature",
    regex:
      /\bthreads\s+ads?\b[^.!?]{0,160}\b(?:meta ads manager|placement|targeting|call-to-action|cta|approval process|home feed|feed)\b[^.!?]*/gi,
  },
  {
    category: "platform_behavior",
    regex:
      /\b(?:the\s+)?(?:threads(?:'s)?\s+)?algorithm\b[^.!?]{0,160}\b(?:amplif(?:y|ies)|bur(?:y|ies)|favou?rs?|pushes?|rewards?|shows?|signals?|boosts?|ranks?)\b[^.!?]*/gi,
  },
  {
    category: "platform_behavior",
    regex:
      /\bthreads\b[^.!?]{0,80}\b(?:rewards?|favou?rs?|amplif(?:y|ies)|pushes?|boosts?)\b[^.!?]*/gi,
  },
  {
    category: "comparative_performance",
    regex:
      /\b(?:outperforms?|unmatched|dwarfs?|far (?:more|higher)|higher exposure|lower cpms?|faster than any|best time|peak hours?|most active|reach thousands)\b[^.!?]*/gi,
  },
  {
    category: "comparative_performance",
    regex:
      /\b(?:engagement|reach|exposure|visibility)\b[^.!?]{0,40}\b(?:will|can)\s+(?:drop|rise|increase|decrease|grow)\b[^.!?]*/gi,
  },
  // Business results
  { category: "business_result", regex: /generated?\s+\d+\s*(?:percent|%|times|x|more)/gi },
  { category: "business_result", regex: /(?:sales|revenue|traffic|leads|conversions?)\s+(?:rose|increased|grew|jumped|surged)\s+\d+/gi },
  { category: "business_result", regex: /\d+\s*(?:percent|%)\s+(?:increase|decrease|growth|boost|rise|drop)\s+in\s+(?:sales|revenue|traffic|leads|conversions?|engagement|visits?)/gi },
  // Testimonials with quotation marks
  {
    category: "testimonial_quote",
    regex: /(?:"[^"]{10,}"|“[^”]{10,}”)/gi,
    quotedText: true,
  },
  {
    category: "unattributed_source",
    regex: /\b(?:as one guide notes|according to recent data|research shows|studies show|experts say)\b[^.!?]*/gi,
  },
  // Unnamed business testimonials
  { category: "testimonial_quote", regex: /(?:a|one)\s+(?:local|small|Hong Kong)\s+(?:business|brand|company|shop|store|cafe|bakery|studio)\s+(?:told us|shared|reported|said|noted|found|experienced|saw)/gi },
  // "X more" claims
  { category: "business_result", regex: /\d+\s*(?:times|x)\s+more\s+(?:sales|revenue|traffic|leads|engagement|visits?|conversions?)/gi },
];

// ── Research-source text extraction ──

export function buildEvidenceLedger(
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): EvidenceLedgerEntry[] {
  return (research ?? []).flatMap((item, sourceIndex) => {
    const title = decodeHtmlEntities(item.title ?? "");
    const snippet = decodeHtmlEntities(item.snippet ?? "");
    const sourceSentences = splitEvidenceSentences(snippet);
    if (sourceSentences.length === 0 && title.trim()) sourceSentences.push(title.trim());
    return sourceSentences.map((sentence, claimIndex) => {
      const approvedText = sentence.replace(/\s+/g, " ").trim();
      const normalizedText = `${title} ${approvedText}`.replace(/\s+/g, " ").trim().toLowerCase();
      const geography = /\b(?:hong kong|hk)\b|香港/i.test(normalizedText)
        ? "hong-kong"
        : /\b(?:global|globally|worldwide|world average)\b|全球/i.test(normalizedText)
          ? "global"
          : "unspecified";
      const statisticQualifier = /\bmedian\b/i.test(normalizedText)
        ? "median"
        : /\baverage\b/i.test(normalizedText)
          ? "average"
          : "unspecified";
      return {
        evidenceId: `SOURCE-${sourceIndex + 1}-CLAIM-${claimIndex + 1}`,
        title,
        snippet,
        url: item.url ?? "",
        approvedText,
        normalizedText,
        quantities: extractQuantities(approvedText),
        geography,
        statisticQualifier,
        concepts: extractClaimConcepts(approvedText),
      };
    });
  });
}

// ── Scanner ──

export function scanFactualRisks(
  html: string,
  keyphrase: string,
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): FactualRisk {
  const scanHtml = stripPipelineCitationParagraphs(html)
    // Protected HTML assets are validated separately. This also excludes the
    // canonical visible FAQ, which receives its own structured factual pass.
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const bodyText = decodeHtmlEntities(scanHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());

  const evidenceLedger = buildEvidenceLedger(research);

  // Find H2 section boundaries for claim positioning
  const h2Positions: number[] = [];
  const h2Re = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi;
  let h2m: RegExpExecArray | null;
  while ((h2m = h2Re.exec(html)) !== null) {
    h2Positions.push(h2m.index);
  }

  function findSectionIndex(pos: number): number {
    let idx = 0;
    for (let i = h2Positions.length - 1; i >= 0; i--) {
      if (pos >= h2Positions[i]) { idx = i; break; }
    }
    return idx;
  }

  const claims: ScannedClaim[] = [];

  for (const { category, regex, quotedText } of CLAIM_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(bodyText)) !== null) {
      // Deduplicate by matching text
      const text = m[0].trim();
      if (claims.some((c) => normalizeForMatch(c.text) === normalizeForMatch(text))) continue;

      // Visible text may cross inline markup or use encoded entities. Never
      // discard a risky claim merely because it has no exact raw-HTML match.
      const htmlPos = html.indexOf(m[0]);
      const safeHtmlPos = htmlPos >= 0 ? htmlPos : 0;

      // Check if claim is in a protected block (CTA, switcher, schema)
      const beforeClaim = html.substring(0, safeHtmlPos);
      const lastOpenComment = beforeClaim.lastIndexOf("<!--");
      const lastCloseComment = beforeClaim.lastIndexOf("-->");
      if (lastOpenComment > lastCloseComment) continue; // Inside a comment block

      const sectionIndex = findSectionIndex(safeHtmlPos);
      const claimText = decodeHtmlEntities(m[0]).toLowerCase();
      const sentenceText = containingSentence(bodyText, m.index);

      // Quotation marks alone do not turn illustrative copy into a factual
      // testimonial. Suggested post prompts, hypothetical dialogue and calls
      // to action are ordinary editorial examples unless the surrounding
      // sentence explicitly attributes the words to a speaker or source.
      if (quotedText && !hasExplicitQuotationAttribution(sentenceText, m[0])) {
        continue;
      }

      const support = findSupportingEvidence(
        sentenceText,
        claimText,
        category,
        evidenceLedger,
      );
      const quotationHasNamedLink = category !== "testimonial_quote"
        || Boolean(
          support.entry?.url
          && html.includes(`href="${support.entry.url}"`),
        );

      claims.push({
        text: m[0],
        htmlPosition: safeHtmlPos,
        category,
        supported: Boolean(support.entry) && quotationHasNamedLink,
        sentenceText,
        evidenceId: support.entry?.evidenceId,
        evidenceText: support.entry?.approvedText,
        evidenceUrl: support.entry?.url,
        supportReason: quotationHasNamedLink
          ? support.reason
          : "quotation is not accompanied by its named research-source URL",
        sectionIndex,
      });
    }
  }

  const hasHighRisk = claims.some((c) => !c.supported);
  return { claims, hasHighRisk };
}

const DIRECT_ATTRIBUTION_RE = /\b(?:said|says|told(?:\s+us)?|shared|reported|noted|wrote|explained|added|recalled|commented|stated|claimed|observed)\b/i;
const SOURCE_ATTRIBUTION_RE = /\b(?:according to|in an interview|the (?:study|report|survey|research|analysis) (?:said|says|found|noted|reported|states?)|research from|data from)\b/i;
const ILLUSTRATIVE_QUOTE_CONTEXT_RE = /\b(?:for example|for instance|such as|try|ask|prompt|question|conversation starter|post idea|caption|template|you could say|you can say|consider asking|invite (?:people|readers|followers|customers)|use (?:a|the) phrase)\b/i;

/**
 * Generic quoted text is factual only when the sentence attributes it to a
 * speaker or named research source. This deliberately excludes examples such
 * as “Do you agree?” and “What is your biggest challenge?”.
 */
function hasExplicitQuotationAttribution(sentenceText: string, quotedText: string): boolean {
  const quote = decodeHtmlEntities(quotedText).trim();
  const unquoted = quote.replace(/^["“]|["”]$/g, "").trim();
  const context = sentenceText.replace(quotedText, " ").replace(quote, " ");
  const explicitlyAttributed = SOURCE_ATTRIBUTION_RE.test(context)
    || DIRECT_ATTRIBUTION_RE.test(context);

  if (ILLUSTRATIVE_QUOTE_CONTEXT_RE.test(context) && !explicitlyAttributed) return false;
  if (/\[[^\]]+\]/.test(unquoted)) return false;
  if (/\?$/.test(unquoted) && !explicitlyAttributed) return false;

  return explicitlyAttributed;
}

/**
 * Source citations are deterministic pipeline assets, not editorial claims.
 * Excluding the complete block prevents a year or number in a publication
 * title from being reclassified as an unsupported claim.
 */
function stripPipelineCitationParagraphs(html: string): string {
  return html
    .replace(
      /<!--\s*wp:paragraph\s*-->\s*<p\b[^>]*>\s*Sources?:\s*<a\b[\s\S]*?<\/a>\s*\.?\s*<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi,
      "",
    )
    .replace(
      /<p\b[^>]*>\s*Sources?:\s*<a\b[\s\S]*?<\/a>\s*\.?\s*<\/p>/gi,
      "",
    );
}

interface EvidenceSupport {
  entry?: EvidenceLedgerEntry;
  reason: string;
}

const STOP_WORDS = new Set([
  "about", "after", "also", "among", "because", "before", "being", "between",
  "could", "from", "have", "into", "more", "most", "other", "over", "platform",
  "that", "their", "there", "these", "they", "this", "those", "through", "under",
  "using", "with", "would", "threads", "hong", "kong",
]);

const EXCLUSIVE_CONCEPT_GROUPS = [
  ["survey-sample", "general-users"],
  ["monthly-active-users", "advertising-reach"],
  ["brand-follow-none", "brand-follow-preference"],
  ["average", "median"],
];

function findSupportingEvidence(
  sentenceText: string,
  claimFragment: string,
  category: ClaimCategory,
  ledger: EvidenceLedgerEntry[],
): EvidenceSupport {
  if (ledger.length === 0) return { reason: "no research evidence supplied" };

  const claimQuantity = extractFirstQuantity(claimFragment);
  const claimConcepts = extractClaimConcepts(sentenceText);
  const claimTokens = contentTokens(sentenceText);
  const claimGeography = /\b(?:hong kong|hk)\b|香港/i.test(sentenceText)
    ? "hong-kong"
    : "unspecified";
  const claimQualifier = /\bmedian\b/i.test(sentenceText)
    ? "median"
    : /\baverage\b/i.test(sentenceText)
      ? "average"
      : "unspecified";

  let closestReason = claimQuantity === null
    ? "no evidence sentence entails the qualitative claim"
    : "exact quantity not present in compatible evidence";

  for (const entry of ledger) {
    if (
      claimQuantity !== null
      && !entry.quantities.some((quantity) => Math.abs(quantity - claimQuantity) < Number.EPSILON)
    ) {
      continue;
    }
    if (claimGeography === "hong-kong" && entry.geography !== "hong-kong") {
      closestReason = "research quantity has a different geographic scope";
      continue;
    }
    if (
      claimQualifier !== "unspecified"
      && entry.statisticQualifier !== claimQualifier
    ) {
      closestReason = "research uses a different statistical qualifier";
      continue;
    }

    const conceptConflict = findConceptConflict(claimConcepts, entry.concepts);
    if (conceptConflict) {
      closestReason = conceptConflict;
      continue;
    }

    // Survey statistics may never be generalized to all users or residents.
    if (
      entry.concepts.includes("survey-sample")
      && !claimConcepts.includes("survey-sample")
    ) {
      closestReason = "survey respondents were generalized to a broader population";
      continue;
    }

    const evidenceTokens = contentTokens(entry.approvedText);
    const overlap = claimTokens.filter((token) => evidenceTokens.includes(token));
    const requiredOverlap = category === "date_claim"
      ? 1
      : claimQuantity !== null
        ? Math.min(2, Math.max(1, claimTokens.length))
        : Math.min(3, Math.max(2, claimTokens.length));
    const hasSemanticConcept = claimConcepts.some((concept) =>
      entry.concepts.includes(concept),
    );
    if (overlap.length < requiredOverlap && !hasSemanticConcept) {
      closestReason = "quantity matches but the subject or metric does not";
      continue;
    }

    return {
      entry,
      reason: `entailed by ${entry.evidenceId}`,
    };
  }

  return { reason: closestReason };
}

function findConceptConflict(claimConcepts: string[], evidenceConcepts: string[]): string | null {
  for (const group of EXCLUSIVE_CONCEPT_GROUPS) {
    const claim = group.find((concept) => claimConcepts.includes(concept));
    const evidence = group.find((concept) => evidenceConcepts.includes(concept));
    if (claim && evidence && claim !== evidence) {
      if (evidence === "survey-sample" && claim === "general-users") {
        return "survey respondents were generalized to all users";
      }
      return `claim meaning "${claim}" conflicts with evidence meaning "${evidence}"`;
    }
  }
  return null;
}

function extractClaimConcepts(text: string): string[] {
  const normalized = decodeHtmlEntities(text).toLowerCase().replace(/\s+/g, " ");
  const concepts = new Set<string>();
  if (/\b(?:survey|surveyed|respondents?|participants?|sample)\b/.test(normalized)) concepts.add("survey-sample");
  if (/\b(?:hong kong|hk)?\s*(?:threads\s+)?users?\b/.test(normalized)) concepts.add("general-users");
  if (/\bmonthly active users?\b|\bmau\b/.test(normalized)) concepts.add("monthly-active-users");
  if (/\b(?:ad|ads|advertising|potential)\s+(?:audience\s+)?reach\b|\breachable through ads?\b|\bads? can reach\b/.test(normalized)) concepts.add("advertising-reach");
  if (/\b(?:do not|don't|does not|doesn't|never|no)\s+follow\b[^.!?]{0,40}\bbrands?\b|\bfollow no brand/.test(normalized)) concepts.add("brand-follow-none");
  if (/\b(?:prefer|rather)\b[^.!?]{0,70}\b(?:personal|individual)\s+accounts?\b|\bprefer\b[^.!?]{0,50}\bbrand accounts?\b/.test(normalized)) concepts.add("brand-follow-preference");
  if (/\b(?:tried|used|adoption|adopted)\b[^.!?]{0,40}\b(?:threads|platform)\b|\bthreads adoption\b/.test(normalized)) concepts.add("platform-use");
  if (/\b(?:usage|use)\b[^.!?]{0,50}\b(?:increased|decreased|remained|steady|changed)\b/.test(normalized)) concepts.add("platform-usage-change");
  if (/\bengagement rate\b/.test(normalized)) concepts.add("engagement-rate");
  if (/\b(?:posts?|threads?)\s+(?:per|a)\s+(?:day|week|month)\b/.test(normalized)) concepts.add("posting-cadence");
  if (/\b(?:am|pm|peak hours?|most active|posting time|post during)\b/.test(normalized)) concepts.add("posting-time");
  if (/\balgorithm\b/.test(normalized)) concepts.add("algorithm-distribution");
  if (/\bcpms?\b|\bcost per thousand\b/.test(normalized)) concepts.add("cpm");
  if (/\bmeta ads manager\b/.test(normalized)) concepts.add("ads-manager");
  if (/\btargeting\b|\bdemographics\b|\binterests\b|\bbehaviou?rs\b/.test(normalized)) concepts.add("ad-targeting");
  if (/\b(?:average|on average)\b/.test(normalized)) concepts.add("average");
  if (/\bmedian\b/.test(normalized)) concepts.add("median");
  return [...concepts];
}

function contentTokens(text: string): string[] {
  return [...new Set(
    decodeHtmlEntities(text)
      .toLowerCase()
      .replace(/\d+(?:[.,]\d+)*/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
  )];
}

function splitEvidenceSentences(text: string): string[] {
  return sentenceRanges(text)
    .map((range) => text.slice(range.start, range.end).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function containingSentence(text: string, position: number): string {
  for (const range of sentenceRanges(text)) {
    if (position >= range.start && position < range.end) {
      return text.slice(range.start, range.end).replace(/\s+/g, " ").trim();
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

// ── Claim removal from section body ──

export function removeUnsupportedSentences(
  sectionHtml: string,
  unsupportedClaims: ScannedClaim[],
): { html: string; sentencesRemoved: number; orphanedTransitionsRemoved: number } {
  if (unsupportedClaims.length === 0) {
    return { html: sectionHtml, sentencesRemoved: 0, orphanedTransitionsRemoved: 0 };
  }

  let modified = sectionHtml;
  let removed = 0;

  const paragraphRe =
    /<!--\s*wp:paragraph\s*-->\s*\n?<p\b[^>]*>[\s\S]*?<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi;
  const paragraphs = [...sectionHtml.matchAll(paragraphRe)];

  // Work backwards so replacements never invalidate later source positions.
  for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
    const match = paragraphs[paragraphIndex];
    const paragraphHtml = match[0];
    const parsed = parseWordPressEditorialBlocks(
      paragraphHtml,
      `factual-repair-${paragraphIndex}`,
    );
    const paragraph = parsed.blocks[0];
    if (
      parsed.errors.length > 0
      || parsed.blocks.length !== 1
      || paragraph?.type !== "paragraph"
    ) {
      continue;
    }

    const text = paragraph.content.map((node) => node.text).join("");
    const relevantClaims = unsupportedClaims.filter((claim) =>
      normalizeForMatch(text).includes(normalizeForMatch(claim.text)),
    );
    if (relevantClaims.length === 0) continue;

    const ranges = sentenceRanges(text).filter((range) => {
      const sentence = normalizeForMatch(text.slice(range.start, range.end));
      return relevantClaims.some((claim) => sentence.includes(normalizeForMatch(claim.text)));
    });
    if (ranges.length === 0) continue;

    // Links are immutable pipeline assets. If a claimed sentence contains an
    // anchor, leave it for regeneration/rejection rather than deleting the URL.
    const linkedRanges = inlineLinkRanges(paragraph);
    const safeRanges = ranges.filter(
      (range) => !linkedRanges.some((link) => rangesOverlap(range, link)),
    );
    if (safeRanges.length === 0) continue;

    const repaired = removeTextRanges(paragraph, safeRanges);
    const repairedText = repaired.content.map((node) => node.text).join("").trim();
    const replacement = repairedText
      ? renderEditorialBlocksToWordPress([repaired])
      : "";
    const start = match.index ?? 0;
    modified = modified.slice(0, start) + replacement + modified.slice(start + paragraphHtml.length);
    removed += safeRanges.length;
  }

  const nonParagraphCleanup = removeUnsupportedNonParagraphBlocks(
    modified,
    unsupportedClaims,
  );
  modified = nonParagraphCleanup.html;
  removed += nonParagraphCleanup.removed;

  const continuity = repairOrphanedTransitions(modified);
  return {
    html: continuity.html,
    sentencesRemoved: removed,
    orphanedTransitionsRemoved: continuity.removed,
  };
}

function removeUnsupportedNonParagraphBlocks(
  html: string,
  unsupportedClaims: ScannedClaim[],
): { html: string; removed: number } {
  let removed = 0;
  const blockRe =
    /<!--\s*wp:(list|quote|table)(?:\s[\s\S]*?)?\s*-->[\s\S]*?<!--\s*\/wp:\1\s*-->/gi;
  const matches = [...html.matchAll(blockRe)];
  let result = html;

  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const sourceBlock = match[0];
    const parsed = parseWordPressEditorialBlocks(sourceBlock, `factual-nonparagraph-${index}`);
    if (parsed.errors.length > 0 || parsed.blocks.length !== 1) continue;
    const block = parsed.blocks[0];
    let replacement: EditorialBlock | null = block;

    if (block.type === "list") {
      const retained = block.items.filter((item) => {
        const text = item.map((node) => node.text).join("");
        const risky = containsUnsupportedClaim(text, unsupportedClaims);
        if (!risky || item.some((node) => node.type === "link")) return true;
        removed++;
        return false;
      });
      replacement = retained.length > 0 ? { ...block, items: retained } : null;
    } else if (block.type === "quote") {
      const text = block.content.map((node) => node.text).join("");
      if (
        containsUnsupportedClaim(text, unsupportedClaims)
        && !block.content.some((node) => node.type === "link")
      ) {
        replacement = null;
        removed++;
      }
    } else if (block.type === "table") {
      const retainedRows = block.rows.filter((row) => {
        const text = row.flat().map((node) => node.text).join(" ");
        const hasLink = row.flat().some((node) => node.type === "link");
        if (!containsUnsupportedClaim(text, unsupportedClaims) || hasLink) return true;
        removed++;
        return false;
      });
      replacement = retainedRows.length > 0 ? { ...block, rows: retainedRows } : null;
    }

    if (replacement === block) continue;
    const rendered = replacement ? renderEditorialBlocksToWordPress([replacement]) : "";
    const start = match.index ?? 0;
    result = result.slice(0, start) + rendered + result.slice(start + sourceBlock.length);
  }
  return { html: result, removed };
}

function containsUnsupportedClaim(text: string, claims: ScannedClaim[]): boolean {
  const normalized = normalizeForMatch(text);
  return claims.some((claim) =>
    normalized.includes(normalizeForMatch(claim.text))
    || (
      claim.sentenceText
      && normalized.includes(normalizeForMatch(claim.sentenceText))
    ),
  );
}

const ORPHANED_EVIDENCE_TRANSITION_RE =
  /^(?:the (?:numbers|figures|data|statistics) speak for themselves|these (?:numbers|figures|results|findings) (?:show|prove|confirm|demonstrate) (?:it|this|the point)|the research (?:shows|proves|confirms) (?:it|this)|that result is significant|as the (?:numbers|figures|data) (?:above )?(?:show|demonstrate|confirm))\.?$/i;

/**
 * Remove evidence-introducing filler that becomes meaningless after an
 * unsupported factual sentence is deleted. This is intentionally narrow:
 * only a complete standalone sentence matching a known orphan pattern is
 * removed, never arbitrary neighbouring prose.
 */
export function repairOrphanedTransitions(
  html: string,
): { html: string; removed: number } {
  let removed = 0;
  const repaired = html.replace(
    /<!--\s*wp:paragraph\s*-->\s*\n?<p\b[^>]*>([\s\S]*?)<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi,
    (block, inner: string) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      if (!ORPHANED_EVIDENCE_TRANSITION_RE.test(text)) return block;
      removed++;
      return "";
    },
  );
  return {
    html: repaired.replace(/\n{3,}/g, "\n\n").trim(),
    removed,
  };
}

function extractFirstQuantity(text: string): number | null {
  return extractQuantities(text)[0] ?? null;
}

function extractQuantities(text: string): number[] {
  const quantities: number[] = [];
  const regex =
    /\b(\d+(?:\.\d+)?(?:,\d{3})*)\s*(billion|million|thousand|bn|m|k)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const base = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = match[2]?.toLowerCase();
    const multiplier = scale === "billion" || scale === "bn"
      ? 1_000_000_000
      : scale === "million" || scale === "m"
        ? 1_000_000
        : scale === "thousand" || scale === "k"
          ? 1_000
          : 1;
    quantities.push(base * multiplier);
  }
  return quantities;
}

interface TextRange {
  start: number;
  end: number;
}

function normalizeForMatch(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim().toLowerCase();
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (decimal) return decodeCodePoint(decimal, 10, entity);
      if (hexadecimal) return decodeCodePoint(hexadecimal, 16, entity);
      return name ? (named[name.toLowerCase()] ?? entity) : entity;
    },
  );
}

function decodeCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isFinite(codePoint)
    || codePoint < 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
}

function sentenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (
      char === "."
      && /\d/.test(text[index - 1] ?? "")
      && /\d/.test(text[index + 1] ?? "")
    ) {
      continue;
    }
    let end = index + 1;
    while (/[.!?]/.test(text[end] ?? "")) end++;
    while (/["”’)]/.test(text[end] ?? "")) end++;
    if (text.slice(start, end).trim()) ranges.push({ start, end });
    start = end;
    while (/\s/.test(text[start] ?? "")) start++;
    index = start - 1;
  }
  if (start < text.length && text.slice(start).trim()) {
    ranges.push({ start, end: text.length });
  }
  return ranges;
}

function inlineLinkRanges(paragraph: Extract<EditorialBlock, { type: "paragraph" }>): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  for (const node of paragraph.content) {
    const next = cursor + node.text.length;
    if (node.type === "link") ranges.push({ start: cursor, end: next });
    cursor = next;
  }
  return ranges;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function removeTextRanges(
  paragraph: Extract<EditorialBlock, { type: "paragraph" }>,
  ranges: TextRange[],
): Extract<EditorialBlock, { type: "paragraph" }> {
  let cursor = 0;
  const content = paragraph.content.flatMap((node) => {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;
    let retained = "";
    let localCursor = nodeStart;
    for (const range of ranges) {
      if (!rangesOverlap({ start: nodeStart, end: nodeEnd }, range)) continue;
      const keepUntil = Math.max(nodeStart, range.start);
      if (keepUntil > localCursor) {
        retained += node.text.slice(localCursor - nodeStart, keepUntil - nodeStart);
      }
      localCursor = Math.max(localCursor, Math.min(nodeEnd, range.end));
    }
    if (localCursor < nodeEnd) retained += node.text.slice(localCursor - nodeStart);
    retained = retained.replace(/\s+/g, " ");
    return retained ? [{ ...node, text: retained }] : [];
  });

  if (content.length > 0) {
    content[0].text = content[0].text.trimStart();
    content[content.length - 1].text = content[content.length - 1].text.trimEnd();
  }
  return { ...paragraph, content };
}

// ── Format claims for logging ──

export function formatClaimLog(claims: ScannedClaim[]): string {
  const supported = claims.filter((c) => c.supported);
  const unsupported = claims.filter((c) => !c.supported);
  const lines: string[] = [];
  lines.push(`Claims found: ${claims.length} (${unsupported.length} unsupported)`);
  for (const c of unsupported) {
    lines.push(
      `  [UNSUPPORTED] [${c.category}] section=${c.sectionIndex}` +
      ` reason="${c.supportReason ?? "no compatible evidence"}"` +
      ` text="${c.text.substring(0, 80)}"`,
    );
  }
  for (const c of supported) {
    lines.push(
      `  [SUPPORTED]   [${c.category}] section=${c.sectionIndex}` +
      `${c.evidenceId ? ` evidence=${c.evidenceId}` : ""}` +
      ` text="${c.text.substring(0, 80)}"`,
    );
  }
  return lines.join("\n");
}
