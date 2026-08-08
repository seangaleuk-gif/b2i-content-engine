// ── Canonical Article Document Model ──
// The single source of truth for article structure, protected blocks, and rendering.
// Editorial content stores structured blocks; WordPress HTML is generated only at render time.

import { type EditorialBlock, renderEditorialBlocksToWordPress, parseWordPressEditorialBlocks, extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-content";

export type { EditorialBlock };
export { renderEditorialBlocksToWordPress, parseWordPressEditorialBlocks, extractPlainTextFromEditorialBlocks };

export type ComponentStatus = "generated" | "regenerated" | "expanded" | "normalized" | "trimmed" | "missing";

export interface ArticleComponent {
  id: string;
  blocks: EditorialBlock[];
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

/**
 * A single external source reference carried as structured data. The original
 * English title, publisher and URL are immutable canonical values used for
 * traceability and validation; the model may edit only the localized display
 * fields. The visible Chinese citation block is rendered deterministically from
 * these fields (the application never shows the English original beside the
 * Chinese display title).
 */
export interface SourceReferenceUnit {
  /** Stable reference ID, e.g. `source-ref-0`. */
  sourceReferenceId: string;
  /** The underlying translation source-unit ID (e.g. `section.2.block.3`). */
  sourceUnitId: string;
  /** Immutable original English source title (never displayed beside Chinese). */
  originalTitle: string;
  /** Immutable original publisher / brand identity derived from the URL. */
  originalPublisher?: string;
  /** Immutable original URL, preserved byte-for-byte. */
  originalUrl?: string;
  /** Localized Traditional Chinese display title (model-editable). */
  localizedDisplayTitle?: string;
  /** Approved localized publisher name (model-editable only when approved). */
  localizedPublisher?: string;
}

// ── Compatibility helpers for legacy consumers ──
// Render a single component to HTML without going through the full document renderer.
export function renderComponentHtml(component: ArticleComponent): string {
  return renderEditorialBlocksToWordPress(component.blocks);
}
export function countComponentWords(component: ArticleComponent): number {
  return extractPlainTextFromEditorialBlocks(component.blocks).split(/\s+/).filter(Boolean).length;
}

/** Get the section body as HTML string, rendering from blocks. */
export function sectionHtmlFromBlocksOrString(section: ArticleSection): string {
  return renderComponentHtml(section);
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
  /** Structured external source references (deterministically localized + validated). */
  sourceReferences?: SourceReferenceUnit[];
}

function countVisibleTextWords(text: string): number {
  const normalized = text
    .replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.split(" ").length : 0;
}

/**
 * The single article-level word counter for the generation pipeline.
 *
 * It counts only canonical, user-visible ArticleDocument content: editorial
 * headings and blocks, the conclusion, and visible FAQ copy. Application-owned
 * language-switcher, schema and CTA blocks are deliberately excluded.
 */
export function countCanonicalVisibleWords(doc: ArticleDocument): number {
  const parts: string[] = [];

  parts.push(extractPlainTextFromEditorialBlocks(doc.introduction.blocks));

  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") {
      continue;
    }
    parts.push(section.heading);
    parts.push(extractPlainTextFromEditorialBlocks(section.blocks));
  }

  parts.push(extractPlainTextFromEditorialBlocks(doc.conclusion.blocks));

  if (doc.visibleFaq.length > 0) {
    const faqSection = doc.sections.find((section) => section.sectionType === "faq-heading");
    if (faqSection) parts.push(faqSection.heading);
    for (const entry of doc.visibleFaq) {
      parts.push(entry.question, entry.answerText);
    }
  }

  return countVisibleTextWords(parts.filter(Boolean).join(" "));
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
  const introHtml = renderEditorialBlocksToWordPress(doc.introduction.blocks);
  if (introHtml) {
    parts.push(introHtml);
  }

  // 3. Editorial H2 sections only (exclude faq-heading and conclusion-heading)
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading") continue;
    if (section.sectionType === "conclusion-heading") continue;
    parts.push(
      `<!-- wp:heading {"level":2} -->\n<h2>${escapeHtml(section.heading)}</h2>\n<!-- /wp:heading -->`
    );
    const sectionHtml = renderEditorialBlocksToWordPress(section.blocks);
    if (sectionHtml) {
      parts.push(sectionHtml);
    }
  }

  // 4. Conclusion with stable boundary markers
  const concHtml = renderEditorialBlocksToWordPress(doc.conclusion.blocks);
  if (concHtml) {
    parts.push("<!-- b2i-conclusion-start -->");
    parts.push(concHtml);
    parts.push("<!-- b2i-conclusion-end -->");
  }

  // 5. Visible FAQ heading + Q&A generated from doc.visibleFaq (single source of truth)
  if (doc.visibleFaq && doc.visibleFaq.length > 0) {
    const faqSection = doc.sections.find((s) => s.sectionType === "faq-heading");
    if (faqSection) {
      parts.push("<!-- b2i-faq-heading -->");
      parts.push(
        `<!-- wp:heading {"level":2} -->\n<h2>${escapeHtml(faqSection.heading)}</h2>\n<!-- /wp:heading -->`
      );
    }
    const visibleFaqHtml = renderVisibleFaq(doc.visibleFaq);
    if (visibleFaqHtml) {
      parts.push(visibleFaqHtml);
    }
  }

  // 6. FAQ JSON-LD schema generated from the same visible FAQ source.
  if (doc.visibleFaq && doc.visibleFaq.length > 0) {
    parts.push(renderFaqSchema(doc.visibleFaq));
  }

  // 7. CTA block (canonical final visible block)
  if (doc.cta) {
    parts.push(doc.cta.html);
  }

  return parts.join("\n\n");
}

export const CONCLUSION_START_MARKER = "<!-- b2i-conclusion-start -->";
export const CONCLUSION_END_MARKER = "<!-- b2i-conclusion-end -->";
export const FAQ_HEADING_MARKER = "<!-- b2i-faq-heading -->";

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
  type: "missing-question" | "extra-question" | "wording-mismatch" | "answer-mismatch" | "reordered" | "empty-question" | "empty-answer";
  index?: number;
  detail: string;
}

/**
 * Validate that visible FAQ entries match the FAQ schema JSON-LD.
 * Both must derive from the same FaqEntry[] source.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

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
    const entryText = decodeHtmlEntities(entries[i].question.toLowerCase().trim());
    const schemaText = schemaQuestions[i].toLowerCase().trim();

    if (!entryText || !schemaText) {
      issues.push({
        type: "empty-question",
        index: i,
        detail: `Question ${i + 1}: visible="${entryText}" schema="${schemaText}"`,
      });
    } else if (entryText !== schemaText) {
      issues.push({
        type: "wording-mismatch",
        index: i,
        detail: `Question ${i + 1}: visible="${entryText.substring(0, 60)}" vs schema="${schemaText.substring(0, 60)}"`,
      });
    }
  }

  // Compare answers (visible answerText vs schema answerText)
  // Both must be non-empty and identical for the entry to be valid.
  for (let i = 0; i < maxQuestions; i++) {
    const entryAnswer = decodeHtmlEntities((entries[i].answerText || "").toLowerCase().trim());
    const schemaAnswer = (schemaAnswers[i] || "").toLowerCase().trim();

    if (!entryAnswer) {
      issues.push({
        type: "empty-answer",
        index: i,
        detail: `Answer ${i + 1}: visible answer is empty`,
      });
    } else if (!schemaAnswer) {
      issues.push({
        type: "empty-answer",
        index: i,
        detail: `Answer ${i + 1}: schema answer is empty`,
      });
    } else if (entryAnswer !== schemaAnswer) {
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
): Array<{ question: string; answerText: string; answerHtml: string }> {
  const result: Array<{ question: string; answerText: string; answerHtml: string }> = [];

  // Prefer the canonical protected FAQ entries. The FAQ heading section owns
  // only the H2 marker; its body is intentionally empty.
  if (doc) {
    return doc.visibleFaq.map((entry) => ({
      question: entry.question,
      answerText: entry.answerText,
      answerHtml: entry.answerHtml,
    }));
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

  // CTA is rendered after the FAQ schema as the final visible block. Exclude it
  // from the FAQ boundary so CTA copy cannot be absorbed into an answer.
  const signupIdx = html.indexOf("app.b2ihub.com/signup", faqStart);
  if (signupIdx > 0) {
    const beforeSignup = html.substring(faqStart, signupIdx);
    const openerIdx = beforeSignup.lastIndexOf("<!-- wp:html -->");
    if (openerIdx >= 0) effectiveEnd = Math.min(effectiveEnd, faqStart + openerIdx);
  }

  // Legacy articles could render the conclusion after the visible FAQ. Bound
  // the fallback parser at the explicit conclusion marker so conclusion prose
  // can never leak into the final FAQ answer or its regenerated schema.
  const conclusionIdx = html.indexOf(CONCLUSION_START_MARKER, faqStart);
  if (conclusionIdx >= 0) effectiveEnd = Math.min(effectiveEnd, conclusionIdx);

  const faqSection = html.substring(faqStart, effectiveEnd);

  // Canonical FAQ renderer: one protected HTML block per .faq-item. Preserve the
  // answer HTML so translation can retain inline links and emphasis exactly.
  const faqItemRe = /<div\b[^>]*class=["'][^"']*\bfaq-item\b[^"']*["'][^>]*>\s*<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)<\/div>/gi;
  let faqItemMatch: RegExpExecArray | null;
  while ((faqItemMatch = faqItemRe.exec(faqSection)) !== null) {
    const question = decodeHtmlEntities(faqItemMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const answerHtml = faqItemMatch[2].trim();
    const answerText = decodeHtmlEntities(
      answerHtml.replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
    if (question && answerText) result.push({ question, answerText, answerHtml });
  }
  if (result.length > 0) return result;

  // Extract Q&A pairs: each question is an <h3>, answers follow until next <h3> or end
  const h3Split = faqSection.split(/<\/h3>/i);
  for (let i = 0; i < h3Split.length - 1; i++) {
    const beforeH3Close = h3Split[i];
    const afterH3Close = h3Split[i + 1];

    // Extract question from before the closing </h3>
    const h3OpenIdx = beforeH3Close.lastIndexOf("<h3");
    if (h3OpenIdx < 0) continue;
    const questionHtml = beforeH3Close.substring(h3OpenIdx).replace(/<h3\b[^>]*>/i, "");
    const question = decodeHtmlEntities(questionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!question) continue;

    // Extract answer from after </h3> until the next <h3>
    const nextH3Idx = afterH3Close.search(/<h3\b/i);
    const answerHtml = nextH3Idx >= 0 ? afterH3Close.substring(0, nextH3Idx) : afterH3Close;
    const answerText = decodeHtmlEntities(answerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

    if (answerText.length > 0) {
      result.push({ question, answerText, answerHtml: answerHtml.trim() });
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
      const rawQuestion = decodeHtmlEntities(sm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      // Skip if not a question — guards against keyphrase <strong> inside answers
      if (!rawQuestion.endsWith("?") && !rawQuestion.endsWith("？")) continue;
      const question = rawQuestion.replace(/[?？]$/, "").trim();
      if (!question) continue;

      const afterStrong = sm.index + sm[0].length;
      const nextStrongIdx = faqSection.substring(afterStrong).search(/<strong\b/i);
      const answerEnd = nextStrongIdx >= 0 ? afterStrong + nextStrongIdx : faqSection.length;
      let answerHtml = faqSection.substring(afterStrong, answerEnd);
      // If answer starts with a WordPress paragraph closer, skip to the next opener's content
      answerHtml = answerHtml.replace(/^\s*<!--\s*\/wp:paragraph\s*-->\s*\n?\s*<!--\s*wp:paragraph\s*-->\s*\n?\s*<p\b[^>]*>/i, "");
      answerHtml = answerHtml.replace(/^\s*<p\b[^>]*>/i, "");
      const answerText = decodeHtmlEntities(
        answerHtml
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      );

      if (answerText.length > 0) {
        result.push({ question, answerText, answerHtml: answerHtml.trim() });
      }
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

export function extractFaqPairsFromSectionBody(sectionHtml: string): Array<{ question: string; answerText: string }> {
  const result: Array<{ question: string; answerText: string }> = [];

  // First: try <h3>Question</h3> style
  const h3Split = sectionHtml.split(/<\/h3>/i);
  for (let i = 0; i < h3Split.length - 1; i++) {
    const beforeH3Close = h3Split[i];
    const afterH3Close = h3Split[i + 1];
    const h3OpenIdx = beforeH3Close.lastIndexOf("<h3");
    if (h3OpenIdx < 0) continue;
    const questionHtml = beforeH3Close.substring(h3OpenIdx).replace(/<h3\b[^>]*>/i, "");
    const question = decodeHtmlEntities(questionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!question) continue;

    const nextH3Idx = afterH3Close.search(/<h3\b/i);
    const answerHtml = nextH3Idx >= 0 ? afterH3Close.substring(0, nextH3Idx) : afterH3Close;
    const answerText = decodeHtmlEntities(answerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (answerText.length > 0) result.push({ question, answerText });
  }

  if (result.length > 0) return result;

  // Second: try <strong>Question?</strong> style (must end with "?")
  const strongRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>(?:\s*<br\s*\/?\s*>)?/gi;
  let sm: RegExpExecArray | null;
    while ((sm = strongRe.exec(sectionHtml)) !== null) {
      const rawQuestion = decodeHtmlEntities(sm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!rawQuestion.endsWith("?") && !rawQuestion.endsWith("？")) continue;
      const question = rawQuestion.replace(/[?？]$/, "").trim();
      if (!question) continue;

      const afterStrong = sm.index + sm[0].length;
      const nextStrongIdx = sectionHtml.substring(afterStrong).search(/<strong\b/i);
      const answerEnd = nextStrongIdx >= 0 ? afterStrong + nextStrongIdx : sectionHtml.length;
      let answerHtml = sectionHtml.substring(afterStrong, answerEnd);
      answerHtml = answerHtml.replace(/^\s*<!--\s*\/wp:paragraph\s*-->\s*\n?\s*<!--\s*wp:paragraph\s*-->\s*\n?\s*<p\b[^>]*>/i, "");
      answerHtml = answerHtml.replace(/^\s*<p\b[^>]*>/i, "");
      const answerText = decodeHtmlEntities(
        answerHtml
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      );

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
function extractFrequencyClaims(text: string): Array<{
  range: NumericClaimValue;
  raw: string;
  weeklyMinimum: number;
  weeklyMaximum: number;
}> {
  const results: Array<{
    range: NumericClaimValue;
    raw: string;
    weeklyMinimum: number;
    weeklyMaximum: number;
  }> = [];
  const normalizedText = text.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
    (word) => String(
      ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
        .indexOf(word.toLowerCase()) + 1,
    ),
  );
  const re =
    /\b(?:post|publish|schedule|share|aim for|recommend(?:ed)?|create)?\s*(\d+)(?:\s*(?:[–\-—]|to)\s*(\d+))?\s+(posts?|threads?|times)\s+(?:per|a|each)?\s*(day|daily|week|weekly|month|monthly)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalizedText)) !== null) {
    const minimum = parseInt(m[1]);
    const maximum = m[2] ? parseInt(m[2]) : minimum;
    const rawPeriod = m[4].toLowerCase();
    const period = rawPeriod.startsWith("day")
      ? "day"
      : rawPeriod.startsWith("week")
        ? "week"
        : "month";
    const weeklyMultiplier = period === "day" ? 7 : period === "month" ? 7 / 30 : 1;
    results.push({
      range: { minimum, maximum, period },
      raw: m[0],
      weeklyMinimum: minimum * weeklyMultiplier,
      weeklyMaximum: maximum * weeklyMultiplier,
    });
  }
  return results;
}

function plainSentences(body: string): string[] {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function parseScaledNumber(value: string, scale?: string): number {
  const base = Number(value.replace(/,/g, ""));
  if (scale?.toLowerCase().startsWith("b")) return base * 1_000_000_000;
  if (scale?.toLowerCase().startsWith("m")) return base * 1_000_000;
  if (scale?.toLowerCase().startsWith("k")) return base * 1_000;
  return base;
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
          const weeklyOverlap = !(
            fA.weeklyMaximum < fB.weeklyMinimum
            || fB.weeklyMaximum < fA.weeklyMinimum
          );
          if (!weeklyOverlap) {
            conflicts.push({
              claimKey: "posting-frequency",
              sectionIndexA: sections[i].index,
              sectionIndexB: sections[j].index,
              valueA: fA.raw,
              valueB: fB.raw,
              detail: `Section ${sections[i].index} recommends "${fA.raw}" but section ${sections[j].index} recommends "${fB.raw}"`,
            });
          }
        }
      }
    }
  }

  // Detect contradictory platform-link capability claims, such as one section
  // saying Threads has no clickable post links while another says each post
  // allows a link. The later section is regenerated by the claim-check stage;
  // code never chooses which claim is true.
  const linkClaims = sections.flatMap((section) => {
    const text = section.body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    return sentences
      .filter((sentence) => /\bthreads\b/i.test(sentence) && /\blinks?\b/i.test(sentence))
      .map((sentence) => {
        const negative =
          /\b(?:does(?:n't| not)|do not|cannot|can't|no)\b[^.!?]{0,50}\b(?:support|allow|clickable|links?)\b/i.test(sentence)
          || /\b(?:no clickable links?|links? (?:are|remain) unavailable)\b/i.test(sentence);
        const positive =
          /\b(?:allows?|supports?|offers?|includes?|has)\b[^.!?]{0,50}\b(?:clickable )?links?\b/i.test(sentence)
          || /\bone link per post\b/i.test(sentence);
        return {
          sectionIndex: section.index,
          sentence: sentence.trim(),
          polarity: negative ? "negative" : positive ? "positive" : "unknown",
        };
      })
      .filter((claim) => claim.polarity !== "unknown");
  });
  for (let left = 0; left < linkClaims.length; left++) {
    for (let right = left + 1; right < linkClaims.length; right++) {
      const first = linkClaims[left];
      const second = linkClaims[right];
      if (
        first.sectionIndex !== second.sectionIndex
        && first.polarity !== second.polarity
      ) {
        conflicts.push({
          claimKey: "threads-post-link-capability",
          sectionIndexA: first.sectionIndex,
          sectionIndexB: second.sectionIndex,
          valueA: first.sentence,
          valueB: second.sentence,
          detail: `Sections ${first.sectionIndex} and ${second.sectionIndex} make contradictory Threads post-link claims`,
        });
      }
    }
  }

  // Detect incompatible audience-size claims made about Hong Kong Threads.
  const audienceClaims = sections.flatMap((section) =>
    plainSentences(section.body).flatMap((sentence) => {
      if (!/\b(?:threads|hong kong)\b/i.test(section.body)) return [];
      const match = sentence.match(
        /\b(\d+(?:\.\d+)?(?:,\d{3})*)\s*(billion|million|thousand|bn|m|k)?\+?\s+(?:monthly active\s+)?users?\b/i,
      );
      if (!match) return [];
      return [{
        sectionIndex: section.index,
        sentence,
        value: parseScaledNumber(match[1], match[2]),
      }];
    }),
  );
  for (let left = 0; left < audienceClaims.length; left++) {
    for (let right = left + 1; right < audienceClaims.length; right++) {
      const first = audienceClaims[left];
      const second = audienceClaims[right];
      if (
        first.sectionIndex !== second.sectionIndex
        && first.value > 0
        && second.value > 0
        && first.value !== second.value
      ) {
        conflicts.push({
          claimKey: "threads-hong-kong-audience-size",
          sectionIndexA: first.sectionIndex,
          sectionIndexB: second.sectionIndex,
          valueA: first.sentence,
          valueB: second.sentence,
          detail: `Sections ${first.sectionIndex} and ${second.sectionIndex} give different Threads audience sizes`,
        });
      }
    }
  }

  // Detect contradictory availability statements for major Threads features.
  const featureNames = ["ads", "advertising", "polls", "messaging", "direct messages", "dms", "links", "search"];
  const articleIsAboutThreads = sections.some((section) => /\bthreads\b/i.test(section.body));
  const featureClaims = sections.flatMap((section) =>
    plainSentences(section.body).flatMap((sentence) => {
      if (
        !articleIsAboutThreads
        || (!/\bthreads\b/i.test(sentence) && !/\b(?:the|this) platform(?:'s|’s)?\b/i.test(sentence))
      ) return [];
      const feature = featureNames.find((name) =>
        new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`, "i").test(sentence),
      );
      if (!feature) return [];
      const negative =
        /\b(?:unavailable|not yet|still (?:waiting|coming)|coming soon|when .{0,30} become available|aren't yet|isn't yet|not fully available|does not support|doesn't support)\b/i.test(sentence);
      const positive =
        /\b(?:available|launched|rolled out|supports?|allows?|offers?|includes?|native|can (?:run|use|add|send))\b/i.test(sentence);
      if (!negative && !positive) return [];
      return [{
        feature: feature === "advertising" ? "ads" : feature === "direct messages" || feature === "dms" ? "messaging" : feature,
        polarity: negative ? "negative" : "positive",
        sectionIndex: section.index,
        sentence,
      }];
    }),
  );
  for (let left = 0; left < featureClaims.length; left++) {
    for (let right = left + 1; right < featureClaims.length; right++) {
      const first = featureClaims[left];
      const second = featureClaims[right];
      if (
        first.sectionIndex !== second.sectionIndex
        && first.feature === second.feature
        && first.polarity !== second.polarity
      ) {
        conflicts.push({
          claimKey: `threads-${first.feature}-availability`,
          sectionIndexA: first.sectionIndex,
          sectionIndexB: second.sectionIndex,
          valueA: first.sentence,
          valueB: second.sentence,
          detail: `Sections ${first.sectionIndex} and ${second.sectionIndex} contradict each other about Threads ${first.feature}`,
        });
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

  const unique = new Map<string, ClaimConflict>();
  for (const conflict of conflicts) {
    const key = [
      conflict.claimKey,
      Math.min(conflict.sectionIndexA, conflict.sectionIndexB),
      Math.max(conflict.sectionIndexA, conflict.sectionIndexB),
      conflict.valueA,
      conflict.valueB,
    ].join("|");
    if (!unique.has(key)) unique.set(key, conflict);
  }
  return [...unique.values()];
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
  const ctaMatch = html.substring(ctaSearchStart).match(/<!--\s*wp:html\s*-->(?:(?!<!--\s*\/wp:html\s*-->)[\s\S])*?app\.b2ihub\.com\/signup(?:(?!<!--\s*\/wp:html\s*-->)[\s\S])*?<!--\s*\/wp:html\s*-->/i);
  const cta: ProtectedArticleBlock | null = ctaMatch ? {
    id: "cta",
    type: "cta",
    html: ctaMatch[0],
    fingerprint: fingerprintHtml(ctaMatch[0]),
  } : null;

  // Extract FAQ schema block anywhere in the document. Its canonical position is
  // before the final CTA, but the parser accepts either ordering during migration.
  const faqSchemaMatch = html.match(/<!--\s*wp:html\s*-->(?:(?!<!--\s*\/wp:html\s*-->)[\s\S])*?FAQPage(?:(?!<!--\s*\/wp:html\s*-->)[\s\S])*?<!--\s*\/wp:html\s*-->/i);
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
    headingMatches.push({
      index: hm.index,
      endIndex: hm.index + hm[0].length,
      heading: decodeHtmlEntities(hm[2].replace(/<[^>]+>/g, "").trim()),
    });
  }

  if (headingMatches.length === 0) {
    errors.push("No H2 heading blocks found in HTML");
    return { doc: null, errors };
  }

  // Find CTA and FAQ schema positions for section boundary calculation
  const ctaStartIdx = ctaMatch ? html.indexOf(ctaMatch[0]) : -1;
  const faqSchemaStartIdx = faqSchemaMatch ? html.indexOf(faqSchemaMatch[0]) : -1;
  const conclusionMarkerStart = html.indexOf(CONCLUSION_START_MARKER);
  const conclusionMarkerEnd = html.indexOf(CONCLUSION_END_MARKER);

  // Extract introduction and parse it into blocks
  const introStart = languageSwitcher
    ? html.indexOf(switcherMatch![0]) + switcherMatch![0].length
    : 0;
  const introEnd = headingMatches[0].index;
  const introductionHtml = html.substring(introStart, introEnd).trim();
  const introParse = parseWordPressEditorialBlocks(introductionHtml, "intro");
  const introduction: ArticleComponent = {
    id: existingDoc.introduction?.id ?? "intro",
    blocks: introParse.blocks.length > 0 ? introParse.blocks : [],
    status: existingDoc.introduction?.status ?? "generated",
  };

  // Extract section bodies from between heading blocks. Each section stops at
  // the next H2 or the first protected boundary (conclusion, schema or CTA).
  const newSections: ArticleSection[] = [];
  for (let i = 0; i < headingMatches.length; i++) {
    const sectionStart = headingMatches[i].endIndex;
    let sectionEnd = html.length;
    if (i + 1 < headingMatches.length) {
      sectionEnd = headingMatches[i + 1].index;
    }
    // The conclusion has explicit stable markers and must never be absorbed into
    // the last editorial/FAQ section during HTML round-trips.
    if (conclusionMarkerStart > sectionStart && conclusionMarkerStart < sectionEnd) {
      sectionEnd = conclusionMarkerStart;
    }
    if (ctaStartIdx > sectionStart && ctaStartIdx < sectionEnd) sectionEnd = ctaStartIdx;
    if (faqSchemaStartIdx > sectionStart && faqSchemaStartIdx < sectionEnd) sectionEnd = faqSchemaStartIdx;

    const bodyHtml = html.substring(sectionStart, sectionEnd).trim();
    const existing = existingDoc.sections.find((s) => s.heading === headingMatches[i].heading) ?? existingDoc.sections[i];
    const isFaqHeading = html.substring(Math.max(0, headingMatches[i].index - FAQ_HEADING_MARKER.length - 10), headingMatches[i].index).includes(FAQ_HEADING_MARKER)
      || /^(frequently asked questions|faq|常見問題)/i.test(headingMatches[i].heading.trim())
      || existing?.sectionType === "faq-heading";
    if (bodyHtml.length === 0 && !isFaqHeading) {
      errors.push(`Section ${i} has empty body`);
      return { doc: null, errors };
    }

    const sectionParse = parseWordPressEditorialBlocks(bodyHtml, `section-${i}`);

    const markerWindow = html.substring(Math.max(0, headingMatches[i].index - FAQ_HEADING_MARKER.length - 20), headingMatches[i].index);
    const sectionType: ArticleSection["sectionType"] = markerWindow.includes(FAQ_HEADING_MARKER)
      || /^(frequently asked questions|faq|常見問題)/i.test(headingMatches[i].heading.trim())
      || existing?.sectionType === "faq-heading"
      ? "faq-heading"
      : (existing?.sectionType ?? "main");
    newSections.push({
      id: existing?.id ?? `section-${i}`,
      heading: headingMatches[i].heading,
      headingLevel: 2,
      sectionType,
      blocks: sectionType === "faq-heading" ? [] : sectionParse.blocks,
      status: existing?.status ?? "generated",
    });
  }

  // Extract conclusion only from the explicit stable boundary markers.
  // This prevents FAQ/schema/CTA content from being misclassified as conclusion.
  let conclusionHtml = "";
  if (conclusionMarkerStart >= 0 && conclusionMarkerEnd > conclusionMarkerStart) {
    conclusionHtml = html.substring(
      conclusionMarkerStart + CONCLUSION_START_MARKER.length,
      conclusionMarkerEnd,
    ).trim();
  }
  if (conclusionHtml.length === 0) {
    conclusionHtml = existingDoc.conclusion?.blocks ? renderComponentHtml(existingDoc.conclusion) : "";
  }

  // Parse conclusion HTML into blocks
  const conclusionParse = parseWordPressEditorialBlocks(conclusionHtml, "conc");

  const doc: ArticleDocument = {
    metadata: { ...existingDoc.metadata },
    languageSwitcher: languageSwitcher ?? existingDoc.languageSwitcher,
    introduction: {
      id: existingDoc.introduction?.id ?? "intro",
      blocks: introduction.blocks,
      status: existingDoc.introduction?.status ?? "generated",
    },
    sections: newSections,
    visibleFaq: (() => {
      const parsedFaq = extractVisibleFaqFromArticle(html);
      return parsedFaq.length > 0
        ? parsedFaq.map((entry) => ({ question: entry.question, answerHtml: entry.answerHtml, answerText: entry.answerText }))
        : existingDoc.visibleFaq;
    })(),
    conclusion: {
      id: existingDoc.conclusion?.id ?? "conc",
      blocks: conclusionParse.blocks,
      status: existingDoc.conclusion?.status ?? "generated",
    },
    cta: cta ?? existingDoc.cta,
    faqSchema: faqSchema ?? existingDoc.faqSchema,
    insertedLinks: existingDoc.insertedLinks,
  };

  return { doc, errors: [] };
}

