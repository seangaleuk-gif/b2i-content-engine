// ── English Language Consistency ──
// Deterministic gate that keeps an English generation English-only.
// The outline, introduction, every section, conclusion, FAQ, title, meta
// description and slug must be in the selected target language (English).
// A materially mixed-language English article (e.g. a Traditional Chinese
// introduction, or a `-zh` slug) is a hard final-validation failure and can
// never save or publish.

import type { ArticleDocument } from "@/lib/blog/article-document";
import { extractPlainTextFromEditorialBlocks } from "@/lib/blog/article-document";

export type LanguageConsistencyComponentKind =
  | "introduction"
  | "section"
  | "conclusion"
  | "faq"
  | "title"
  | "meta-description"
  | "slug";

export interface LanguageConsistencyViolation {
  componentKind: LanguageConsistencyComponentKind;
  componentId: string;
  reason: "cjk-prose" | "zh-slug" | "cjk-slug";
  cjkCharCount: number;
  visibleCharCount: number;
  snippet: string;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** A component must contain a substantial CJK run before it is flagged: a
 *  short brand-name mention (e.g. a Chinese company name in an English
 *  sentence) is not a language-consistency violation, but a Chinese-heavy
 *  component is. Short metadata components (title/meta) use a lower floor. */
export const MIN_CJK_CHARS = 20;
export const MIN_CJK_RATIO = 0.3;
export const MIN_CJK_CHARS_METADATA = 6;
export const MIN_CJK_RATIO_METADATA = 0.4;

const METADATA_KINDS = new Set<LanguageConsistencyComponentKind>([
  "title",
  "meta-description",
]);

export function isMateriallyChinese(
  text: string,
  options?: { metadata?: boolean },
): boolean {
  const cjkChars = text.match(CJK_RE)?.length ?? 0;
  const minChars = options?.metadata ? MIN_CJK_CHARS_METADATA : MIN_CJK_CHARS;
  const minRatio = options?.metadata ? MIN_CJK_RATIO_METADATA : MIN_CJK_RATIO;
  if (cjkChars < minChars) return false;
  const visibleChars = text.replace(/\s+/g, "").length;
  if (visibleChars === 0) return false;
  return cjkChars / visibleChars >= minRatio;
}

export function scanEnglishLanguageConsistency(
  doc: ArticleDocument,
): LanguageConsistencyViolation[] {
  const violations: LanguageConsistencyViolation[] = [];

  const components: Array<{
    componentKind: LanguageConsistencyComponentKind;
    componentId: string;
    text: string;
  }> = [
    {
      componentKind: "introduction",
      componentId: doc.introduction.id,
      text: extractPlainTextFromEditorialBlocks(doc.introduction.blocks),
    },
    ...doc.sections
      .filter(
        (section) =>
          section.sectionType !== "faq-heading"
          && section.sectionType !== "conclusion-heading",
      )
      .map((section) => ({
        componentKind: "section" as const,
        componentId: section.id,
        text: `${section.heading} ${extractPlainTextFromEditorialBlocks(section.blocks)}`,
      })),
    {
      componentKind: "conclusion",
      componentId: doc.conclusion.id,
      text: extractPlainTextFromEditorialBlocks(doc.conclusion.blocks),
    },
    ...doc.visibleFaq.map((entry, index) => ({
      componentKind: "faq" as const,
      componentId: `faq-${index}`,
      text: `${entry.question} ${entry.answerText}`,
    })),
    {
      componentKind: "title",
      componentId: "title",
      text: doc.metadata.title,
    },
    {
      componentKind: "meta-description",
      componentId: "meta-description",
      text: doc.metadata.metaDescription,
    },
  ];

  for (const component of components) {
    const cjkCharCount = component.text.match(CJK_RE)?.length ?? 0;
    if (!isMateriallyChinese(component.text, { metadata: METADATA_KINDS.has(component.componentKind) })) {
      continue;
    }
    violations.push({
      componentKind: component.componentKind,
      componentId: component.componentId,
      reason: "cjk-prose",
      cjkCharCount,
      visibleCharCount: component.text.replace(/\s+/g, "").length,
      snippet: component.text.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }

  // The English slug must never carry the Chinese-language suffix or CJK.
  if (/-zh$/i.test(doc.metadata.slug)) {
    violations.push({
      componentKind: "slug",
      componentId: doc.metadata.slug,
      reason: "zh-slug",
      cjkCharCount: 0,
      visibleCharCount: doc.metadata.slug.length,
      snippet: doc.metadata.slug,
    });
  } else if (CJK_RE.test(doc.metadata.slug)) {
    violations.push({
      componentKind: "slug",
      componentId: doc.metadata.slug,
      reason: "cjk-slug",
      cjkCharCount: doc.metadata.slug.match(CJK_RE)?.length ?? 0,
      visibleCharCount: doc.metadata.slug.length,
      snippet: doc.metadata.slug,
    });
  }

  return violations;
}

export function formatLanguageConsistencyViolations(
  violations: LanguageConsistencyViolation[],
): string[] {
  return violations.map((violation) => [
    `component=${violation.componentKind}:${violation.componentId}`,
    `reason=${violation.reason}`,
    `cjkChars=${violation.cjkCharCount}`,
    `visibleChars=${violation.visibleCharCount}`,
    `snippet="${violation.snippet}"`,
  ].join(" "));
}
