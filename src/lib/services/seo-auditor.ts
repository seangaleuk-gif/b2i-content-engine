import { countChineseCharacters, countLongParagraphs } from "./text-utils";
import { FLESCH_MIN, FLESCH_MAX } from "./generation-constants";
import {
  countCanonicalVisibleWords,
  extractVisibleFaqFromArticle,
  parseArticleDocumentFromHtml,
  type ArticleDocument,
} from "../blog/article-document";
import { analyzeFinalArticle, buildPolicy, type FinalArticleMetrics, type FinalArticlePolicy } from "@/lib/blog/final-article-policy";
import {
  englishTitleRange,
  englishMetaRange,
  englishWordTolerance,
  englishKeyphraseDensity,
  chineseTitleRange,
  chineseMetaRange,
  chineseKeyphraseDensity,
  chineseCharRange,
  computeKeyphraseTargets,
  dynamicH2Range,
  dynamicFaqRange,
  paragraphSentenceLimit,
  internalLinkRange,
  translationFaqCount,
} from "@/lib/content-standards";
import { closeVariant } from "@/lib/seo/seo-text-utils";
import { findFormalRegisterIssues } from "./translation-glossary";

export type AuditStatus = "pass" | "warning" | "fail" | "not_applicable";

export interface AuditCheck {
  id: string;
  label: string;
  score: number | null;
  status: AuditStatus;
  measuredValue: string;
  targetValue: string;
  explanation: string;
  category: string;
}

export interface AuditResult {
  overallScore: number;
  checks: AuditCheck[];
  summary: { passed: number; warnings: number; failed: number; notApplicable: number };
}

export interface AuditInput {
  title: string;
  metaDescription: string;
  keyword: string;
  blog: string;
  faq?: Array<{ question: string; answer: string }>;
  targetWordCount: number;
  targetKeyphraseCount: number;
}

// ── Category weights ──
const CATEGORY_WEIGHTS: Record<string, number> = {
  "SEO Fundamentals": 35,
  "Content & Keyphrase": 25,
  "Readability": 15,
  "Links": 10,
  "Structure & Schema": 10,
  "Images": 5,
};

const ENGLISH_CATEGORY_WEIGHTS: Record<string, number> = {
  "SEO Fundamentals": 25,
  "Content & Keyphrase": 15,
  "Readability": 10,
  "Links": 5,
  "Structure & Schema": 10,
  "Images": 5,
  "Factual Reliability": 15,
  "Editorial Quality": 15,
};

// ── Density-aware keyphrase scoring ──

// Local helpers for runChineseAudit() — not shared with English audit
function countExactPhrase(text: string, phrase: string): number {
  if (!phrase) return 0;
  const lower = text.toLowerCase();
  const target = phrase.toLowerCase().trim();
  let count = 0, pos = 0;
  while ((pos = lower.indexOf(target, pos)) !== -1) { count++; pos += target.length; }
  return count;
}
function extractReadableText(html: string): string {
  return html.replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}
function extractH2Texts(html: string): string[] {
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const texts: string[] = []; let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(html)) !== null) texts.push(m[1].replace(/<[^>]+>/g, "").trim());
  return texts;
}



// ── Main audit — uses analyzeFinalArticle() for canonical metric computation ──

export function runAudit(input: AuditInput): AuditResult {
  const { title, metaDescription, keyword, blog, faq, targetWordCount } = input;
  const checks: AuditCheck[] = [];
  const keywordLower = keyword?.toLowerCase().trim() ?? "";
  const h2Texts = (blog.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) ?? []).map((h) => h.replace(/<[^>]+>/g, "").trim());

  // Reconstruct the canonical document from the saved production HTML, then
  // pass its one article-level word count into the shared analyzer.
  const seedDoc: ArticleDocument = {
    metadata: {
      title,
      slug: "",
      metaDescription,
      excerpt: "",
      targetWordCount,
      focusKeyphrase: keyword,
    },
    languageSwitcher: null,
    introduction: { id: "audit-introduction", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: (faq ?? []).map((entry) => ({
      question: entry.question,
      answerHtml: "",
      answerText: entry.answer,
    })),
    conclusion: { id: "audit-conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
  const parsed = parseArticleDocumentFromHtml(blog, seedDoc);
  const canonicalWordCount = parsed.doc
    ? countCanonicalVisibleWords(parsed.doc)
    : undefined;
  const m = analyzeFinalArticle(
    blog,
    keyword,
    title,
    metaDescription,
    targetWordCount,
    canonicalWordCount,
  );
  const policy = buildPolicy(targetWordCount, undefined, undefined, keyword);

  const { min: titleMin, max: titleMax } = englishTitleRange();
  const { min: metaMin, max: metaMax } = englishMetaRange();
  const { warningBelow: kpLow, stuffingAbove: kpHigh } = englishKeyphraseDensity();

  const makeCheck = (id: string, label: string, score: number | null, status: AuditStatus, measuredValue: string, targetValue: string, explanation: string, category: string): AuditCheck =>
    ({ id, label, score, status, measuredValue, targetValue, explanation, category });

  // ── SEO Fundamentals (35%) ──

  // 1. SEO Title Length
  if (m.titleLength >= titleMin && m.titleLength <= titleMax) {
    checks.push(makeCheck("title_length", "SEO Title Length", 100, "pass", `${m.titleLength} chars`, `${titleMin}-${titleMax}`, "Title length is within the recommended range.", "SEO Fundamentals"));
  } else if (m.titleLength > 0 && m.titleLength < titleMin) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${m.titleLength} chars`, `${titleMin}-${titleMax}`, "Title is too short. Add more descriptive words.", "SEO Fundamentals"));
  } else if (m.titleLength > titleMax) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${m.titleLength} chars`, `${titleMin}-${titleMax}`, "Title is too long. Google truncates titles over ~60 chars.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("title_length", "SEO Title Length", 0, "fail", "0 chars", `${titleMin}-${titleMax}`, "No SEO title found.", "SEO Fundamentals"));
  }

  // 2. Meta Description Length
  if (m.metaDescriptionLength >= metaMin && m.metaDescriptionLength <= metaMax) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 100, "pass", `${m.metaDescriptionLength} chars`, `${metaMin}-${metaMax}`, "Meta description is within the recommended range.", "SEO Fundamentals"));
  } else if (m.metaDescriptionLength > 0 && m.metaDescriptionLength < metaMin) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 40, "warning", `${m.metaDescriptionLength} chars`, `${metaMin}-${metaMax}`, "Meta description is too short. Expand to include the keyphrase and a CTA.", "SEO Fundamentals"));
  } else if (m.metaDescriptionLength > metaMax) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 50, "warning", `${m.metaDescriptionLength} chars`, `${metaMin}-${metaMax}`, "Meta description is too long.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("meta_length", "Meta Description Length", 0, "fail", "0 chars", `${metaMin}-${metaMax}`, "No meta description found.", "SEO Fundamentals"));
  }

  // 3. Focus Keyphrase in SEO Title
  if (keywordLower) {
    const inTitle = title.toLowerCase().includes(keywordLower);
    checks.push(makeCheck("keyphrase_title", "Focus Keyphrase in SEO Title", inTitle ? 100 : 60, inTitle ? "pass" : "warning",
      `"${keyword}" ${inTitle ? "found" : "not found"}`, "Exact phrase in title",
      inTitle ? "The focus keyphrase appears in the SEO title." : "The focus keyphrase is missing from the SEO title (soft warning).", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("keyphrase_title", "Focus Keyphrase in SEO Title", null, "not_applicable", "No keyphrase", "Exact phrase in title", "No focus keyphrase set.", "SEO Fundamentals"));
  }

  // 4. Word Count
  if (targetWordCount > 0) {
    const { min: wcMin, max: wcMax } = englishWordTolerance(targetWordCount);
    const targetLabel = `${wcMin.toLocaleString()}–${wcMax.toLocaleString()}`;
    if (m.readableWordCount >= wcMin && m.readableWordCount <= wcMax) {
      checks.push(makeCheck("word_count", "Body Word Count", 100, "pass", `${m.readableWordCount.toLocaleString()} words`, targetLabel, "Word count is within the accepted tolerance range.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("word_count", "Body Word Count", 0, "fail", `${m.readableWordCount.toLocaleString()} words`, targetLabel, "Word count is outside the tolerance range (hard failure).", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("word_count", "Body Word Count", null, "not_applicable", "No target", "N/A", "No target word count configured.", "SEO Fundamentals"));
  }

  // 5. H2 Count Range
  const { min: h2Min, max: h2Max } = dynamicH2Range(targetWordCount || m.readableWordCount);
  if (m.h2Count >= h2Min && m.h2Count <= h2Max) {
    checks.push(makeCheck("h2_count", "H2 Heading Count", 100, "pass", `${m.h2Count} H2s`, `${h2Min}–${h2Max}`, "H2 count is within the recommended range.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("h2_count", "H2 Heading Count", 0, "fail", `${m.h2Count} H2s`, `${h2Min}–${h2Max}`, "H2 count is outside the dynamic range (hard failure).", "SEO Fundamentals"));
  }

  // 6. FAQ Entry Count Range
  const { min: faqEntryMin, max: faqEntryMax } = dynamicFaqRange(targetWordCount || m.readableWordCount);
  if (faqEntryMin > 0 && m.faqEntryCount >= faqEntryMin && m.faqEntryCount <= faqEntryMax) {
    checks.push(makeCheck("faq_count", "FAQ Entry Count", 100, "pass", `${m.faqEntryCount} entries`, `${faqEntryMin}–${faqEntryMax}`, "FAQ entry count is within the recommended range.", "SEO Fundamentals"));
  } else if (faqEntryMin === 0 && m.faqEntryCount === 0) {
    checks.push(makeCheck("faq_count", "FAQ Entry Count", null, "not_applicable", "No FAQ", "N/A", "No FAQ section — not applicable.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("faq_count", "FAQ Entry Count", 0, "fail", `${m.faqEntryCount} entries`, `${faqEntryMin}–${faqEntryMax}`, "FAQ entry count is outside the dynamic range (hard failure).", "SEO Fundamentals"));
  }

  // ── Content & Keyphrase (25%) ──

  // 7. Keyphrase in First 100 Words
  if (keywordLower) {
    checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", m.keyphraseInFirst100Words ? 100 : 60, m.keyphraseInFirst100Words ? "pass" : "warning",
      m.keyphraseInFirst100Words ? "Found" : "Not found", "First 100 words",
      m.keyphraseInFirst100Words ? "The keyphrase appears early in the content." : "The keyphrase should appear within the first paragraph (quality target, not a hard requirement).", "Content & Keyphrase"));
  } else {
    checks.push(makeCheck("keyphrase_first100", "Keyphrase in First 100 Words", null, "not_applicable", "No keyphrase", "First 100 words", "", "Content & Keyphrase"));
  }

  // 8. Keyphrase in H2
  if (keywordLower) {
    const exactInH2 = h2Texts.some((h) => h.toLowerCase().includes(keywordLower));
    const closeInH2 = !exactInH2 && h2Texts.some((h) => closeVariant(keyword, h));
    const matchedHeading = h2Texts.find((h) => h.toLowerCase().includes(keywordLower)) ?? h2Texts.find((h) => closeVariant(keyword, h));
    if (exactInH2) {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 100, "pass", `"${matchedHeading}"`, "Exact phrase in H2", "The exact keyphrase appears in an H2 heading.", "Content & Keyphrase"));
    } else if (closeInH2) {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 60, "warning", `Close match: "${matchedHeading}"`, "Exact phrase in H2", "A close variant of the keyphrase was found in an H2, but not the exact phrase.", "Content & Keyphrase"));
    } else if (h2Texts.length > 0) {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 60, "warning", "Not found", "Exact phrase in H2", "The keyphrase is missing from all H2 headings (quality target).", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", 60, "warning", "No H2 headings", "Exact phrase in H2", "No H2 headings found.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_h2", "Exact Keyphrase in H2", null, "not_applicable", "No keyphrase", "Exact phrase in H2", "", "Content & Keyphrase"));
  }

  // 9. Keyphrase Count (density-based from content-standards)
  if (keywordLower && m.readableWordCount > 0) {
    const kpTargets = computeKeyphraseTargets(m.readableWordCount, keyword);
    const densityPct = (m.exactKeyphraseCount / m.readableWordCount) * 100;
    const densityHealthy = densityPct >= kpLow && densityPct <= 1.5;
    const below = Math.max(0, kpTargets.min - m.exactKeyphraseCount);
    const above = Math.max(0, m.exactKeyphraseCount - kpTargets.max);
    const overshoot = Math.max(below, above);
    let kpScore: number; let kpStatus: AuditStatus; let kpMsg: string;
    if (overshoot === 0) {
      kpScore = 100; kpStatus = "pass"; kpMsg = "Keyphrase usage is appropriate for the article length.";
    } else if (overshoot <= 2) {
      kpScore = 80; kpStatus = "warning"; kpMsg = `Keyphrase count is slightly ${below > 0 ? "below" : "above"} the recommended range (soft warning).`;
    } else if (densityHealthy || overshoot <= 5) {
      kpScore = 60; kpStatus = "warning"; kpMsg = densityHealthy ? "Keyphrase count is outside range but density is healthy (soft warning)." : "Keyphrase count is moderately outside range (soft warning).";
    } else {
      kpScore = 0; kpStatus = "fail"; kpMsg = below > 0 ? "Keyphrase is significantly underused. Add the keyphrase naturally." : "Keyphrase is significantly overused. Reduce repetitions.";
    }
    checks.push(makeCheck("keyphrase_count", "Exact Keyphrase Count", kpScore, kpStatus,
      `${m.exactKeyphraseCount} occurrences`, `${kpTargets.min}–${kpTargets.max}`, kpMsg, "Content & Keyphrase"));
  } else {
    checks.push(makeCheck("keyphrase_count", "Exact Keyphrase Count", null, "not_applicable", "No keyphrase", "Range based on word count", "", "Content & Keyphrase"));
  }

  // 10. Keyphrase Density (percentage) — <0.5% warning, >3% hard failure
  if (keywordLower && m.readableWordCount > 0) {
    const densityStr = `${m.keyphraseDensity.toFixed(2)}%`;
    const targetStr = `${kpLow}%–${kpHigh}% (stuffing at ${kpHigh}%)`;
    if (m.keyphraseDensity >= kpLow && m.keyphraseDensity <= kpHigh) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 100, "pass", densityStr, targetStr, "Density is within the healthy range.", "Content & Keyphrase"));
    } else if (m.keyphraseDensity > 0 && m.keyphraseDensity < kpLow) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is below the minimum (soft warning).", "Content & Keyphrase"));
    } else if (m.keyphraseDensity > kpHigh) {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Density exceeds the stuffing threshold (hard failure).", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Keyphrase density is zero.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_density", "Keyphrase Density", null, "not_applicable", "N/A", `${kpLow}%–${kpHigh}%`, "", "Content & Keyphrase"));
  }

  // ── Readability (15%) ──

  // 10. Paragraph Length
  const maxSent = paragraphSentenceLimit();
  if (m.longParagraphCount === 0) {
    checks.push(makeCheck("paragraph_length", "Paragraph Length", 100, "pass", `${m.longParagraphCount} long`, `Max ${maxSent} sentences`, "All paragraphs stay within the sentence limit.", "Readability"));
  } else if (m.longParagraphCount <= 2) {
    checks.push(makeCheck("paragraph_length", "Paragraph Length", 80, "warning", `${m.longParagraphCount} long`, `Max ${maxSent} sentences`, `${m.longParagraphCount} paragraph(s) exceed ${maxSent} sentences. Consider splitting.`, "Readability"));
  } else {
    checks.push(makeCheck("paragraph_length", "Paragraph Length", 60, "warning", `${m.longParagraphCount} long`, `Max ${maxSent} sentences`, `${m.longParagraphCount} paragraphs exceed ${maxSent} sentences. Split longer paragraphs.`, "Readability"));
  }

  // 11. Reading Level
  const fsRounded = Math.round(m.fleschReadingEase);
  if (fsRounded >= FLESCH_MIN && fsRounded <= FLESCH_MAX) {
    checks.push(makeCheck("reading_level", "Reading Level", 100, "pass", `Flesch ${fsRounded}`, `${FLESCH_MIN}-${FLESCH_MAX}`, "Reading ease is within the target range.", "Readability"));
  } else if ((fsRounded >= FLESCH_MIN - 10 && fsRounded < FLESCH_MIN) || (fsRounded > FLESCH_MAX && fsRounded <= FLESCH_MAX + 10)) {
    checks.push(makeCheck("reading_level", "Reading Level", 50, "warning", `Flesch ${fsRounded}`, `${FLESCH_MIN}-${FLESCH_MAX}`, "Reading ease is slightly outside the target range.", "Readability"));
  } else {
    checks.push(makeCheck("reading_level", "Reading Level", 0, "fail", `Flesch ${fsRounded}`, `${FLESCH_MIN}-${FLESCH_MAX}`, fsRounded < FLESCH_MIN ? "Text is too complex." : "Text is too simple.", "Readability"));
  }

  // ── Links (10%) ──

  // 12. Internal Links
  const { min: linkMin, max: linkMax } = internalLinkRange();
  if (m.uniqueInternalLinkCount >= linkMin && m.uniqueInternalLinkCount <= linkMax) {
    checks.push(makeCheck("internal_links", "Internal Links", 100, "pass", `${m.uniqueInternalLinkCount} unique`, `${linkMin}–${linkMax}`, "Internal link count is within the accepted range.", "Links"));
  } else {
    checks.push(makeCheck("internal_links", "Internal Links", 0, "fail", `${m.uniqueInternalLinkCount} unique`, `${linkMin}–${linkMax}`, "Internal link count exceeds the maximum (hard failure).", "Links"));
  }

  // 13. External Links
  if (m.externalSourceLinkCount > 0) {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", `${m.externalSourceLinkCount} unique`, "0+ accepted", "External links are present.", "Links"));
  } else {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", "0 unique", "0+ accepted", "No external links — 0 is acceptable per policy.", "Links"));
  }

  // ── Structure & Schema (10%) ──

  // 14. FAQ Schema
  if (m.faqBlockCount > 0 && m.faqJsonLdCount > 0 && m.faqParityValid) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 100, "pass", "Valid FAQPage JSON-LD", "FAQPage schema", "Valid FAQPage structured data found.", "Structure & Schema"));
  } else if (m.faqBlockCount > 0 || m.faqJsonLdCount > 0) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", m.faqBlockCount > 0 ? "FAQ found, schema issues" : "JSON-LD found, no FAQPage", "FAQPage schema", "FAQ or schema has issues (hard failure).", "Structure & Schema"));
  } else {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", "Not found", "FAQPage schema", "No FAQPage schema found (hard failure).", "Structure & Schema"));
  }

  // 15. CTA / Signup / Switcher presence
  const ctaOk = m.ctaHeadingCount >= policy.requiredCtaHeadingCount && m.signupUrlCount >= policy.requiredSignupUrlCount;
  checks.push(makeCheck("cta_presence", "CTA & Signup",
    ctaOk ? 100 : 0,
    ctaOk ? "pass" : "fail",
    `CTA: ${m.ctaHeadingCount}, signup: ${m.signupUrlCount}`,
    `CTA: ${policy.requiredCtaHeadingCount}, signup: ${policy.requiredSignupUrlCount}`,
    ctaOk ? "CTA heading and signup URL are present." : "CTA or signup missing (hard failure).",
    "Structure & Schema"));

  checks.push(makeCheck("language_switcher", "Language Switcher",
    m.hasLanguageSwitcher ? 100 : 0,
    m.hasLanguageSwitcher ? "pass" : "fail",
    m.hasLanguageSwitcher ? "Present" : "Missing",
    "Must be present",
    "Language switcher is " + (m.hasLanguageSwitcher ? "present." : "missing (hard failure)."), "Structure & Schema"));

  // ── Factual reliability (15%) ──
  const claimConflicts = m.claimConflictCount ?? 0;
  const newConclusionNumbers = m.conclusionNewNumericClaimCount ?? 0;
  const factualScore = m.factualScore ?? 100;
  checks.push(makeCheck(
    "claim_consistency",
    "Article-wide Claim Consistency",
    claimConflicts === 0 ? 100 : 0,
    claimConflicts === 0 ? "pass" : "fail",
    `${claimConflicts} contradiction${claimConflicts === 1 ? "" : "s"}`,
    "0 contradictions",
    claimConflicts === 0
      ? "No incompatible audience, feature-availability or posting-frequency claims were detected."
      : "The article makes mutually incompatible factual or prescriptive claims (hard failure).",
    "Factual Reliability",
  ));
  checks.push(makeCheck(
    "conclusion_new_facts",
    "New Numeric Claims in Conclusion",
    newConclusionNumbers === 0 ? 100 : 0,
    newConclusionNumbers === 0 ? "pass" : "fail",
    `${newConclusionNumbers} new`,
    "0 new numeric claims",
    newConclusionNumbers === 0
      ? "The conclusion introduces no numeric claims absent from the main article."
      : "The conclusion introduces new numeric claims instead of summarising established content (hard failure).",
    "Factual Reliability",
  ));
  checks.push(makeCheck(
    "factual_score",
    "Factual Reliability Score",
    factualScore,
    factualScore === 100 ? "pass" : "fail",
    `${factualScore}/100`,
    "100/100",
    factualScore === 100
      ? "All deterministic factual-consistency checks passed."
      : "One or more deterministic factual-consistency checks failed.",
    "Factual Reliability",
  ));

  // ── Editorial quality (15%) ──
  const malformedProse = m.malformedProseCount ?? 0;
  const repeatedIdeas = m.repeatedIdeaPairCount ?? 0;
  const conclusionRatio = m.conclusionWordRatio ?? 0;
  const editorialScore = m.editorialScore ?? 100;
  checks.push(makeCheck(
    "malformed_prose",
    "Malformed or Corrupt Prose",
    malformedProse === 0 ? 100 : 0,
    malformedProse === 0 ? "pass" : "fail",
    `${malformedProse} issue${malformedProse === 1 ? "" : "s"}`,
    "0 issues",
    malformedProse === 0
      ? "No broken fragments, corrupt tokens or unresolved placeholders were detected."
      : "The article contains malformed or corrupt prose (hard failure).",
    "Editorial Quality",
  ));
  checks.push(makeCheck(
    "repeated_ideas",
    "Repeated Ideas",
    repeatedIdeas <= 3 ? 100 : repeatedIdeas <= 5 ? 60 : 0,
    repeatedIdeas <= 3 ? "pass" : "warning",
    `${repeatedIdeas} similar pair${repeatedIdeas === 1 ? "" : "s"}`,
    "0–3 pairs",
    repeatedIdeas <= 3
      ? "Semantic-overlap checks found no excessive repetition."
      : "Multiple paragraphs substantially repeat earlier ideas.",
    "Editorial Quality",
  ));
  checks.push(makeCheck(
    "conclusion_share",
    "Conclusion Length",
    conclusionRatio <= 0.15 ? 100 : conclusionRatio <= 0.18 ? 70 : 0,
    conclusionRatio <= 0.15 ? "pass" : conclusionRatio <= 0.18 ? "warning" : "fail",
    `${((m.conclusionWordRatio ?? 0) * 100).toFixed(1)}% of article`,
    "≤18% (preferred ≤15%)",
    conclusionRatio <= 0.18
      ? "The conclusion remains proportionate to the article."
      : "The conclusion is over-expanded and functions like another article section (hard failure).",
    "Editorial Quality",
  ));
  checks.push(makeCheck(
    "editorial_score",
    "Editorial Quality Score",
    editorialScore,
    editorialScore >= 80
      ? "pass"
      : malformedProse > 0 || conclusionRatio > 0.18
        ? "fail"
        : "warning",
    `${editorialScore}/100`,
    "≥80/100",
    editorialScore >= 80
      ? "Deterministic prose, repetition and conclusion checks passed."
      : "The article does not meet the minimum editorial publication threshold.",
    "Editorial Quality",
  ));

  // ── Images (5%) ──

  // 16. Image Alt Text
  const imgMatches = blog.match(/<img[^>]*>/gi) ?? [];
  const imgsWithAlt = imgMatches.filter((img) => /alt=["'][^"']*["']/i.test(img) && !/alt=["']\s*["']/i.test(img));
  if (imgMatches.length === 0) {
    checks.push(makeCheck("image_alt", "Image Alt Text", null, "not_applicable", "No images", "Descriptive alt text", "No images found.", "Images"));
  } else if (imgsWithAlt.length === imgMatches.length) {
    checks.push(makeCheck("image_alt", "Image Alt Text", 100, "pass", `${imgMatches.length} with alt`, "All images have alt text", "All images have descriptive alt text.", "Images"));
  } else {
    const missing = imgMatches.length - imgsWithAlt.length;
    checks.push(makeCheck("image_alt", "Image Alt Text", 0, "fail", `${missing}/${imgMatches.length} missing`, "All images have alt text", `${missing} image(s) are missing alt text.`, "Images"));
  }

  // ── Weighted scoring (N/A checks excluded from denominator) ──
  let weightedSum = 0;
  let applicableWeight = 0;
  const categoryScores = new Map<string, { sum: number; weight: number; count: number }>();

  for (const check of checks) {
    if (!categoryScores.has(check.category)) {
      categoryScores.set(check.category, { sum: 0, weight: ENGLISH_CATEGORY_WEIGHTS[check.category] ?? 10, count: 0 });
    }
    const cs = categoryScores.get(check.category)!;
    if (check.status !== "not_applicable" && check.score !== null) {
      cs.sum += check.score;
      cs.count++;
    }
  }

  for (const [cat, cs] of categoryScores) {
    const catWeight = ENGLISH_CATEGORY_WEIGHTS[cat] ?? 10;
    if (cs.count > 0) {
      const avg = cs.sum / cs.count;
      weightedSum += (avg / 100) * catWeight;
      applicableWeight += catWeight;
    }
  }

  const naCategories = [...categoryScores.entries()].filter(([_, cs]) => cs.count === 0);
  if (naCategories.length > 0 && applicableWeight > 0) {
    const naWeight = naCategories.reduce((s, [cat]) => s + (ENGLISH_CATEGORY_WEIGHTS[cat] ?? 10), 0);
    weightedSum *= (1 + naWeight / applicableWeight);
  }

  const weightedScore = applicableWeight > 0 ? Math.round(weightedSum) : 0;
  const publishBlockingIds = new Set([
    "word_count", "h2_count", "faq_count", "keyphrase_density",
    "internal_links", "faq_schema", "cta_presence", "language_switcher",
    "claim_consistency", "conclusion_new_facts", "factual_score",
    "malformed_prose", "conclusion_share", "editorial_score",
  ]);
  const hasPublishBlockingFailure = checks.some(
    (check) => check.status === "fail" && publishBlockingIds.has(check.id),
  );
  const overallScore = hasPublishBlockingFailure
    ? Math.min(79, weightedScore)
    : weightedScore;

  return {
    overallScore,
    checks,
    summary: {
      passed: checks.filter((c) => c.status === "pass").length,
      warnings: checks.filter((c) => c.status === "warning").length,
      failed: checks.filter((c) => c.status === "fail").length,
      notApplicable: checks.filter((c) => c.status === "not_applicable").length,
    },
  };
}

// ── Traditional Chinese SEO audit ──
// Shares the same scoring framework as runAudit() with Chinese-specific rules.

export interface ChineseAuditInput {
  title: string;
  metaDescription: string;
  keyword: string;
  blog: string;
  faq?: Array<{ question: string; answer: string }>;
  englishWordCount: number;
  /** Paired English source FAQ count for exact parity. Defaults to 0 (no check). */
  pairedEnglishFaqCount?: number;
}

export function runChineseAudit(input: ChineseAuditInput): AuditResult {
  const { title, metaDescription, keyword, blog, faq, englishWordCount, pairedEnglishFaqCount = 0 } = input;
  const checks: AuditCheck[] = [];
  const keywordLower = keyword?.toLowerCase().trim() ?? "";
  const keywordHasCjk = /[\u4e00-\u9fff]/.test(keywordLower);
  const h2Texts = extractH2Texts(blog);
  const zhCharCount = countChineseCharacters(blog);
  const zhRange = chineseCharRange(englishWordCount);

  const makeCheck = (id: string, label: string, score: number | null, status: AuditStatus, measuredValue: string, targetValue: string, explanation: string, category: string): AuditCheck => ({ id, label, score, status, measuredValue, targetValue, explanation, category });

  const { min: zhTitleMin, max: zhTitleMax } = chineseTitleRange();
  const { min: zhMetaMin, max: zhMetaMax } = chineseMetaRange();
  const { warningBelow: kpLow, preferredMax: kpPref, stuffingAbove: kpStuff } = chineseKeyphraseDensity();
  const maxSents = paragraphSentenceLimit();
  const { min: linkMin, max: linkMax } = internalLinkRange();

  // 1. SEO Title Length — Chinese range from content-standards
  const titleLen = title.length;
  if (titleLen >= zhTitleMin && titleLen <= zhTitleMax) {
    checks.push(makeCheck("title_length", "SEO Title Length", 100, "pass", `${titleLen} chars`, `${zhTitleMin}–${zhTitleMax}`, "Title length is within the recommended Chinese range.", "SEO Fundamentals"));
  } else if (titleLen >= 20 && titleLen < zhTitleMin) {
    checks.push(makeCheck("title_length", "SEO Title Length", 90, "warning", `${titleLen} chars`, `${zhTitleMin}–${zhTitleMax}`, "Title is slightly short for Chinese content.", "SEO Fundamentals"));
  } else if (titleLen > zhTitleMax && titleLen <= 40) {
    checks.push(makeCheck("title_length", "SEO Title Length", 90, "warning", `${titleLen} chars`, `${zhTitleMin}–${zhTitleMax}`, "Title is slightly long for Chinese SEO.", "SEO Fundamentals"));
  } else if (titleLen > 0 && titleLen < 20) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${titleLen} chars`, `${zhTitleMin}–${zhTitleMax}`, "Title is too short for Chinese content.", "SEO Fundamentals"));
  } else if (titleLen > 40) {
    checks.push(makeCheck("title_length", "SEO Title Length", 50, "warning", `${titleLen} chars`, `${zhTitleMin}–${zhTitleMax}`, "Title is too long for Chinese SEO.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("title_length", "SEO Title Length", 0, "fail", "0 chars", `${zhTitleMin}–${zhTitleMax}`, "No SEO title found.", "SEO Fundamentals"));
  }

  // 2. Meta Description Length — Chinese range from content-standards
  const metaLen = metaDescription.length;
  if (metaLen >= zhMetaMin && metaLen <= zhMetaMax) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 100, "pass", `${metaLen} chars`, `${zhMetaMin}–${zhMetaMax}`, "Meta description is within the recommended Chinese range.", "SEO Fundamentals"));
  } else if (metaLen >= 60 && metaLen < zhMetaMin) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 90, "warning", `${metaLen} chars`, `${zhMetaMin}–${zhMetaMax}`, "Meta description is slightly short for Chinese content.", "SEO Fundamentals"));
  } else if (metaLen > zhMetaMax && metaLen <= 140) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 90, "warning", `${metaLen} chars`, `${zhMetaMin}–${zhMetaMax}`, "Meta description is slightly long for Chinese SEO.", "SEO Fundamentals"));
  } else if (metaLen > 0 && metaLen < 60) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 40, "warning", `${metaLen} chars`, `${zhMetaMin}–${zhMetaMax}`, "Meta description is too short for Chinese content.", "SEO Fundamentals"));
  } else if (metaLen > 140) {
    checks.push(makeCheck("meta_length", "Meta Description Length", 50, "warning", `${metaLen} chars`, `${zhMetaMin}–${zhMetaMax}`, "Meta description is too long for Chinese SEO.", "SEO Fundamentals"));
  } else {
    checks.push(makeCheck("meta_length", "Meta Description Length", 0, "fail", "0 chars", `${zhMetaMin}–${zhMetaMax}`, "No meta description found.", "SEO Fundamentals"));
  }

  // 3. Focus Keyphrase in SEO Title
  if (!keywordHasCjk) {
    checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", null, "not_applicable", "No CJK keyword", "Exact phrase in title", "Keyword has no CJK characters — set a Chinese focus keyphrase for this project.", "SEO Fundamentals"));
  } else if (keywordLower) {
    const inTitle = title.toLowerCase().includes(keywordLower);
    if (inTitle) {
      checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", 100, "pass", `"${keyword}" found`, "Exact phrase in title", "The focus keyphrase appears in the SEO title.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", 0, "fail", `"${keyword}" not found`, "Exact phrase in title", "The focus keyphrase is missing from the SEO title.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("keyphrase_title", "Keyphrase in SEO Title", null, "not_applicable", "No keyphrase", "Exact phrase in title", "No focus keyphrase configured for this project.", "SEO Fundamentals"));
  }

  // 4. Body Character Count — Chinese char range
  if (englishWordCount > 0) {
    const rangeLabel = `${zhRange.min.toLocaleString()}–${zhRange.max.toLocaleString()} chars`;
    if (zhCharCount >= zhRange.min && zhCharCount <= zhRange.max) {
      checks.push(makeCheck("char_count", "Chinese Character Count", 100, "pass", `${zhCharCount.toLocaleString()} characters`, rangeLabel, "Character count is within the accepted tolerance range.", "SEO Fundamentals"));
    } else if (zhCharCount >= zhRange.hardMin && zhCharCount <= zhRange.max * 1.05) {
      checks.push(makeCheck("char_count", "Chinese Character Count", 60, "warning", `${zhCharCount.toLocaleString()} characters`, rangeLabel, "Character count is slightly outside the target range.", "SEO Fundamentals"));
    } else {
      checks.push(makeCheck("char_count", "Chinese Character Count", 0, "fail", `${zhCharCount.toLocaleString()} characters`, rangeLabel, "Character count is significantly outside the target range.", "SEO Fundamentals"));
    }
  } else {
    checks.push(makeCheck("char_count", "Chinese Character Count", null, "not_applicable", "No target", "N/A", "No target word count configured.", "SEO Fundamentals"));
  }

  // 5. Keyphrase in First 200 Characters
  if (keywordHasCjk && keywordLower) {
    const readableText = extractReadableText(blog);
    const first200 = readableText.substring(0, 200).toLowerCase();
    const inFirst200 = first200.includes(keywordLower);
    if (inFirst200) {
      checks.push(makeCheck("keyphrase_first200", "Keyphrase in First 200 Characters", 100, "pass", "Found", "First 200 Chinese characters", "The keyphrase appears early in the content.", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_first200", "Keyphrase in First 200 Characters", 60, "warning", "Not found", "First 200 Chinese characters", "The focus keyphrase should appear within the first 200 characters (quality target, not a hard requirement).", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_first200", "Keyphrase in First 200 Characters", null, "not_applicable", "No CJK keyword", "First 200 Chinese characters", "Keyword has no CJK characters — set a Chinese focus keyphrase for this project.", "Content & Keyphrase"));
  }

  // 6. Keyphrase in H2
  if (keywordHasCjk && keywordLower) {
    const exactInH2 = h2Texts.some((h) => h.toLowerCase().includes(keywordLower));
    const matchedHeading = h2Texts.find((h) => h.toLowerCase().includes(keywordLower)) ?? "";
    if (exactInH2) {
      checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", 100, "pass", `"${matchedHeading}"`, "Exact phrase in H2", "The exact keyphrase appears in an H2 heading.", "Content & Keyphrase"));
    } else if (h2Texts.length > 0) {
      checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", 60, "warning", "Not found", "Exact phrase in H2", "The keyphrase is missing from all H2 headings (quality target, not a hard requirement).", "Content & Keyphrase"));
    } else {
      checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", 60, "warning", "No H2 headings", "Exact phrase in H2", "No H2 headings found — add H2s to structure your content.", "Content & Keyphrase"));
    }
  } else {
    checks.push(makeCheck("keyphrase_h2", "Keyphrase in H2", null, "not_applicable", "No CJK keyword", "Exact phrase in H2", "Keyword has no CJK characters — set a Chinese focus keyphrase for this project.", "Content & Keyphrase"));
  }

  // Canonical Chinese density: one calculation used for both occurrence and density checks.
  // kpCjkLen = number of CJK characters in the keyphrase (units of meaning for Chinese).
  let zhDensity: number | null = null;
  let zhExactCount = 0;
  if (keywordHasCjk && keywordLower && zhCharCount > 0) {
    const readableText = extractReadableText(blog);
    zhExactCount = countExactPhrase(readableText, keywordLower);
    const kpCjkLen = [...keywordLower].filter((c) => c.charCodeAt(0) >= 0x4E00).length || 1;
    zhDensity = (zhExactCount * kpCjkLen / zhCharCount) * 100;
  }

  // 7. Keyphrase Occurrences (density-aware for Chinese)
  if (keywordHasCjk && keywordLower && zhDensity !== null) {
    const densityHealthy = zhDensity >= kpLow && zhDensity <= kpPref;
    let kpScore: number; let kpStatus: AuditStatus; let kpMsg: string;
    if (densityHealthy) { kpScore = 100; kpStatus = "pass"; kpMsg = `Keyphrase density is healthy (${zhDensity.toFixed(2)}%) for this article length.`; }
    else if (zhDensity >= 0.3 && zhDensity < kpLow) { kpScore = 60; kpStatus = "warning"; kpMsg = `Keyphrase density is slightly low (${zhDensity.toFixed(2)}%). Consider naturally increasing keyphrase frequency.`; }
    else if (zhDensity > kpPref && zhDensity <= kpStuff) { kpScore = 60; kpStatus = "warning"; kpMsg = `Keyphrase density is above the preferred range but below stuffing threshold (${zhDensity.toFixed(2)}%). Consider using variations.`; }
    else if (zhDensity > kpStuff) { kpScore = 0; kpStatus = "fail"; kpMsg = `Keyphrase density exceeds stuffing threshold (${zhDensity.toFixed(2)}%) — hard failure. Reduce keyphrase occurrences.`; }
    else { kpScore = 60; kpStatus = "warning"; kpMsg = "Keyphrase density is very low — consider naturally increasing keyphrase frequency (soft warning)."; }
    checks.push(makeCheck("keyphrase_count", "Keyphrase Occurrences", kpScore, kpStatus, `${zhExactCount} occurrences`, `Density ${kpLow}%–${kpPref}% (preferred ~${kpPref}%, stuffing at ${kpStuff}%)`, kpMsg, "Content & Keyphrase"));
  } else {
    checks.push(makeCheck("keyphrase_count", "Keyphrase Occurrences", null, "not_applicable", "No CJK keyword", `Density ${kpLow}%–${kpPref}%`, "", "Content & Keyphrase"));
  }

  // 8. Keyphrase Density (weighted) — uses the SAME zhDensity as check 7
  if (keywordHasCjk && keywordLower && zhDensity !== null) {
    const densityStr = `${zhDensity.toFixed(2)}%`;
    const targetStr = `${kpLow}%–${kpPref}% (stuffing at ${kpStuff}%)`;
    if (zhDensity >= kpLow && zhDensity <= kpPref) { checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 100, "pass", densityStr, targetStr, "Density is within the healthy range.", "Content & Keyphrase")); }
    else if (zhDensity >= 0.3 && zhDensity < kpLow) { checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is slightly below the minimum (soft warning).", "Content & Keyphrase")); }
    else if (zhDensity > kpPref && zhDensity <= kpStuff) { checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is above the preferred range but below stuffing threshold.", "Content & Keyphrase")); }
    else if (zhDensity > kpStuff) { checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 0, "fail", densityStr, targetStr, "Density exceeds stuffing threshold (hard failure). Reduce keyphrase occurrences.", "Content & Keyphrase")); }
    else { checks.push(makeCheck("keyphrase_density", "Keyphrase Density", 60, "warning", densityStr, targetStr, "Density is very low (soft warning) — consider naturally increasing keyphrase frequency.", "Content & Keyphrase")); }
  } else {
    checks.push(makeCheck("keyphrase_density", "Keyphrase Density", null, "not_applicable", "N/A", `${kpLow}%–${kpPref}%`, "", "Content & Keyphrase"));
  }

  // 9. Paragraph Length — using canonical paragraphSentenceLimit()
  const totalParas = (blog.match(/<!--\s*wp:paragraph\s*-->/gi) ?? []).length;
  const longParas = countLongParagraphs(blog, maxSents);
  let paraScore: number; let paraStatus: AuditStatus; let paraMsg: string;
  if (longParas === 0) { paraScore = 100; paraStatus = "pass"; paraMsg = `All paragraphs stay within the recommended ${maxSents}-sentence limit.`; }
  else if (longParas <= 2) { paraScore = 80; paraStatus = "warning"; paraMsg = `${longParas} paragraph(s) contain more than ${maxSents} sentences. Consider splitting longer paragraphs.`; }
  else if (longParas <= 5) { paraScore = 60; paraStatus = "warning"; paraMsg = `${longParas} paragraphs exceed ${maxSents} sentences. Breaking these into shorter blocks improves readability.`; }
  else { paraScore = 60; paraStatus = "warning"; paraMsg = `${longParas} of ${totalParas} paragraphs exceed ${maxSents} sentences. Split longer paragraphs into shorter sections.`; }
  checks.push(makeCheck("paragraph_length", "Paragraph Length", paraScore, paraStatus, `${totalParas} paragraphs analysed`, `Max ${maxSents} sentences per paragraph`, `${totalParas} paragraphs analysed. ${longParas === 0 ? "All within the sentence limit." : `${longParas} paragraph(s) contain more than ${maxSents} sentences.`} ${paraMsg}`, "Readability"));

  // 10. Reading Level — N/A for Chinese (excluded from scoring)
  checks.push(makeCheck("reading_level", "Reading Level", null, "not_applicable", "N/A (Chinese content)", "N/A", "Flesch reading score does not apply to Chinese content.", "Readability"));

  // 11. Internal Links — using canonical internalLinkRange()
  const wpHtmlRanges: [number, number][] = [];
  let wm3: RegExpExecArray | null;
  const wpHtmlRegex3 = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  while ((wm3 = wpHtmlRegex3.exec(blog)) !== null) wpHtmlRanges.push([wm3.index, wm3.index + wm3[0].length]);
  const scriptRegex3 = /<script[\s\S]*?<\/script>/gi;
  while ((wm3 = scriptRegex3.exec(blog)) !== null) wpHtmlRanges.push([wm3.index, wm3.index + wm3[0].length]);
  const uniqueInternal3 = new Set<string>();
  const linkRegex3 = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let lm3: RegExpExecArray | null;
  while ((lm3 = linkRegex3.exec(blog)) !== null) { const href = lm3[1]; const pos = lm3.index; if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue; if (href.startsWith("/blog/")) uniqueInternal3.add(href); }
  const intLinkCount3 = uniqueInternal3.size;
  if (intLinkCount3 >= linkMin && intLinkCount3 <= linkMax) {
    checks.push(makeCheck("internal_links", "Internal Links", 100, "pass", `${intLinkCount3} unique`, `${linkMin}–${linkMax}`, "Internal link count is within the accepted range.", "Links"));
  } else {
    checks.push(makeCheck("internal_links", "Internal Links", 0, "fail", `${intLinkCount3} unique`, `${linkMin}–${linkMax}`, "More than 4 unique internal links — exceeds the maximum (hard failure).", "Links"));
  }

  // 12. External Links
  const externalSet3 = new Set<string>();
  let lm4: RegExpExecArray | null;
  while ((lm4 = linkRegex3.exec(blog)) !== null) { const href = lm4[1]; const pos = lm4.index; if (wpHtmlRanges.some(([s, e]) => pos >= s && pos < e)) continue; if (href.startsWith("http")) externalSet3.add(href); }
  const extLinkCount3 = externalSet3.size;
  if (extLinkCount3 > 0) {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", `${extLinkCount3} unique`, "0+ accepted", "External links are present — supports editorial credibility.", "Links"));
  } else {
    checks.push(makeCheck("external_links", "External Links", 100, "pass", "0 unique", "0+ accepted", "No external links found — 0 is acceptable per policy.", "Links"));
  }

  // 13a. FAQ Count Parity — must exactly match paired English source
  if (pairedEnglishFaqCount > 0) {
    const zhVisibleFaqCount = extractVisibleFaqFromArticle(blog).length;
    if (zhVisibleFaqCount === pairedEnglishFaqCount) {
      checks.push(makeCheck("faq_count", "FAQ Count Parity", 100, "pass", `${zhVisibleFaqCount} entries`, `${pairedEnglishFaqCount}`, "Chinese FAQ count matches the paired English source.", "Structure & Schema"));
    } else {
      checks.push(makeCheck("faq_count", "FAQ Count Parity", 0, "fail", `${zhVisibleFaqCount} entries`, `${pairedEnglishFaqCount}`, `Chinese FAQ count ${zhVisibleFaqCount} differs from English source ${pairedEnglishFaqCount} (hard failure).`, "Structure & Schema"));
    }
  } else {
    checks.push(makeCheck("faq_count", "FAQ Count Parity", null, "not_applicable", "No paired English source", "N/A", "No paired English source FAQ count available.", "Structure & Schema"));
  }

  // 13b. FAQ Schema — Chinese-only: audit only the LAST FAQPage JSON-LD block
  // (the Chinese schema, inserted after CTA). Reject empty answers and enforce
  // exact parity with the visible Chinese FAQ content.
  const scriptMatches3 = blog.match(/<script\s[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  let chineseFaqValid = false;
  let chineseFaqIssues: string[] = [];
  const allScripts = scriptMatches3.map((s) => {
    try { const jsonStr = s.replace(/<script[^>]*>/, "").replace(/<\/script>/, ""); return JSON.parse(jsonStr); } catch { return null; }
  }).filter(Boolean);
  // Find ALL FAQPage blocks, then pick the LAST one (Chinese, after CTA)
  const faqPages = allScripts.filter((p: any) => p?.["@type"] === "FAQPage" && Array.isArray(p?.mainEntity));
  if (faqPages.length > 0) {
    const lastFaqPage = faqPages[faqPages.length - 1] as any;
    const entities = lastFaqPage.mainEntity as Array<any>;
    // Check for empty answers
    const emptyAnswers = entities.filter((e: any) => !e.acceptedAnswer?.text?.trim());
    if (emptyAnswers.length > 0) {
      chineseFaqIssues.push(`${emptyAnswers.length} FAQ entr${emptyAnswers.length === 1 ? 'y has' : 'ies have'} empty acceptedAnswer.text`);
    }
    // Check parity: visible Chinese FAQ count should match schema question count
    const zhVisibleFaq = extractVisibleFaqFromArticle(blog);
    if (zhVisibleFaq.length > 0) {
      const schemaQuestionCount = entities.length;
      if (zhVisibleFaq.length !== schemaQuestionCount) {
        chineseFaqIssues.push(`Visible FAQ count (${zhVisibleFaq.length}) differs from schema question count (${schemaQuestionCount})`);
      }
      // Structure-only validation: counts match and no empty answers.
      // Exact text comparison between HTML-extracted visible FAQ and
      // JSON stringified schema is too fragile (whitespace, entity encoding).
    }
    chineseFaqValid = chineseFaqIssues.length === 0;
  }

  if (chineseFaqValid) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 100, "pass", "Valid Chinese FAQPage JSON-LD", "FAQPage schema", `Valid Chinese FAQPage structured data with ${faqPages[faqPages.length - 1].mainEntity.length} entries.`, "Structure & Schema"));
  } else if (faqPages.length > 0) {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", `Chinese FAQ issues: ${chineseFaqIssues.join("; ")}`, "FAQPage schema", chineseFaqIssues.join(". "), "Structure & Schema"));
  } else {
    checks.push(makeCheck("faq_schema", "FAQ Schema", 0, "fail", "No Chinese FAQPage JSON-LD found", "FAQPage schema", "No FAQPage schema found in the Chinese article.", "Structure & Schema"));
  }

  // ── Deterministic final editorial diagnostics (soft) ──
  // Detect proven Cantonese defects. These are warnings only — they never block
  // saving and must not create full-section AI repair loops.
  const blogText = blog.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (/([\u3400-\u9fff])\s+([\u3400-\u9fff])/u.test(blogText)) {
    checks.push(makeCheck("cjk_stray_whitespace", "CJK Stray Whitespace", 90, "warning", "Han-Han whitespace present", "No whitespace between CJK words", "Accidental whitespace detected between adjacent Chinese words.", "Content Quality"));
  }
  if (/或者\s*創作者\s*合作/.test(blogText)) {
    checks.push(makeCheck("creator_duplicate", "Duplicated Creator Phrase", 90, "warning", "「或者…創作者…合作」", "No duplicated 創作者", "Redundant creator phrase detected.", "Content Quality"));
  }
  if (/揀啱你\s*創作者/.test(blogText)) {
    checks.push(makeCheck("broken_possessive", "Broken Possessive Phrase", 90, "warning", "「揀啱你創作者…」", "Natural possessive 揀啱你嘅…", "Broken possessive construction detected.", "Content Quality"));
  }
  if (/感覺好人性化/.test(blogText)) {
    checks.push(makeCheck("literal_human", "Literal Human Phrase", 90, "warning", "「感覺好人性化」", "Natural 有人情味 phrasing", "Literal 'humanized' phrasing detected.", "Content Quality"));
  }
  // Formal written-Chinese register markers remaining in the body are advisory
  // only (never a hard failure and never a repair trigger). Protected compounds
  // such as 與其/與否/參與 are excluded by the glossary validator itself.
  const formalRegisterIssues = findFormalRegisterIssues(blogText);
  if (formalRegisterIssues.length > 0) {
    checks.push(makeCheck("formal_register", "Formal Register Markers", 90, "warning", `${formalRegisterIssues.length} markers`, "Conversational Cantonese", "Formal written-Chinese register markers remain; the deterministic normalizer should convert these.", "Content Quality"));
  }

  // ── Weighted scoring ──
  let weightedSum = 0;
  let applicableWeight = 0;
  const categoryScores = new Map<string, { sum: number; weight: number; count: number }>();
  for (const check of checks) {
    if (!categoryScores.has(check.category)) { categoryScores.set(check.category, { sum: 0, weight: CATEGORY_WEIGHTS[check.category] ?? 10, count: 0 }); }
    const cs = categoryScores.get(check.category)!;
    if (check.status !== "not_applicable" && check.score !== null) { cs.sum += check.score; cs.count++; }
  }
  for (const [cat, cs] of categoryScores) {
    const catWeight = CATEGORY_WEIGHTS[cat] ?? 10;
    if (cs.count > 0) { const avg = cs.sum / cs.count; weightedSum += (avg / 100) * catWeight; applicableWeight += catWeight; }
  }
  const naCategories = [...categoryScores.entries()].filter(([_, cs]) => cs.count === 0);
  if (naCategories.length > 0 && applicableWeight > 0) {
    const naWeight = naCategories.reduce((s, [cat]) => s + (CATEGORY_WEIGHTS[cat] ?? 10), 0);
    weightedSum *= (1 + naWeight / applicableWeight);
  }
  const overallScore = applicableWeight > 0 ? Math.round(weightedSum) : 0;

  return {
    overallScore,
    checks,
    summary: {
      passed: checks.filter((c) => c.status === "pass").length,
      warnings: checks.filter((c) => c.status === "warning").length,
      failed: checks.filter((c) => c.status === "fail").length,
      notApplicable: checks.filter((c) => c.status === "not_applicable").length,
    },
  };
}
