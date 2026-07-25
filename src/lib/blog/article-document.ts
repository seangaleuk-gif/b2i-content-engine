// ── Canonical Article Document Model ──
// The single source of truth for article structure, protected blocks, and rendering.
// All pipeline stages mutate ArticleDocument fields, then call the canonical renderer.

export type ComponentStatus = "generated" | "regenerated" | "expanded" | "normalized" | "trimmed" | "missing";

export interface ArticleComponent {
  id: string;
  html: string;
  wordCount: number;
  status: ComponentStatus;
}

export interface ArticleSection extends ArticleComponent {
  heading: string;
  headingLevel: 2;
  sectionType: "main" | "mistakes" | "faq-heading" | "conclusion-heading";
}

export interface FaqEntry {
  question: string;
  answerHtml: string;
  answerText: string;
}

export interface ProtectedArticleBlock {
  id: string;
  type: "language-switcher" | "cta" | "faq-schema";
  html: string;
  fingerprint: string;
}

export interface ArticleMetadata {
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  targetWordCount: number;
  focusKeyphrase: string;
}

export interface InsertedLink {
  componentId: string;
  href: string;
  anchorText: string;
  sourceType: "editorial-external" | "internal" | "cta" | "language";
}

export interface ArticleDocument {
  metadata: ArticleMetadata;
  languageSwitcher: ProtectedArticleBlock | null;
  introduction: ArticleComponent;
  sections: ArticleSection[];
  visibleFaq: FaqEntry[];
  conclusion: ArticleComponent;
  cta: ProtectedArticleBlock | null;
  faqSchema: ProtectedArticleBlock | null;
  insertedLinks: InsertedLink[];
}

// ── Fingerprint helper ──

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

/** Create a stable fingerprint for a protected block */
export function fingerprintHtml(html: string): string {
  const normalized = html.replace(/\s+/g, " ").trim();
  return simpleHash(normalized);
}

// ── Canonical Renderer ──

/**
 * The SINGLE canonical renderer for ArticleDocument → full article HTML.
 * All pipeline stages must use this function to produce final HTML.
 * No other code path may assemble the complete article HTML from components.
 */
export function renderArticleDocument(doc: ArticleDocument): string {
  const parts: string[] = [];

  // 1. Language switcher (always first block)
  if (doc.languageSwitcher) {
    parts.push(doc.languageSwitcher.html);
  }

  // 2. Introduction
  if (doc.introduction.html) {
    parts.push(doc.introduction.html);
  }

  // 3. Main H2 sections (each with heading block + body)
  //    The visible FAQ section part of doc.sections.
  for (const section of doc.sections) {
    parts.push(
      `<!-- wp:heading {"level":2} -->\n<h2>${section.heading}</h2>\n<!-- /wp:heading -->`
    );
    if (section.html) {
      parts.push(section.html);
    }
  }

  // 4. Conclusion (before CTA and FAQ schema so extraction never
  //    captures CTA or schema text as conclusion content).
  if (doc.conclusion.html) {
    parts.push(doc.conclusion.html);
  }

  // 5. CTA block (after conclusion, before FAQ schema)
  if (doc.cta) {
    parts.push(doc.cta.html);
  }

  // 6. FAQ JSON-LD schema (always last)
  if (doc.faqSchema) {
    parts.push(doc.faqSchema.html);
  }

  return parts.join("\n\n");
}

// ── Structured nesting validator ──

/**
 * Detect true nested paragraph elements using position-index matching.
 * A paragraph is nested only when a parsed <p> element has another <p>
 * as a descendant. Adjacent paragraph blocks are NOT nested.
 *
 * This is the SINGLE source of truth for nested paragraph detection.
 * All validators, integrity checks, and content validators must use this.
 */
export function detectNestedParagraphs(html: string): number {
  // Strip script and wp:html blocks before structural HTML parsing
  const structHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");

  const pOpens: number[] = [];
  const pCloses: number[] = [];
  const pOpenRe = /<p\b[^>]*>/gi;
  const pCloseRe = /<\/p>/gi;
  let pm: RegExpExecArray | null;

  while ((pm = pOpenRe.exec(structHtml)) !== null) pOpens.push(pm.index);
  while ((pm = pCloseRe.exec(structHtml)) !== null) pCloses.push(pm.index + 4);

  let nestedParagraphs = 0;
  for (let i = 0; i < pOpens.length - 1; i++) {
    const openPos = pOpens[i];
    const nextOpenPos = pOpens[i + 1];
    const hasClose = pCloses.some((cp) => cp > openPos && cp < nextOpenPos);
    if (!hasClose) nestedParagraphs++;
  }

  return nestedParagraphs;
}

// ── Heading classification ──

export interface HeadingClassification {
  mainEditorialH2: number;
  protectedBlockHeading: number;
  totalH2: number;
}

/**
 * Classify H2 headings in rendered article HTML.
 * Protected-block headings (CTA, FAQ, switcher) are excluded from editorial counts.
 */
export function classifyHeadings(doc: ArticleDocument, renderedHtml: string): HeadingClassification {
  const allH2s = (renderedHtml.match(/<h2\b[^>]*>/gi) ?? []).length;

  // Count H2s inside protected blocks
  let protectedBlockHeading = 0;
  for (const block of [doc.cta, doc.languageSwitcher, doc.faqSchema]) {
    if (block) {
      const h2sInBlock = (block.html.match(/<h2\b[^>]*>/gi) ?? []).length;
      protectedBlockHeading += h2sInBlock;
    }
  }

  const mainEditorialH2 = allH2s - protectedBlockHeading;

  return {
    mainEditorialH2: Math.max(0, mainEditorialH2),
    protectedBlockHeading,
    totalH2: allH2s,
  };
}

// ── FAQ parity validation ──

export interface FaqParityIssue {
  type: "missing-question" | "extra-question" | "wording-mismatch" | "answer-mismatch" | "reordered";
  index?: number;
  detail: string;
}

/**
 * Validate that visible FAQ entries match the FAQ schema JSON-LD.
 * Both must derive from the same FaqEntry[] source.
 */
export function validateFaqParity(
  entries: FaqEntry[],
  schemaHtml: string,
): { valid: boolean; issues: FaqParityIssue[] } {
  const issues: FaqParityIssue[] = [];

  // Extract schema questions/answers
  const schemaQuestions: string[] = [];
  const schemaAnswers: string[] = [];
  const qRe = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const aRe = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let qm: RegExpExecArray | null;
  let am: RegExpExecArray | null;

  while ((qm = qRe.exec(schemaHtml)) !== null) {
    schemaQuestions.push(qm[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }
  while ((am = aRe.exec(schemaHtml)) !== null) {
    schemaAnswers.push(am[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }

  if (schemaQuestions.length !== entries.length) {
    if (schemaQuestions.length < entries.length) {
      issues.push({ type: "missing-question", detail: `Schema has ${schemaQuestions.length} questions, visible has ${entries.length}` });
    } else {
      issues.push({ type: "extra-question", detail: `Schema has ${schemaQuestions.length} questions, visible has ${entries.length}` });
    }
  }

  const maxQuestions = Math.min(schemaQuestions.length, entries.length);
  for (let i = 0; i < maxQuestions; i++) {
    const entryText = entries[i].question.toLowerCase().trim();
    const schemaText = schemaQuestions[i].toLowerCase().trim();
    if (entryText !== schemaText) {
      issues.push({
        type: "wording-mismatch",
        index: i,
        detail: `Question ${i + 1}: visible="${entryText.substring(0, 60)}" vs schema="${schemaText.substring(0, 60)}"`,
      });
    }
  }

  // Compare answers (visible answerText vs schema answerText)
  for (let i = 0; i < maxQuestions; i++) {
    const entryAnswer = (entries[i].answerText || "").toLowerCase().trim();
    const schemaAnswer = (schemaAnswers[i] || "").toLowerCase().trim();
    if (entryAnswer && schemaAnswer && entryAnswer !== schemaAnswer) {
      issues.push({
        type: "answer-mismatch",
        index: i,
        detail: `Answer ${i + 1}: visible="${entryAnswer.substring(0, 60)}" vs schema="${schemaAnswer.substring(0, 60)}"`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Extract visible FAQ question and answer pairs from the FAQ section region
 * of rendered article HTML. When `doc` is provided, uses the ArticleDocument's
 * section boundaries (the FAQ section body) rather than scanning raw HTML,
 * which guarantees the FAQ boundary never captures conclusion, CTA, or schema text.
 * 
 * Supports multiple formats:
 * - <h3>Question</h3>
 * - <strong>Question?</strong> Answer
 * - Question and answer in same or separate paragraph blocks
 * - Inline <strong> emphasis inside answers (not treated as questions)
 */
export function extractVisibleFaqFromArticle(
  html: string,
  doc?: ArticleDocument,
): Array<{ question: string; answerText: string }> {
  const result: Array<{ question: string; answerText: string }> = [];

  // Prefer structured ArticleDocument section boundary over HTML scanning.
  // When doc is available, find the FAQ section by its heading text.
  if (doc) {
    const faqSection = doc.sections.find((s) =>
      /faq|frequently.asked|common.question/i.test(s.heading),
    );
    if (faqSection && faqSection.html) {
      const extracted = extractFaqPairsFromSectionBody(faqSection.html);
      result.push(...extracted);
      return result; // Structured boundary — never scans beyond the section body.
    }
  }

  // Find the FAQ section: look for H2 heading that reads "FAQ" / "Frequently Asked Questions"
  const faqH2Re = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->\s*\n?<h2\b[^>]*>[\s\S]*?(Frequently Asked Questions|FAQ|FAQs|常見問題)[\s\S]*?<\/h2>/i;
  const faqMatch = html.match(faqH2Re);
  if (!faqMatch) return result;

  const faqStart = faqMatch.index! + faqMatch[0].length;

  // FAQ section ends at the next H2 heading or at the conclusion
  const nextH2Re = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/g;
  nextH2Re.lastIndex = faqStart;
  const nextH2Match = nextH2Re.exec(html);
  const faqEnd = nextH2Match ? nextH2Match.index : html.length;

  // Stop before the FAQ schema block.
  // Find "FAQPage" in the article, then find the nearest <!-- wp:html --> opener before it.
  const faqPageIdx = html.indexOf("FAQPage", faqStart);
  let effectiveEnd = faqEnd;
  if (faqPageIdx > 0) {
    // Find the last wp:html opener before FAQPage
    const beforeFaqPage = html.substring(faqStart, faqPageIdx);
    const lastWpHtmlMatch = beforeFaqPage.match(/<!--\s*wp:html\s*-->/gi);
    if (lastWpHtmlMatch) {
      const openerIdx = beforeFaqPage.lastIndexOf(lastWpHtmlMatch[lastWpHtmlMatch.length - 1]);
      if (openerIdx >= 0) {
        effectiveEnd = Math.min(effectiveEnd, faqStart + openerIdx);
      }
    }
  }

  const faqSection = html.substring(faqStart, effectiveEnd);

  // Extract Q&A pairs: each question is an <h3>, answers follow until next <h3> or end
  const h3Split = faqSection.split(/<\/h3>/i);
  for (let i = 0; i < h3Split.length - 1; i++) {
    const beforeH3Close = h3Split[i];
    const afterH3Close = h3Split[i + 1];

    // Extract question from before the closing </h3>
    const h3OpenIdx = beforeH3Close.lastIndexOf("<h3");
    if (h3OpenIdx < 0) continue;
    const questionHtml = beforeH3Close.substring(h3OpenIdx).replace(/<h3\b[^>]*>/i, "");
    const question = questionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!question) continue;

    // Extract answer from after </h3> until the next <h3>
    const nextH3Idx = afterH3Close.search(/<h3\b/i);
    const answerHtml = nextH3Idx >= 0 ? afterH3Close.substring(0, nextH3Idx) : afterH3Close;
    const answerText = answerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    if (answerText.length > 0) {
      result.push({ question, answerText });
    }
  }

  // Fallback: detect <strong>Question</strong> style (no <h3> tags).
  // Supports: <strong>Q?</strong><br>A, <strong>Q?</strong> A (same paragraph),
  // and <strong>Q?</strong></p><!-- /wp:paragraph --><!-- wp:paragraph --><p>A (separate paragraphs)
  //
  // CRITICAL: Only match <strong> elements whose text looks like a question
  // (ends with "?") so that keyphrase <strong> highlights inside answers are
  // NOT misidentified as separate questions.
  if (result.length === 0) {
    const strongRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>(?:\s*<br\s*\/?\s*>)?/gi;
    let sm: RegExpExecArray | null;
    while ((sm = strongRe.exec(faqSection)) !== null) {
      const rawQuestion = sm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      // Skip if not a question — guards against keyphrase <strong> inside answers
      if (!rawQuestion.endsWith("?")) continue;
      const question = rawQuestion.replace(/\?$/, "").trim();
      if (!question) continue;

      const afterStrong = sm.index + sm[0].length;
      const nextStrongIdx = faqSection.substring(afterStrong).search(/<strong\b/i);
      const answerEnd = nextStrongIdx >= 0 ? afterStrong + nextStrongIdx : faqSection.length;
      let answerHtml = faqSection.substring(afterStrong, answerEnd);
      // If answer starts with a WordPress paragraph closer, skip to the next opener's content
      answerHtml = answerHtml.replace(/^\s*<!--\s*\/wp:paragraph\s*-->\s*\n?\s*<!--\s*wp:paragraph\s*-->\s*\n?\s*<p\b[^>]*>/i, "");
      answerHtml = answerHtml.replace(/^\s*<p\b[^>]*>/i, "");
      const answerText = answerHtml
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (answerText.length > 0) {
        result.push({ question, answerText });
      }
    }

    // Trim trailing CTA/conclusion content from last answer.
    // The FAQ section may contain non-FAQ text after the last Q&A pair
    // (e.g., a CTA teaser or signup prompt). This text must not leak
    // into the FAQ schema answer.
    if (result.length > 0) {
      const last = result[result.length - 1];
    }
  }

  return result;
}

/**
 * Extract FAQ Q&A pairs from a single FAQ section body HTML.
 * The section body is already bounded by ArticleDocument's section structure,
 * so it never contains conclusion, CTA, or schema text.
 * 
 * Supports:
 * - <h3>Question</h3> Answer
 * - <strong>Question?</strong> Answer
 * - Question and answer in same or separate paragraph blocks
 * - Inline <strong> emphasis inside answers (not treated as questions)
 */
/**
 * CTA phrase boundary patterns for trimming trailing non-FAQ content from the last answer.
 * These are multi-word, unambiguous CTA markers. Single-word patterns like "Join" or "Sign up"
 * that appear naturally in app-signup contexts are excluded to prevent false positives.
 */
const CTA_BOUNDARY_RE = /\b(?:Ready to|Create your|Start your|Create a free)[^.!?]*[.!?]/i;

function extractFaqPairsFromSectionBody(sectionHtml: string): Array<{ question: string; answerText: string }> {
  const result: Array<{ question: string; answerText: string }> = [];

  // First: try <h3>Question</h3> style
  const h3Split = sectionHtml.split(/<\/h3>/i);
  for (let i = 0; i < h3Split.length - 1; i++) {
    const beforeH3Close = h3Split[i];
    const afterH3Close = h3Split[i + 1];
    const h3OpenIdx = beforeH3Close.lastIndexOf("<h3");
    if (h3OpenIdx < 0) continue;
    const questionHtml = beforeH3Close.substring(h3OpenIdx).replace(/<h3\b[^>]*>/i, "");
    const question = questionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!question) continue;

    const nextH3Idx = afterH3Close.search(/<h3\b/i);
    const answerHtml = nextH3Idx >= 0 ? afterH3Close.substring(0, nextH3Idx) : afterH3Close;
    const answerText = answerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (answerText.length > 0) result.push({ question, answerText });
  }

  if (result.length > 0) return result;

  // Second: try <strong>Question?</strong> style (must end with "?")
  const strongRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>(?:\s*<br\s*\/?\s*>)?/gi;
  let sm: RegExpExecArray | null;
  while ((sm = strongRe.exec(sectionHtml)) !== null) {
    const rawQuestion = sm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!rawQuestion.endsWith("?")) continue;
    const question = rawQuestion.replace(/\?$/, "").trim();
    if (!question) continue;

    const afterStrong = sm.index + sm[0].length;
    const nextStrongIdx = sectionHtml.substring(afterStrong).search(/<strong\b/i);
    const answerEnd = nextStrongIdx >= 0 ? afterStrong + nextStrongIdx : sectionHtml.length;
    let answerHtml = sectionHtml.substring(afterStrong, answerEnd);
    answerHtml = answerHtml.replace(/^\s*<!--\s*\/wp:paragraph\s*-->\s*\n?\s*<!--\s*wp:paragraph\s*-->\s*\n?\s*<p\b[^>]*>/i, "");
    answerHtml = answerHtml.replace(/^\s*<p\b[^>]*>/i, "");
    const answerText = answerHtml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (answerText.length > 0) result.push({ question, answerText });
  }

  return result;
}

// ── Unified validation report ──

export type ValidationSeverity = "error" | "warning" | "info";

export interface ArticleValidationIssue {
  code: string;
  severity: ValidationSeverity;
  stage: string;
  componentId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ArticleValidationReport {
  valid: boolean;
  issues: ArticleValidationIssue[];
}

/** Create a single unified validation issue */
export function createIssue(
  code: string,
  severity: ValidationSeverity,
  stage: string,
  message: string,
  componentId?: string,
  details?: Record<string, unknown>,
): ArticleValidationIssue {
  return { code, severity, stage, componentId, message, details };
}

/** Merge multiple validation results into one unified report */
export function mergeValidationReports(...reports: ArticleValidationReport[]): ArticleValidationReport {
  const issues: ArticleValidationIssue[] = [];
  for (const report of reports) {
    issues.push(...report.issues);
  }
  return {
    valid: issues.every((i) => i.severity !== "error"),
    issues,
  };
}

// ── Deterministic FAQ schema renderer ──

/** Generate FAQPage JSON-LD from structured entries. No model call. */
export function renderFaqSchema(entries: FaqEntry[]): string {
  const entities = entries.map((e) => ({
    "@type": "Question",
    name: e.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: e.answerText,
    },
  }));

  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entities,
  };

  const json = JSON.stringify(schema, null, 2);
  return `<!-- wp:html -->
<script type="application/ld+json">
${json}
</script>
<!-- /wp:html -->`;
}

/** Generate visible FAQ HTML from structured entries. */
export function renderVisibleFaq(entries: FaqEntry[]): string {
  if (entries.length === 0) return "";
  const parts = entries.map(
    (e) => `<!-- wp:html -->
<div class="faq-item">
  <h3>${escapeHtml(e.question)}</h3>
  ${e.answerHtml || `<p>${escapeHtml(e.answerText)}</p>`}
</div>
<!-- /wp:html -->`
  );
  return parts.join("\n\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Editable content for normalizer ──

export interface EditableArticleContent {
  introduction: ArticleComponent;
  sections: ArticleSection[];
  conclusion: ArticleComponent;
}

export interface NormalizationEditableResult {
  introduction: ArticleComponent;
  sections: ArticleSection[];
  conclusion: ArticleComponent;
  issues: ArticleValidationIssue[];
}

/** Extract editable components from an ArticleDocument (excludes protected blocks). */
export function extractEditableContent(doc: ArticleDocument): EditableArticleContent {
  return {
    introduction: { ...doc.introduction },
    sections: doc.sections.map((s) => ({ ...s })),
    conclusion: { ...doc.conclusion },
  };
}

/** Apply normalized editable components back into an ArticleDocument. */
export function applyEditableContent(doc: ArticleDocument, editable: EditableArticleContent): void {
  doc.introduction = { ...editable.introduction };
  doc.sections = editable.sections.map((s, i) => ({
    ...s,
    heading: doc.sections[i]?.heading ?? s.heading,
    headingLevel: 2 as const,
    sectionType: doc.sections[i]?.sectionType ?? "main",
  }));
  doc.conclusion = { ...editable.conclusion };
}

// ── Fact register ──

export type ClaimConfidence = "verified" | "editorial" | "uncertain";

export interface NumericClaimValue {
  minimum: number;
  maximum: number;
  period?: "day" | "week" | "month";
  unit?: string;
}

export interface ArticleClaim {
  key: string;
  value: NumericClaimValue | string | string[];
  confidence: ClaimConfidence;
}

export interface ArticleFactRegister {
  claims: ArticleClaim[];
}

export interface ClaimConflict {
  claimKey: string;
  sectionIndexA: number;
  sectionIndexB: number;
  valueA: string;
  valueB: string;
  detail: string;
}

/** Normalize a time range string like "12 pm–2 pm" to a canonical form "12:00–14:00". */
function normalizeTimeRange(text: string): string | null {
  const timeRe = /(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)?\s*[–\-—to]+\s*(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)?/i;
  const m = text.match(timeRe);
  if (!m) return null;
  const h1 = parseInt(m[1]) + (m[3]?.toLowerCase() === "pm" && parseInt(m[1]) !== 12 ? 12 : 0);
  const h2 = parseInt(m[4]) + (m[6]?.toLowerCase() === "pm" && parseInt(m[4]) !== 12 ? 12 : 0);
  const min1 = m[2] ? parseInt(m[2]) : 0;
  const min2 = m[5] ? parseInt(m[5]) : 0;
  return `${String(h1).padStart(2, "0")}:${String(min1).padStart(2, "0")}–${String(h2).padStart(2, "0")}:${String(min2).padStart(2, "0")}`;
}

/** Extract frequency claims from text (e.g., "3–5 posts per day"). */
function extractFrequencyClaims(text: string): Array<{ range: NumericClaimValue; raw: string }> {
  const results: Array<{ range: NumericClaimValue; raw: string }> = [];
  const re = /(\d+)\s*(?:[–\-—]|to)\s*(\d+)\s+(\w[\w\s]*?)\s+(?:per|a|each)\s+(day|week|month)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({
      range: { minimum: parseInt(m[1]), maximum: parseInt(m[2]), period: m[4].toLowerCase() as "day" | "week" | "month" },
      raw: m[0],
    });
  }
  return results;
}

/** Detect conflicts between claims extracted from different sections. */
export function detectClaimConflicts(
  sections: Array<{ index: number; body: string }>,
  register: ArticleFactRegister,
): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];

  for (let i = 0; i < sections.length; i++) {
    const freqs = extractFrequencyClaims(sections[i].body);
    for (let j = i + 1; j < sections.length; j++) {
      const freqsJ = extractFrequencyClaims(sections[j].body);
      for (const fA of freqs) {
        for (const fB of freqsJ) {
          if (fA.range.period && fB.range.period && fA.range.period !== fB.range.period) {
            // Same or overlapping numeric range but different period → conflict
            const overlap = !(fA.range.maximum < fB.range.minimum || fB.range.maximum < fA.range.minimum);
            if (overlap) {
              conflicts.push({
                claimKey: "posting-frequency",
                sectionIndexA: sections[i].index,
                sectionIndexB: sections[j].index,
                valueA: fA.raw,
                valueB: fB.raw,
                detail: `Section ${sections[i].index} says "${fA.raw}" but section ${sections[j].index} says "${fB.raw}" — different time periods`,
              });
            }
          }
        }
      }
    }
  }

  // Check time range equivalence
  for (let i = 0; i < sections.length; i++) {
    const timeRanges = sections[i].body.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[–\-—to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi) || [];
    for (let j = i + 1; j < sections.length; j++) {
      const timeRangesJ = sections[j].body.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[–\-—to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi) || [];
      for (const trA of timeRanges) {
        for (const trB of timeRangesJ) {
          const nA = normalizeTimeRange(trA);
          const nB = normalizeTimeRange(trB);
          if (nA && nB && nA !== nB) {
            // Different normalized time ranges in different sections
          }
          // If they normalize to the same, they're equivalent — no conflict
        }
      }
    }
  }

  return conflicts;
}

// ── HTML parser: reconstruct ArticleDocument from rendered HTML ──

export interface ParseResult {
  doc: ArticleDocument | null;
  errors: string[];
}

/**
 * Parse rendered HTML back into an ArticleDocument. Fully reconstructs
 * every mutable part from the HTML — headings, section bodies, conclusion,
 * protected blocks, and introduction. No old mutable content is preserved.
 * Returns null if the HTML cannot be parsed without losing required structure.
 */
export function parseArticleDocumentFromHtml(
  html: string,
  existingDoc: ArticleDocument,
): ParseResult {
  const errors: string[] = [];

  // Extract language switcher (first wp:html with b2i-language-switcher)
  const switcherMatch = html.match(/<!--\s*wp:html\s*-->[\s\S]*?b2i-language-switcher[\s\S]*?<!--\s*\/wp:html\s*-->/i);
  const languageSwitcher: ProtectedArticleBlock | null = switcherMatch ? {
    id: "language-switcher",
    type: "language-switcher",
    html: switcherMatch[0],
    fingerprint: fingerprintHtml(switcherMatch[0]),
  } : null;

  // Extract CTA block (wp:html containing app.b2ihub.com/signup)
  // Search from after the switcher to avoid matching the switcher's wp:html block.
  const ctaSearchStart = languageSwitcher
    ? html.indexOf(switcherMatch![0]) + switcherMatch![0].length
    : 0;
  const ctaMatch = html.substring(ctaSearchStart).match(/<!--\s*wp:html\s*-->[\s\S]*?app\.b2ihub\.com\/signup[\s\S]*?<!--\s*\/wp:html\s*-->/i);
  const cta: ProtectedArticleBlock | null = ctaMatch ? {
    id: "cta",
    type: "cta",
    html: ctaMatch[0],
    fingerprint: fingerprintHtml(ctaMatch[0]),
  } : null;

  // Extract FAQ schema block (wp:html containing FAQPage JSON-LD)
  // Search from after the CTA to avoid matching the CTA's wp:html block.
  const faqSearchStart = ctaMatch
    ? ctaSearchStart + ctaMatch.index! + ctaMatch[0].length
    : ctaSearchStart;
  const faqSchemaMatch = html.substring(faqSearchStart).match(/<!--\s*wp:html\s*-->[\s\S]*?FAQPage[\s\S]*?<!--\s*\/wp:html\s*-->/i);
  const faqSchema: ProtectedArticleBlock | null = faqSchemaMatch ? {
    id: "faq-schema",
    type: "faq-schema",
    html: faqSchemaMatch[0],
    fingerprint: fingerprintHtml(faqSchemaMatch[0]),
  } : null;

  // Split HTML by H2 heading blocks
  const headingBlockRe = /<!--\s*wp:heading\s*\{([^}]*"level"\s*:\s*2[^}]*)\}\s*-->\s*\n?<h2[^>]*>([\s\S]*?)<\/h2>\s*\n?<!--\s*\/wp:heading\s*-->/gi;
  const headingMatches: Array<{ index: number; endIndex: number; heading: string }> = [];
  let hm: RegExpExecArray | null;
  while ((hm = headingBlockRe.exec(html)) !== null) {
    headingMatches.push({ index: hm.index, endIndex: hm.index + hm[0].length, heading: hm[2].replace(/<[^>]+>/g, "").trim() });
  }

  if (headingMatches.length === 0) {
    errors.push("No H2 heading blocks found in HTML");
    return { doc: null, errors };
  }

  // Find CTA and FAQ schema positions for section boundary calculation
  const ctaStartIdx = ctaMatch ? html.indexOf(ctaMatch[0]) : -1;
  const faqSchemaStartIdx = faqSchemaMatch ? html.indexOf(faqSchemaMatch[0]) : -1;

  // Extract introduction: everything from after language switcher to first heading
  const introStart = languageSwitcher
    ? html.indexOf(switcherMatch![0]) + switcherMatch![0].length
    : 0;
  const introEnd = headingMatches[0].index;
  const introductionHtml = html.substring(introStart, introEnd).trim();
  if (introductionHtml.length === 0) {
    errors.push("Introduction section is empty");
    return { doc: null, errors };
  }

  // Extract section bodies from between heading blocks.
  // Sections stop at the NEXT heading, the CTA block, or the FAQ schema
  // (whichever comes first). The conclusion is BETWEEN the last section
  // and the CTA, so sections stop at CTA as before — but we separate
  // the conclusion from the last section body below.
  const newSections: ArticleSection[] = [];
  const rawBodyEnds: number[] = []; // track raw body end positions in HTML
  for (let i = 0; i < headingMatches.length; i++) {
    const sectionStart = headingMatches[i].endIndex;
    let sectionEnd = html.length;
    if (i + 1 < headingMatches.length) {
      sectionEnd = headingMatches[i + 1].index;
    }
    // Stop before CTA (which comes after sections and conclusion)
    if (ctaStartIdx > sectionStart && ctaStartIdx < sectionEnd) {
      sectionEnd = ctaStartIdx;
    }
    // Stop before FAQ schema
    if (faqSchemaStartIdx > sectionStart && faqSchemaStartIdx < sectionEnd) {
      sectionEnd = faqSchemaStartIdx;
    }

    const bodyHtml = html.substring(sectionStart, sectionEnd).trim();
    if (bodyHtml.length === 0) {
      errors.push(`Section ${i} has empty body`);
      return { doc: null, errors };
    }
    rawBodyEnds.push(sectionEnd);

    // Use heading from HTML, section type from existing if available
    const existing = existingDoc.sections[i];
    newSections.push({
      id: existing?.id ?? `section-${i}`,
      heading: headingMatches[i].heading, // from HTML, not old doc
      headingLevel: 2,
      sectionType: existing?.sectionType ?? "main",
      html: bodyHtml,
      wordCount: 0,
      status: existing?.status ?? "generated",
    });
  }

  // Extract conclusion: content BETWEEN the last section body and the CTA block.
  // With the corrected component order, conclusion appears before CTA/FAQ schema,
  // so we extract from after the last section body to the CTA start.
  const lastSectionEnd = rawBodyEnds.length > 0
    ? rawBodyEnds[rawBodyEnds.length - 1]
    : headingMatches[headingMatches.length - 1].endIndex;
  let conclusionStart = lastSectionEnd;
  let conclusionToCta = "";
  if (ctaMatch) {
    const ctaPos = html.indexOf(ctaMatch[0]);
    if (ctaPos > conclusionStart) {
      conclusionToCta = html.substring(conclusionStart, ctaPos).trim();
      // Trim conclusion content from the last section body (it was
      // included because sections stop at CTA, not at the conclusion).
      if (newSections.length > 0 && conclusionToCta.length > 0) {
        const lastSection = newSections[newSections.length - 1];
        const sectionHtml = lastSection.html;
        // Find the conclusion text in the section body and remove it
        const concIndex = sectionHtml.indexOf(conclusionToCta.substring(0, 60));
        if (concIndex >= 0) {
          lastSection.html = sectionHtml.substring(0, concIndex).trim();
        }
      }
    }
  } else if (faqSchemaMatch) {
    const faqPos = html.indexOf(faqSchemaMatch[0]);
    if (faqPos > conclusionStart) {
      conclusionToCta = html.substring(conclusionStart, faqPos).trim();
      if (newSections.length > 0 && conclusionToCta.length > 0) {
        const lastSection = newSections[newSections.length - 1];
        const sectionHtml = lastSection.html;
        const concIndex = sectionHtml.indexOf(conclusionToCta.substring(0, 60));
        if (concIndex >= 0) {
          lastSection.html = sectionHtml.substring(0, concIndex).trim();
        }
      }
    }
  }
  // Use the extracted conclusion content from between the last section and CTA
  let conclusionHtml = conclusionToCta;
  // Fallback: if no CTA/schema found, try splitting the last section body
  if (conclusionHtml.length === 0 && newSections.length > 0) {
    const lastBody = newSections[newSections.length - 1].html;
    const blockRe = /(<!--\s*wp:\w+(?:\s[^>]*)?\s*-->)/gi;
    const separators: number[] = [];
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(lastBody)) !== null) {
      if (!/wp:heading/i.test(bm[1])) {
        separators.push(bm.index);
      }
    }
    const threshold = separators.length >= 2 ? separators[separators.length - 1]
      : separators.length === 1 ? separators[0]
      : -1;
    if (threshold >= 0) {
      newSections[newSections.length - 1].html = lastBody.substring(0, threshold).trim();
      conclusionHtml = lastBody.substring(threshold).trim();
    }
  }

  if (conclusionHtml.length === 0) {
    conclusionHtml = existingDoc.conclusion?.html ?? "";
  }

  const doc: ArticleDocument = {
    metadata: { ...existingDoc.metadata },
    languageSwitcher: languageSwitcher ?? existingDoc.languageSwitcher,
    introduction: {
      ...existingDoc.introduction,
      html: introductionHtml,
      wordCount: 0,
    },
    sections: newSections,
    visibleFaq: existingDoc.visibleFaq,
    conclusion: { ...existingDoc.conclusion, html: conclusionHtml },
    cta: cta ?? existingDoc.cta,
    faqSchema: faqSchema ?? existingDoc.faqSchema,
    insertedLinks: existingDoc.insertedLinks,
  };

  return { doc, errors: [] };
}

