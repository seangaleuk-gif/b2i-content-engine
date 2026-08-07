// Fresh, deterministic acceptance checks for saved bilingual versions.
// Publishing never trusts a previous route response or independently chooses
// the latest EN and ZH rows: it validates one explicitly paired snapshot.

import type { BlogVersion } from "@/db/schema/blog-versions";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  countCanonicalVisibleWords,
  parseArticleDocumentFromHtml,
  renderArticleDocument,
} from "@/lib/blog/article-document";
import {
  analyzeFinalArticle,
  buildPolicy,
  evaluatePolicy,
} from "@/lib/blog/final-article-policy";
import { validateTranslatedDocument } from "@/lib/services/translation-service";
import { analyzeZhHkLanguageQuality } from "@/lib/services/zh-hk-language-quality";
import {
  checkCtaParity,
  findUnnaturalCalques,
  unresolvedMandatoryFindings,
} from "@/lib/services/editorial-review-gate";
import { runChineseAudit } from "@/lib/services/seo-auditor";
import { parseTranslationVersionSummary } from "@/lib/services/translation-version-metadata";

type ResearchEvidence = Array<{ title: string; snippet?: string; url: string }>;

export interface BilingualVersionPair {
  en: BlogVersion;
  zh: BlogVersion;
  zhFocusKeyphrase: string;
}

export interface PublicationAcceptanceResult {
  accepted: boolean;
  enDoc: ArticleDocument | null;
  zhDoc: ArticleDocument | null;
  errors: string[];
  diagnostics: {
    enPolicyReasons: string[];
    translationParityErrors: string[];
    zhBlockingQuality: Array<{ sourceUnitId: string; messageCode: string }>;
    zhUnnaturalCalques: Array<{ sourceUnitId: string; reason: string }>;
    zhSeoFailures: string[];
  };
}

export function selectBilingualVersionPair(versions: BlogVersion[]): BilingualVersionPair | null {
  const englishById = new Map(
    versions
      .filter((version) => version.blog && version.slug && !version.slug.endsWith("-zh"))
      .map((version) => [version.id, version]),
  );
  for (const zh of versions) {
    if (!zh.blog || !zh.slug?.endsWith("-zh")) continue;
    const metadata = parseTranslationVersionSummary(zh.summary);
    if (!metadata) continue;
    const en = englishById.get(metadata.sourceEnVersionId);
    if (en) return { en, zh, zhFocusKeyphrase: metadata.focusKeyphrase };
  }
  return null;
}

function seedDocument(version: BlogVersion, keyphrase: string, targetWordCount: number): ArticleDocument {
  return {
    metadata: {
      title: version.title || "",
      slug: version.slug || "",
      metaDescription: version.metaDescription || "",
      excerpt: version.excerpt || "",
      targetWordCount,
      focusKeyphrase: keyphrase,
    },
    languageSwitcher: null,
    introduction: { id: "publication-introduction", blocks: [], status: "generated" },
    sections: [],
    visibleFaq: (version.faq || []).map((entry) => ({
      question: entry.question,
      answerHtml: entry.answer,
      answerText: entry.answer.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    })),
    conclusion: { id: "publication-conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

function reconstruct(version: BlogVersion, keyphrase: string, targetWordCount: number): {
  doc: ArticleDocument | null;
  errors: string[];
} {
  if (!version.blog) return { doc: null, errors: [`version ${version.id} has no blog HTML`] };
  const parsed = parseArticleDocumentFromHtml(
    version.blog,
    seedDocument(version, keyphrase, targetWordCount),
  );
  if (!parsed.doc) return parsed;
  parsed.doc.metadata = {
    ...parsed.doc.metadata,
    title: version.title || "",
    slug: version.slug || "",
    metaDescription: version.metaDescription || "",
    excerpt: version.excerpt || "",
    targetWordCount,
    focusKeyphrase: keyphrase,
  };
  if (renderArticleDocument(parsed.doc) !== version.blog) {
    return { doc: null, errors: [`version ${version.id} is not a canonical ArticleDocument round-trip`] };
  }
  return parsed;
}

function storedEnglishEditorialAcceptance(version: BlogVersion) {
  const quality = version.tokenUsage?.qualityAcceptance;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return null;
  const value = quality as Record<string, unknown>;
  const mode = value.mode === "enforce" ? "enforce" as const : "shadow" as const;
  return {
    // A historical shadow diagnosis must never become publishable merely
    // because enforcement was enabled later.
    accepted: value.accepted === true && mode === "enforce",
    mode,
    unresolvedFindingIds: Array.isArray(value.unresolvedFindingIds)
      ? value.unresolvedFindingIds.map(String)
      : [],
    mandatoryOverflow: value.mandatoryOverflow === true,
    patches: Array.isArray(value.patches)
      ? value.patches.map((patch) => ({
          accepted: Boolean(patch && typeof patch === "object" && (patch as Record<string, unknown>).accepted === true),
        }))
      : [],
  };
}

export function validatePublicationPair(params: {
  pair: BilingualVersionPair;
  englishKeyphrase: string;
  requestedWordCount: number;
  research: ResearchEvidence;
}): PublicationAcceptanceResult {
  const { pair, englishKeyphrase, requestedWordCount, research } = params;
  const errors: string[] = [];
  const enParsed = reconstruct(pair.en, englishKeyphrase, requestedWordCount);
  const zhParsed = reconstruct(pair.zh, pair.zhFocusKeyphrase, requestedWordCount);
  errors.push(...enParsed.errors.map((error) => `English: ${error}`));
  errors.push(...zhParsed.errors.map((error) => `Traditional Chinese: ${error}`));

  const diagnostics: PublicationAcceptanceResult["diagnostics"] = {
    enPolicyReasons: [],
    translationParityErrors: [],
    zhBlockingQuality: [],
    zhUnnaturalCalques: [],
    zhSeoFailures: [],
  };
  if (!enParsed.doc || !zhParsed.doc) {
    return { accepted: false, enDoc: enParsed.doc, zhDoc: zhParsed.doc, errors, diagnostics };
  }

  const enDoc = enParsed.doc;
  const zhDoc = zhParsed.doc;
  const fullDocumentEditorial = storedEnglishEditorialAcceptance(pair.en);
  const policy = buildPolicy(requestedWordCount, undefined, undefined, englishKeyphrase);
  const enMetrics = analyzeFinalArticle(
    pair.en.blog || "",
    englishKeyphrase,
    pair.en.title || "",
    pair.en.metaDescription || "",
    requestedWordCount,
    countCanonicalVisibleWords(enDoc),
    { articleDoc: enDoc, research, fullDocumentEditorial },
  );
  const enDecision = evaluatePolicy(enMetrics, policy);
  diagnostics.enPolicyReasons = enDecision.reasons.filter((reason) => !reason.startsWith("[SOFT]"));
  if (!enDecision.passed) errors.push(...diagnostics.enPolicyReasons.map((reason) => `English gate: ${reason}`));

  const metadata = parseTranslationVersionSummary(pair.zh.summary);
  if (process.env.ENABLE_FULL_DOCUMENT_ZH_REVIEW === "true") {
    if (metadata?.review?.status !== "run" || metadata.review.documentAccepted !== true) {
      errors.push("Traditional Chinese gate: complete-document editorial acceptance is missing");
    }
    const unresolvedUnitIds = metadata?.review?.unresolvedUnitIds ?? [];
    if (unresolvedUnitIds.length > 0) {
      errors.push(`Traditional Chinese gate: unresolved units=${unresolvedUnitIds.join(", ")}`);
    }
  }

  diagnostics.translationParityErrors = validateTranslatedDocument(enDoc, zhDoc, research);
  errors.push(...diagnostics.translationParityErrors.map((error) => `Translation parity: ${error}`));

  diagnostics.zhBlockingQuality = unresolvedMandatoryFindings(analyzeZhHkLanguageQuality(zhDoc, enDoc));
  errors.push(...diagnostics.zhBlockingQuality.map((finding) =>
    `Traditional Chinese quality: ${finding.sourceUnitId}:${finding.messageCode}`,
  ));
  diagnostics.zhUnnaturalCalques = findUnnaturalCalques(zhDoc).map(({ sourceUnitId, reason }) => ({ sourceUnitId, reason }));
  errors.push(...diagnostics.zhUnnaturalCalques.map((finding) =>
    `Traditional Chinese naturalness: ${finding.sourceUnitId}:${finding.reason}`,
  ));

  const cta = checkCtaParity(zhDoc);
  errors.push(...cta.missingClaims.map((claim) => `Traditional Chinese CTA missing: ${claim}`));
  const zhAudit = runChineseAudit({
    title: pair.zh.title || "",
    metaDescription: pair.zh.metaDescription || "",
    keyword: pair.zhFocusKeyphrase,
    blog: pair.zh.blog || "",
    faq: zhDoc.visibleFaq.map((entry) => ({ question: entry.question, answer: entry.answerText })),
    englishWordCount: countCanonicalVisibleWords(enDoc),
    pairedEnglishFaqCount: enDoc.visibleFaq.length,
  });
  diagnostics.zhSeoFailures = zhAudit.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.label);
  errors.push(...diagnostics.zhSeoFailures.map((failure) => `Traditional Chinese SEO: ${failure}`));

  return { accepted: errors.length === 0, enDoc, zhDoc, errors, diagnostics };
}
