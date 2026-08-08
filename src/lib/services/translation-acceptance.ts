import type { ArticleDocument } from "@/lib/blog/article-document";
import { findSourceAwareLiteralTranslations } from "@/lib/services/document-context-editorial-review";
import {
  checkCtaParity,
  findUnnaturalCalques,
  unresolvedMandatoryFindings,
} from "@/lib/services/editorial-review-gate";
import { validateTranslatedDocument } from "@/lib/services/translation-service";
import type { TranslationReviewSummary } from "@/lib/services/translation-version-metadata";
import {
  analyzeZhHkLanguageQuality,
  collectAlignedUnits,
} from "@/lib/services/zh-hk-language-quality";

type ResearchEvidence = Array<{ title: string; snippet?: string; url: string }>;

export interface TranslationDocumentAcceptanceResult {
  accepted: boolean;
  errors: string[];
  parityErrors: string[];
  blockingQuality: Array<{ sourceUnitId: string; messageCode: string }>;
  unnaturalCalques: Array<{ sourceUnitId: string; reason: string }>;
  sourceAwareLiteralTranslations: Array<{ sourceUnitId: string; reason: string }>;
  ctaMissingClaims: string[];
  reviewErrors: string[];
}

/**
 * One deterministic acceptance owner for the exact EN/ZH ArticleDocument pair.
 * Removing an English token is never sufficient: the replacement must also
 * pass parity, HK-Cantonese quality, source-aware literalness, CTA, structure,
 * terminology and protected-content checks.
 */
export function evaluateTranslationDocumentAcceptance(params: {
  enDoc: ArticleDocument;
  zhDoc: ArticleDocument;
  research: ResearchEvidence;
  review?: TranslationReviewSummary;
  requireFullDocumentReview?: boolean;
}): TranslationDocumentAcceptanceResult {
  const { enDoc, zhDoc, research, review, requireFullDocumentReview = false } = params;
  const parityErrors = validateTranslatedDocument(enDoc, zhDoc, research);
  const blockingQuality = unresolvedMandatoryFindings(analyzeZhHkLanguageQuality(zhDoc, enDoc));
  const unnaturalCalques = findUnnaturalCalques(zhDoc).map(({ sourceUnitId, reason }) => ({ sourceUnitId, reason }));
  const sourceAwareLiteralTranslations = findSourceAwareLiteralTranslations(collectAlignedUnits(enDoc, zhDoc));
  const ctaMissingClaims = checkCtaParity(zhDoc).missingClaims;
  const reviewErrors: string[] = [];

  if (requireFullDocumentReview) {
    if (review?.status !== "run" || review.documentAccepted !== true) {
      reviewErrors.push("complete-document editorial acceptance is missing");
    }
    if ((review?.unresolvedUnitIds?.length ?? 0) > 0) {
      reviewErrors.push(`unresolved units=${review!.unresolvedUnitIds!.join(", ")}`);
    }
  }

  const errors = [
    ...parityErrors.map((error) => `Translation parity: ${error}`),
    ...blockingQuality.map((finding) =>
      `Traditional Chinese quality: ${finding.sourceUnitId}:${finding.messageCode}`,
    ),
    ...unnaturalCalques.map((finding) =>
      `Traditional Chinese naturalness: ${finding.sourceUnitId}:${finding.reason}`,
    ),
    ...sourceAwareLiteralTranslations.map((finding) =>
      `Traditional Chinese source-aware literalness: ${finding.sourceUnitId}:${finding.reason}`,
    ),
    ...ctaMissingClaims.map((claim) => `Traditional Chinese CTA missing: ${claim}`),
    ...reviewErrors.map((error) => `Traditional Chinese review: ${error}`),
  ];

  return {
    accepted: errors.length === 0,
    errors,
    parityErrors,
    blockingQuality,
    unnaturalCalques,
    sourceAwareLiteralTranslations,
    ctaMissingClaims,
    reviewErrors,
  };
}
