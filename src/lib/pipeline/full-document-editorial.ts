// ── Final complete-document editorial quality control ──
//
// This stage deliberately separates diagnosis, bounded rewriting and semantic
// acceptance.  The model never owns document assembly or final publication
// acceptance; ArticleDocument remains canonical and code validates every edit.

import {
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
  countCanonicalVisibleWords,
  fingerprintHtml,
  parseArticleDocumentFromHtml,
  renderArticleDocument,
  renderEditorialBlocksToWordPress,
} from "@/lib/blog/article-document";
import type { ChatMessage, ChatOptions } from "@/lib/services/deepseek";
import { createNumberExpressionRegex } from "@/lib/services/translation-number-grammar";
import { validateCoherence } from "@/lib/blog/coherence";
import { scanSentenceQualityInDocument, licensedRepeatedWordSpansFromEvidence } from "@/lib/blog/sentence-quality";
import { scanMalformedProseInDocument } from "@/lib/blog/publication-quality";
import {
  applyEdits,
  extractEditableBlocks,
  findProseOnlyEditableBlockIds,
  findRepetitionPairTargets,
  runEditorialPolish,
  validateCandidate,
  type CandidateValidation,
  type PolishEdit,
} from "@/lib/pipeline/editorial-polish";

export const FULL_DOCUMENT_EDITORIAL_FLAG = "ENABLE_FULL_DOCUMENT_EDITORIAL";
export const FULL_DOCUMENT_EDITORIAL_MODE = "FULL_DOCUMENT_EDITORIAL_MODE";
export const FULL_DOCUMENT_EDITORIAL_FINDING_CAP = 60;
export const FULL_DOCUMENT_EDITORIAL_EDIT_CAP = 25;
// Compact-response bounds for the final-document diagnosis. The diagnosis must
// return bounded structured findings only — it never needs to reproduce article
// content — so every field is capped and the total response size is bounded far
// below the observed runaway responses (>113,000 chars / ~30,000 tokens).
export const FULL_DOCUMENT_EDITORIAL_RESPONSE_CHAR_CAP = 48_000;
export const FULL_DOCUMENT_EDITORIAL_MESSAGE_CHAR_CAP = 240;
export const FULL_DOCUMENT_EDITORIAL_MAX_BLOCK_IDS = 8;
export const FULL_DOCUMENT_EDITORIAL_MAX_EVIDENCE_IDS = 20;
export const FULL_DOCUMENT_EDITORIAL_MAX_BRAND_RULE_IDS = 10;

export type PublishabilityClass = "blocking" | "stylistic";

export type EditorialFindingCategory =
  | "orphan-reference"
  | "pronoun-agreement"
  | "broken-transition"
  | "local-duplication"
  | "cohesion-defect"
  | "cross-section-repetition"
  | "section-overlap"
  | "contradiction"
  | "unsupported-claim"
  | "exaggerated-claim"
  | "awkward-english"
  | "mechanical-english"
  | "brand-positioning"
  | "stylistic-preference"
  | "rhetorical-fragment"
  | "repeated-opener"
  | "punchier-wording";

export type EditorialFindingSeverity = "critical" | "high" | "medium" | "low";

export interface BrandPositioningRule {
  id: string;
  version: string;
  requirement: "required" | "allowed" | "forbidden";
  statement: string;
  severity: EditorialFindingSeverity;
}

export interface FullDocumentFinding {
  findingId: string;
  category: EditorialFindingCategory;
  severity: EditorialFindingSeverity;
  /** Narrow publishability class. Only "blocking" findings may ever gate
   *  publication, and only when they satisfy the confidence contract below.
   *  The model's raw severity label alone never decides publishability. */
  publishability: PublishabilityClass;
  blockIds: string[];
  message: string;
  evidenceIds: string[];
  brandRuleIds: string[];
  confidence: number;
  source: "model" | "deterministic";
}

export interface FullDocumentPatchLog {
  patchId: string;
  blockId: string;
  findingIds: string[];
  beforeFingerprint: string;
  afterFingerprint: string;
  accepted: boolean;
  rejectionReasons: string[];
}

export interface FullDocumentEditorialOutcome {
  runId: string;
  mode: "shadow" | "enforce";
  status: "accepted" | "rejected" | "shadow" | "failed";
  doc: ArticleDocument;
  baselineFingerprint: string;
  outputFingerprint: string;
  findings: FullDocumentFinding[];
  selectedUnitIds: string[];
  patches: FullDocumentPatchLog[];
  unresolvedFindingIds: string[];
  diagnostics: string[];
  callCount: number;
  mandatoryOverflow: boolean;
  accepted: boolean;
  blockingCount: number;
  stylisticCount: number;
  verified: boolean;
}

interface DiagnosisEnvelope {
  findings: FullDocumentFinding[];
}

interface AcceptanceDecision {
  blockId: string;
  decision: "accept" | "reject";
  reasonCodes: string[];
}

// Blocking-capable semantic categories. Findings in these categories may only
// become publication blockers when the model ALSO labels them publishability
// "blocking" AND confidence meets the contract. Everything else — including
// broad style categories, repetition, local/cohesion variants that are not
// objectively meaning-breaking, and low-confidence ambiguous semantics — is
// stylistic and can never block publication, regardless of the raw severity
// label or of deterministic detection confidence. Detection confidence never
// determines publication severity.
//
// Exaggerated/unsupported claims are deliberately NOT here: unsupported and
// exaggerated factual claims are owned by the factual validation authority
// (scanUnsupportedClaimsInDocument / the final policy's unsupported-claims
// gate), not by the editorial diagnosis.
const BLOCKING_CATEGORIES = new Set<EditorialFindingCategory>([
  "orphan-reference",
  "pronoun-agreement",
  "broken-transition",
  "local-duplication",
  "cohesion-defect",
  "contradiction",
]);

// Deliberately conservative confidence contract: a model-only semantic finding
// may become a publication blocker only at very high confidence. Ambiguous
// cases remain stylistic/nonblocking — a false-positive blocker is more
// dangerous than a missed style suggestion.
export const FULL_DOCUMENT_EDITORIAL_BLOCKING_CONFIDENCE_MIN = 0.8;

export function isBlockingFinding(finding: FullDocumentFinding): boolean {
  if (finding.source === "deterministic") {
    return finding.publishability === "blocking";
  }
  return finding.publishability === "blocking"
    && BLOCKING_CATEGORIES.has(finding.category)
    && finding.confidence >= FULL_DOCUMENT_EDITORIAL_BLOCKING_CONFIDENCE_MIN;
}

export function isStylisticFinding(finding: FullDocumentFinding): boolean {
  return !isBlockingFinding(finding);
}

const DEFAULT_BRAND_RULES: BrandPositioningRule[] = [
  {
    id: "b2i-direct-connection",
    version: "1",
    requirement: "required",
    statement: "B2I Hub connects businesses directly with verified creators.",
    severity: "high",
  },
  {
    id: "b2i-no-agency-positioning",
    version: "1",
    requirement: "forbidden",
    statement: "Do not position B2I Hub as an agency, managed campaign service, commission-taking intermediary or middleman.",
    severity: "critical",
  },
  {
    id: "b2i-no-unsupported-guarantees",
    version: "1",
    requirement: "forbidden",
    statement: "Do not promise or guarantee campaign, sales, reach or creator-performance outcomes.",
    severity: "critical",
  },
];

function runId(): string {
  return `fdq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isFullDocumentEditorialEnabled(): boolean {
  return process.env[FULL_DOCUMENT_EDITORIAL_FLAG] === "true";
}

export function fullDocumentEditorialMode(): "shadow" | "enforce" {
  return process.env[FULL_DOCUMENT_EDITORIAL_MODE] === "enforce" ? "enforce" : "shadow";
}

export function loadBrandPositioningRules(): BrandPositioningRule[] {
  const raw = process.env.B2I_BRAND_POSITIONING_RULES;
  if (!raw?.trim()) return DEFAULT_BRAND_RULES;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) throw new Error("rules must be an array");
    const rules = value.filter((entry): entry is BrandPositioningRule => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as Record<string, unknown>;
      return typeof item.id === "string"
        && typeof item.version === "string"
        && ["required", "allowed", "forbidden"].includes(String(item.requirement))
        && typeof item.statement === "string"
        && ["critical", "high", "medium", "low"].includes(String(item.severity));
    });
    if (rules.length !== value.length || rules.length === 0) {
      throw new Error("one or more rules are invalid");
    }
    return rules;
  } catch (error) {
    throw new Error(`Invalid B2I_BRAND_POSITIONING_RULES: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeFinding(raw: Record<string, unknown>, index: number): FullDocumentFinding {
  const categories: EditorialFindingCategory[] = [
    "orphan-reference", "pronoun-agreement", "broken-transition", "local-duplication", "cohesion-defect",
    "cross-section-repetition", "section-overlap", "contradiction", "unsupported-claim",
    "exaggerated-claim", "awkward-english", "mechanical-english", "brand-positioning",
    "stylistic-preference", "rhetorical-fragment", "repeated-opener", "punchier-wording",
  ];
  const severities: EditorialFindingSeverity[] = ["critical", "high", "medium", "low"];
  if (!categories.includes(raw.category as EditorialFindingCategory)) {
    throw new Error(`finding ${index} has invalid category`);
  }
  if (!severities.includes(raw.severity as EditorialFindingSeverity)) {
    throw new Error(`finding ${index} has invalid severity`);
  }
  if (!Array.isArray(raw.blockIds) || raw.blockIds.some((id) => typeof id !== "string")) {
    throw new Error(`finding ${index} has invalid blockIds`);
  }
  if (raw.blockIds.length > FULL_DOCUMENT_EDITORIAL_MAX_BLOCK_IDS) {
    throw new Error(`finding ${index} references too many blockIds (${raw.blockIds.length})`);
  }
  if (typeof raw.message !== "string" || !raw.message.trim()) {
    throw new Error(`finding ${index} has no message`);
  }
  if (raw.message.trim().length > FULL_DOCUMENT_EDITORIAL_MESSAGE_CHAR_CAP) {
    throw new Error(`finding ${index} message exceeds ${FULL_DOCUMENT_EDITORIAL_MESSAGE_CHAR_CAP} characters`);
  }
  if (Array.isArray(raw.evidenceIds) && raw.evidenceIds.length > FULL_DOCUMENT_EDITORIAL_MAX_EVIDENCE_IDS) {
    throw new Error(`finding ${index} has too many evidenceIds (${raw.evidenceIds.length})`);
  }
  if (Array.isArray(raw.brandRuleIds) && raw.brandRuleIds.length > FULL_DOCUMENT_EDITORIAL_MAX_BRAND_RULE_IDS) {
    throw new Error(`finding ${index} has too many brandRuleIds (${raw.brandRuleIds.length})`);
  }
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`finding ${index} has invalid confidence`);
  }
  // Backward compatibility: an omitted publishability label defaults to
  // "stylistic" (nonblocking). Only an explicit blocking label plus the
  // category/confidence contract can gate publication.
  const publishability: PublishabilityClass =
    raw.publishability === "blocking" || raw.publishability === "stylistic"
      ? raw.publishability
      : "stylistic";
  return {
    findingId: typeof raw.findingId === "string" && raw.findingId.trim()
      ? raw.findingId.trim()
      : `model-${index + 1}`,
    category: raw.category as EditorialFindingCategory,
    severity: raw.severity as EditorialFindingSeverity,
    publishability,
    blockIds: [...new Set(raw.blockIds as string[])],
    message: raw.message.trim(),
    evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds.map(String) : [],
    brandRuleIds: Array.isArray(raw.brandRuleIds) ? raw.brandRuleIds.map(String) : [],
    confidence,
    source: "model",
  };
}

export function parseFullDocumentDiagnosis(content: string): DiagnosisEnvelope {
  // Total response bound: the diagnosis must be a compact JSON findings list.
  // A response this large cannot be legitimate findings (the observed runaway
  // response was ~113,351 chars / ~30,019 tokens for an empty findings array).
  if (content.length > FULL_DOCUMENT_EDITORIAL_RESPONSE_CHAR_CAP) {
    throw new Error(
      `diagnosis response too large (${content.length} chars > ${FULL_DOCUMENT_EDITORIAL_RESPONSE_CHAR_CAP})`,
    );
  }
  const parsed = JSON.parse(stripJsonFence(content)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("diagnosis must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.findings)) throw new Error("diagnosis is missing findings");
  if (root.findings.length > FULL_DOCUMENT_EDITORIAL_FINDING_CAP) {
    throw new Error(`diagnosis returned too many findings (${root.findings.length})`);
  }
  const findings = root.findings.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`finding ${index} must be an object`);
    }
    return normalizeFinding(item as Record<string, unknown>, index);
  });
  const ids = findings.map((finding) => finding.findingId);
  if (new Set(ids).size !== ids.length) throw new Error("diagnosis contains duplicate finding IDs");
  return { findings };
}

function documentContext(
  doc: ArticleDocument,
  research: unknown[],
  brandRules: BrandPositioningRule[],
  protectedBlockIds: string[] = [],
) {
  return {
    metadata: doc.metadata,
    completeRenderedArticle: renderArticleDocument(doc),
    editableBlocks: extractEditableBlocks(doc, protectedBlockIds),
    protected: {
      languageSwitcher: doc.languageSwitcher,
      cta: doc.cta,
      visibleFaq: doc.visibleFaq,
      faqSchema: doc.faqSchema,
      insertedLinks: doc.insertedLinks,
    },
    research,
    brandRules,
  };
}

function diagnosisMessages(context: ReturnType<typeof documentContext>): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are the final senior editor for a professional B2B article. Inspect the COMPLETE supplied article, including every section and protected field. Diagnose only; do not rewrite anything.

Return ONLY a compact {"findings":[...]} JSON object where each finding has exactly: findingId, category, severity, publishability, blockIds, message, evidenceIds, brandRuleIds, confidence.
Allowed categories: orphan-reference, pronoun-agreement, broken-transition, local-duplication, cohesion-defect, cross-section-repetition, section-overlap, contradiction, unsupported-claim, exaggerated-claim, awkward-english, mechanical-english, brand-positioning, stylistic-preference, rhetorical-fragment, repeated-opener, punchier-wording.
Allowed severities: critical, high, medium, low. Confidence is 0..1. publishability is exactly "blocking" or "stylistic".

BLOCKING vs STYLISTIC — this decision gates publication, so be deliberately conservative:
- publishability "blocking" ONLY for an objectively broken local semantic defect that a reader cannot parse correctly and that is unambiguous in context. Examples: an orphan deictic reference ("That comment shows...") with no surviving antecedent; a clear pronoun/antecedent or subject/pronoun number disagreement ("Social media offers... They offer..."); a clear local subject-verb agreement defect; a broken local transition left by removed content; local duplication producing incoherent prose; a malformed sentence join or other objectively broken local cohesion.
- publishability "stylistic" for: conversational rhetorical fragments that are intentional and grammatical, repeated stylistic openers such as "Remember,", wording that could merely be punchier, harmless rhythm/tone preferences, and general stylistic polish.
- Do NOT let the raw severity label alone decide publishability. A "high"/"critical" label on a stylistic preference is still publishability "stylistic". When in doubt — an ambiguous pronoun, a plausible antecedent, a debatable word choice — publishability MUST be "stylistic". False-positive blockers are far more dangerous than missed style suggestions.

Use the exact stable block IDs supplied in editableBlocks. A finding may reference two or more block IDs. If an issue is confined to protected content and has no editable block ID, use an empty blockIds array and identify the protected field in the message.
Treat unsupported factual assertions, contradictory recommendations, guarantees and brand-positioning conflicts as high or critical. Do not flag a claim as supported unless the supplied research actually supports it. Detect semantic repetition and overlapping section purposes, not merely identical wording.

STRICT OUTPUT BOUNDS — the response must be small:
- Do NOT reproduce, echo, paraphrase, summarise or quote the article, any block, paragraph, sentence, heading or protected field anywhere in the response. Never embed unchanged article content.
- Reference blocks only by their stable block IDs; never include block HTML.
- At most 30 findings, usually far fewer.
- message must be a concise reason of at most 240 characters.
- blockIds: at most 8 entries. evidenceIds: at most 20 entries. brandRuleIds: at most 10 entries.
Return only genuine findings. Do not manufacture findings to reach the maximum count. Order findings by severity and editorial impact.`,
    },
    { role: "user", content: JSON.stringify(context) },
  ];
}

function deterministicRepetitionFindings(doc: ArticleDocument): FullDocumentFinding[] {
  return findRepetitionPairTargets(doc).map((target, index) => ({
    findingId: `det-repetition-${index + 1}`,
    category: "cross-section-repetition",
    severity: "high",
    // Detected deterministically (confidence 1) but NEVER publication-blocking:
    // repetition is a stylistic/readability signal, and detection confidence
    // does not determine publication severity. It is reported for shadow
    // observation and repair suggestions, but can never fail an article.
    publishability: "stylistic" as const,
    blockIds: [target.preserveBlockId, target.blockId],
    message: `Paragraphs overlap at ${(target.overlap * 100).toFixed(0)}%; preserve ${target.preserveBlockId} and repair ${target.blockId}.`,
    evidenceIds: [],
    brandRuleIds: [],
    confidence: 1,
    source: "deterministic",
  }));
}

function validateFindingTargets(findings: FullDocumentFinding[], validIds: ReadonlySet<string>): string[] {
  const diagnostics: string[] = [];
  for (const finding of findings) {
    for (const id of finding.blockIds) {
      if (!validIds.has(id)) diagnostics.push(`finding ${finding.findingId} references unknown block ${id}`);
    }
  }
  return diagnostics;
}

function mergeFindings(model: FullDocumentFinding[], deterministic: FullDocumentFinding[]): FullDocumentFinding[] {
  const out: FullDocumentFinding[] = [];
  const seen = new Set<string>();
  for (const finding of [...deterministic, ...model]) {
    const key = `${finding.publishability}:${finding.category}:${[...finding.blockIds].sort().join("|")}:${finding.message.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function changedBlocks(before: ArticleDocument, after: ArticleDocument): Array<{ blockId: string; beforeHtml: string; afterHtml: string }> {
  const beforeById = new Map(extractEditableBlocks(before).map((block) => [block.blockId, block]));
  return extractEditableBlocks(after).flatMap((block) => {
    const original = beforeById.get(block.blockId);
    return original && original.html !== block.html
      ? [{ blockId: block.blockId, beforeHtml: original.html, afterHtml: block.html }]
      : [];
  });
}

function parseAcceptance(content: string, changedIds: string[]): AcceptanceDecision[] {
  const parsed = JSON.parse(stripJsonFence(content)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("acceptance response must be an object");
  }
  const raw = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(raw)) throw new Error("acceptance response is missing decisions");
  const decisions = raw.map((item, index): AcceptanceDecision => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`decision ${index} invalid`);
    const value = item as Record<string, unknown>;
    if (typeof value.blockId !== "string" || !changedIds.includes(value.blockId)) {
      throw new Error(`decision ${index} references an unknown changed block`);
    }
    if (value.decision !== "accept" && value.decision !== "reject") {
      throw new Error(`decision ${index} has invalid decision`);
    }
    return {
      blockId: value.blockId,
      decision: value.decision,
      reasonCodes: Array.isArray(value.reasonCodes) ? value.reasonCodes.map(String) : [],
    };
  });
  if (new Set(decisions.map((decision) => decision.blockId)).size !== decisions.length) {
    throw new Error("acceptance response contains duplicate block decisions");
  }
  const missing = changedIds.filter((id) => !decisions.some((decision) => decision.blockId === id));
  if (missing.length > 0) throw new Error(`acceptance response omitted changed blocks: ${missing.join(", ")}`);
  return decisions;
}

function acceptanceMessages(params: {
  changes: ReturnType<typeof changedBlocks>;
  findings: FullDocumentFinding[];
  context: ReturnType<typeof documentContext>;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: `Act as an independent validation-only senior editor. Compare each before/after block against the complete article, research and brand rules. Return only {"decisions":[{"blockId":"...","decision":"accept|reject","reasonCodes":["..."]}]}.
Reject any edit that changes meaning, factual strength, recommendation strength, named entities, attribution, brand positioning, numbers, dates, links, or introduces unsupported information. Reject wording that remains repetitive, awkward or mechanically generated. Do not propose replacement prose.`,
    },
    {
      role: "user",
      content: JSON.stringify({ changes: params.changes, findings: params.findings, completeDocumentReadOnly: params.context }),
    },
  ];
}



interface VerificationResolved {
  findingId: string;
  resolved: boolean;
}

interface VerificationNewFinding {
  findingId: string;
  category: string;
  blockIds: string[];
  message: string;
  confidence: number;
}

interface VerificationResult {
  resolved: VerificationResolved[];
  newBlocking: VerificationNewFinding[];
}

function verificationMessages(params: {
  blockingFindings: FullDocumentFinding[];
  candidate: ArticleDocument;
  research: unknown[];
  brandRules: BrandPositioningRule[];
  protectedBlockIds?: string[];
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: `Act as an independent verification-only senior editor. The supplied article is a CANDIDATE produced by a bounded repair. Verify ONLY: (1) each listed blocking defect is actually resolved in the candidate; (2) the repair introduced NO new blocking semantic defect (orphan deictic reference with no surviving antecedent, pronoun/antecedent or subject/pronoun number disagreement, subject-verb agreement defect, broken local transition left by removed content, local duplication producing incoherent prose, malformed sentence join). Do NOT reopen stylistic preferences, wording polish, rhythm, tone or "punchier" alternatives, and do not propose rewrites. Return only {"resolved":[{"findingId":"...","resolved":true|false}],"newBlockingFindings":[{"findingId":"...","category":"...","blockIds":["..."],"message":"...","confidence":0.9}]}. resolved MUST list every supplied findingId exactly once. newBlockingFindings MUST be empty unless a genuinely new blocking defect was introduced by the repair; its category must be one of the blocking categories (orphan-reference, pronoun-agreement, broken-transition, local-duplication, cohesion-defect, contradiction). Never report a style finding as newBlocking.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        blockingFindings: params.blockingFindings,
        completeDocumentReadOnly: documentContext(
          params.candidate,
          params.research,
          params.brandRules,
          params.protectedBlockIds,
        ),
      }),
    },
  ];
}

function parseVerification(content: string, expectedFindingIds: string[]): VerificationResult {
  const parsed = JSON.parse(stripJsonFence(content)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("verification response must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.resolved)) throw new Error("verification response is missing resolved");
  const resolved = root.resolved.map((item, index): VerificationResolved => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`resolved ${index} invalid`);
    const value = item as Record<string, unknown>;
    if (typeof value.findingId !== "string" || typeof value.resolved !== "boolean") {
      throw new Error(`resolved ${index} invalid`);
    }
    return { findingId: value.findingId, resolved: value.resolved };
  });
  const ids = new Set(resolved.map((entry) => entry.findingId));
  if (ids.size !== resolved.length) throw new Error("verification response contains duplicate finding IDs");
  const missing = expectedFindingIds.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new Error(`verification omitted findings: ${missing.join(", ")}`);
  const unknown = [...ids].filter((id) => !expectedFindingIds.includes(id));
  if (unknown.length > 0) throw new Error(`verification listed unknown findings: ${unknown.join(", ")}`);
  const newBlocking: VerificationNewFinding[] = [];
  if (root.newBlockingFindings !== undefined) {
    if (!Array.isArray(root.newBlockingFindings)) throw new Error("newBlockingFindings must be an array");
    for (const item of root.newBlockingFindings) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("newBlockingFindings entry invalid");
      const value = item as Record<string, unknown>;
      if (typeof value.findingId !== "string" || typeof value.message !== "string" || !Array.isArray(value.blockIds)) {
        throw new Error("newBlockingFindings entry invalid");
      }
      const confidence = Number(value.confidence);
      newBlocking.push({
        findingId: value.findingId,
        category: String(value.category),
        blockIds: value.blockIds.map(String),
        message: value.message,
        confidence: Number.isFinite(confidence) ? confidence : 0,
      });
    }
  }
  return { resolved, newBlocking };
}

function blockPlainText(block: EditorialBlock): string {
  const groups = block.type === "list"
    ? block.items
    : block.type === "table"
      ? [...block.headers, ...block.rows.flat()]
      : [block.content];
  return groups.flat().map((inline) => inline.text).join(" ").replace(/\s+/g, " ").trim();
}

function blockHasLink(block: EditorialBlock): boolean {
  const groups = block.type === "list"
    ? block.items
    : block.type === "table"
      ? [...block.headers, ...block.rows.flat()]
      : [block.content];
  return groups.flat().some((inline) => inline.type === "link");
}

function blockNumbers(block: EditorialBlock): string[] {
  return [...blockPlainText(block).matchAll(createNumberExpressionRegex("gi"))].map((match) =>
    match[0].replace(/\s+/g, " ").toLowerCase(),
  );
}

const ORPHAN_REMOVAL_ATTRIBUTION_RE =
  /\b(?:according to|research (?:from|by|shows?)|a study (?:from|by|shows?)|data (?:from|shows?)|industry (?:research|data|insights?) (?:from|shows?)?)/gi;

function blockAttributions(block: EditorialBlock): string[] {
  return [...blockPlainText(block).matchAll(new RegExp(ORPHAN_REMOVAL_ATTRIBUTION_RE.source, "gi"))].map((match) =>
    match[0].toLowerCase(),
  );
}

function resolveEditableTarget(
  doc: ArticleDocument,
  blockId: string,
): { component: ArticleComponent | ArticleSection; index: number; block: EditorialBlock } | null {
  const parts = blockId.split(":");
  if (parts.length !== 3) return null;
  const [, , encodedBlock] = parts;
  const rawBlockId = decodeURIComponent(encodedBlock);
  const components: Array<ArticleComponent | ArticleSection> = [
    doc.introduction,
    ...doc.sections,
    doc.conclusion,
  ];
  for (const component of components) {
    const index = component.blocks.findIndex((block) => block.id === rawBlockId);
    if (index >= 0) return { component, index, block: component.blocks[index] };
  }
  return null;
}

function validateOrphanRemoval(
  baseline: ArticleDocument,
  candidate: ArticleDocument,
  validateProductionCandidate?: (candidate: ArticleDocument) => CandidateValidation,
  research: Array<{ title?: string; snippet?: string; url?: string }> = [],
): string[] {
  const reasons: string[] = [];
  if (validateProductionCandidate) {
    const production = validateProductionCandidate(candidate);
    if (!production.passed) reasons.push(...production.reasons.map((reason) => `production validation: ${reason}`));
  } else {
    const before = countCanonicalVisibleWords(baseline);
    const after = countCanonicalVisibleWords(candidate);
    if (Math.abs(after - before) > before * 0.1) {
      reasons.push(`word count changed by more than 10%: ${before} → ${after}`);
    }
  }
  for (const violation of validateCoherence(candidate)) {
    reasons.push(`coherence ${violation.type} in ${violation.componentId}`);
  }
  for (const finding of scanMalformedProseInDocument(candidate)) {
    reasons.push(`malformed prose in ${finding.blockId}`);
  }
  for (const finding of scanSentenceQualityInDocument(candidate, {
    licensedRepeatedWordSpans: licensedRepeatedWordSpansFromEvidence(research),
  })) {
    reasons.push(`sentence quality in ${finding.blockId}`);
  }
  const candidateHtml = renderArticleDocument(candidate);
  const parsed = parseArticleDocumentFromHtml(candidateHtml, candidate);
  if (!parsed.doc) {
    reasons.push(`WordPress parser rejected candidate: ${parsed.errors.join("; ")}`);
  } else if (fingerprintHtml(renderArticleDocument(parsed.doc)) !== fingerprintHtml(candidateHtml)) {
    reasons.push("WordPress round-trip changed candidate content");
  }
  return reasons;
}

export async function runFullDocumentEditorial(params: {
  doc: ArticleDocument;
  keyphrase: string;
  research: Array<{ title?: string; snippet?: string; url?: string }>;
  protectedBlockIds?: string[];
  protectedSentencesByBlockId?: Record<string, string[]>;
  validateProductionCandidate?: (candidate: ArticleDocument) => CandidateValidation;
  aiCall: (messages: ChatMessage[], options?: ChatOptions, label?: string) => Promise<{ content: string }>;
}): Promise<FullDocumentEditorialOutcome> {
  const id = runId();
  const mode = fullDocumentEditorialMode();
  const baseline = structuredClone(params.doc) as ArticleDocument;
  const baselineFingerprint = fingerprintHtml(renderArticleDocument(baseline));
  const brandRules = loadBrandPositioningRules();
  const context = documentContext(baseline, params.research, brandRules, params.protectedBlockIds);
  const editable = extractEditableBlocks(baseline, params.protectedBlockIds ?? []);
  const validIds = new Set(editable.map((block) => block.blockId));
  const diagnostics: string[] = [];
  let callCount = 0;

  let modelFindings: FullDocumentFinding[];
  try {
    callCount++;
    const response = await params.aiCall(diagnosisMessages(context), {
      responseFormat: { type: "json_object" }, temperature: 0.1, timeoutMs: 120_000,
    }, "final-document-diagnosis");
    modelFindings = parseFullDocumentDiagnosis(response.content).findings;
  } catch (error) {
    const message = `diagnosis failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      runId: id, mode, status: mode === "shadow" ? "shadow" : "failed", doc: baseline,
      baselineFingerprint, outputFingerprint: baselineFingerprint, findings: [], selectedUnitIds: [], patches: [],
      unresolvedFindingIds: [], diagnostics: [message], callCount, mandatoryOverflow: false,
      accepted: mode === "shadow", blockingCount: 0, stylisticCount: 0, verified: false,
    };
  }

  const targetErrors = validateFindingTargets(modelFindings, validIds);
  if (targetErrors.length > 0) {
    diagnostics.push(...targetErrors);
    if (mode === "enforce") {
      const rejectBlocking = modelFindings.filter(isBlockingFinding);
      return {
        runId: id, mode, status: "rejected", doc: baseline, baselineFingerprint,
        outputFingerprint: baselineFingerprint, findings: modelFindings, selectedUnitIds: [], patches: [],
        unresolvedFindingIds: rejectBlocking.map((finding) => finding.findingId),
        diagnostics, callCount, mandatoryOverflow: false, accepted: false,
        blockingCount: rejectBlocking.length, stylisticCount: modelFindings.length - rejectBlocking.length,
        verified: false,
      };
    }
    modelFindings = modelFindings.filter((finding) => finding.blockIds.every((blockId) => validIds.has(blockId)));
  }
  const findings = mergeFindings(modelFindings, deterministicRepetitionFindings(baseline));
  const blocking = findings.filter(isBlockingFinding);
  const stylisticCount = findings.length - blocking.length;

  if (mode === "shadow") {
    return {
      runId: id, mode, status: "shadow", doc: baseline, baselineFingerprint,
      outputFingerprint: baselineFingerprint, findings, selectedUnitIds: [], patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId), diagnostics, callCount,
      mandatoryOverflow: false, accepted: true, blockingCount: blocking.length, stylisticCount, verified: false,
    };
  }

  // Selection: ONLY blocking findings may drive a repair. Stylistic findings
  // (including model "high"/"critical" style preferences) are reported but
  // never selected, so they can never gate publication.
  const safeIds = new Set(findProseOnlyEditableBlockIds(
    baseline,
    params.keyphrase,
    params.research,
    params.protectedSentencesByBlockId ?? {},
  ));
  const selected: string[] = [];
  for (const finding of blocking) {
    // Deterministic repetition findings name the preserved occurrence first
    // and the later repair target last. Never rewrite the preserved block.
    const candidateIds = finding.source === "deterministic"
      && finding.category === "cross-section-repetition"
      ? finding.blockIds.slice(-1)
      : finding.blockIds;
    for (const blockId of candidateIds) {
      if (!validIds.has(blockId) || selected.includes(blockId)) continue;
      // Deterministic repetition repairs stay prose-only; semantic blocking
      // repairs may touch a fact-carrying block because the patch machinery
      // protects numbers/links/attributions inside it.
      if (finding.source === "deterministic" && !safeIds.has(blockId)) continue;
      selected.push(blockId);
    }
  }
  const mandatoryOverflow = selected.length > FULL_DOCUMENT_EDITORIAL_EDIT_CAP;
  if (mandatoryOverflow) {
    return {
      runId: id, mode, status: "rejected", doc: baseline, baselineFingerprint,
      outputFingerprint: baselineFingerprint, findings, selectedUnitIds: selected, patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId),
      diagnostics: [...diagnostics, `mandatory edit capacity exceeded (${selected.length} > ${FULL_DOCUMENT_EDITORIAL_EDIT_CAP})`],
      callCount, mandatoryOverflow: true, accepted: false,
      blockingCount: blocking.length, stylisticCount, verified: false,
    };
  }
  const selectedUnitIds = selected.slice(0, FULL_DOCUMENT_EDITORIAL_EDIT_CAP);

  if (selectedUnitIds.length === 0) {
    const unresolved = blocking.map((finding) => finding.findingId);
    return {
      runId: id, mode, status: unresolved.length === 0 ? "accepted" : "rejected", doc: baseline,
      baselineFingerprint, outputFingerprint: baselineFingerprint, findings, selectedUnitIds,
      patches: [], unresolvedFindingIds: unresolved, diagnostics, callCount,
      mandatoryOverflow: false, accepted: unresolved.length === 0,
      blockingCount: blocking.length, stylisticCount, verified: false,
    };
  }

  callCount++;
  const patchResult = await runEditorialPolish(
    baseline,
    params.keyphrase,
    (messages, options) => params.aiCall(messages, options, "final-document-patch"),
    {
      protectedBlockIds: params.protectedBlockIds,
      editableBlockIds: selectedUnitIds,
      protectedSentencesByBlockId: params.protectedSentencesByBlockId,
      mode: "semantic",
      maxAttempts: 1,
      fullDocumentContext: context,
      semanticFindings: blocking.map((finding) => ({
        findingId: finding.findingId,
        category: finding.category,
        publishability: finding.publishability,
        confidence: finding.confidence,
        message: finding.message,
        blockIds: finding.blockIds,
      })),
      validateProductionCandidate: params.validateProductionCandidate,
    },
  );
  if (!patchResult.result.accepted) {
    return {
      runId: id, mode, status: "rejected", doc: baseline, baselineFingerprint,
      outputFingerprint: baselineFingerprint, findings, selectedUnitIds, patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId),
      diagnostics: [...diagnostics, `patch generation rejected: ${patchResult.result.reason}`], callCount,
      mandatoryOverflow: false, accepted: false,
      blockingCount: blocking.length, stylisticCount, verified: false,
    };
  }

  const changes = changedBlocks(baseline, patchResult.doc);
  if (changes.length === 0) {
    return {
      runId: id, mode, status: blocking.length === 0 ? "accepted" : "rejected", doc: baseline,
      baselineFingerprint, outputFingerprint: baselineFingerprint, findings, selectedUnitIds, patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId),
      diagnostics: [...diagnostics, "patch call made no document changes"], callCount,
      mandatoryOverflow: false, accepted: blocking.length === 0,
      blockingCount: blocking.length, stylisticCount, verified: false,
    };
  }

  let decisions: AcceptanceDecision[];
  try {
    callCount++;
    const response = await params.aiCall(acceptanceMessages({ changes, findings, context }), {
      responseFormat: { type: "json_object" }, temperature: 0, maxTokens: 8_192, timeoutMs: 120_000,
    }, "final-document-acceptance");
    decisions = parseAcceptance(response.content, changes.map((change) => change.blockId));
  } catch (error) {
    return {
      runId: id, mode, status: "rejected", doc: baseline, baselineFingerprint,
      outputFingerprint: baselineFingerprint, findings, selectedUnitIds, patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId),
      diagnostics: [...diagnostics, `semantic acceptance failed: ${error instanceof Error ? error.message : String(error)}`],
      callCount, mandatoryOverflow: false, accepted: false,
      blockingCount: blocking.length, stylisticCount, verified: false,
    };
  }

  const acceptedIds = new Set(decisions.filter((decision) => decision.decision === "accept").map((decision) => decision.blockId));
  const candidateById = new Map(extractEditableBlocks(patchResult.doc).map((block) => [block.blockId, block]));
  const acceptedEdits: PolishEdit[] = changes
    .filter((change) => acceptedIds.has(change.blockId))
    .map((change) => ({
      blockId: change.blockId,
      replacementHtml: candidateById.get(change.blockId)?.html ?? change.afterHtml,
      reason: "Accepted by final semantic validator",
    }));
  let finalDoc = baseline;
  let patchApplicationFailed = false;
  try {
    finalDoc = applyEdits(
      baseline,
      acceptedEdits,
      params.protectedBlockIds,
      selectedUnitIds,
      params.protectedSentencesByBlockId,
    );
  } catch (error) {
    patchApplicationFailed = true;
    diagnostics.push(`accepted patch application failed: ${error instanceof Error ? error.message : String(error)}`);
    finalDoc = baseline;
  }
  const deterministic = validateCandidate(baseline, finalDoc, params.keyphrase, params.validateProductionCandidate);
  if (!deterministic.passed) diagnostics.push(...deterministic.reasons.map((reason) => `final patch validation: ${reason}`));
  const deterministicAccepted = !patchApplicationFailed && deterministic.passed;

  const patches: FullDocumentPatchLog[] = changes.map((change, index) => {
    const decision = decisions.find((item) => item.blockId === change.blockId);
    return {
      patchId: `${id}-patch-${index + 1}`,
      blockId: change.blockId,
      findingIds: findings.filter((finding) => finding.blockIds.includes(change.blockId)).map((finding) => finding.findingId),
      beforeFingerprint: fingerprintHtml(change.beforeHtml),
      afterFingerprint: fingerprintHtml(change.afterHtml),
      accepted: deterministicAccepted && decision?.decision === "accept",
      rejectionReasons: decision?.decision === "reject"
        ? decision.reasonCodes
        : deterministicAccepted
          ? []
          : patchApplicationFailed
            ? ["accepted patch application failed"]
            : deterministic.reasons,
    };
  });

  // Bounded deterministic fallback: a blocking orphan-reference finding whose
  // block was not repaired by the AI patch may be removed when the block is a
  // short, low-value transition carrying no protected surface (no links,
  // numbers, attributions or protected sentences), the component keeps at
  // least one block, and the removal validates cleanly.
  const acceptedPatchBlockIds = new Set(acceptedEdits.map((edit) => edit.blockId));
  const removedBlockIds: string[] = [];
  let committedDoc = finalDoc;
  if (deterministicAccepted) {
    for (const finding of blocking) {
      if (finding.category !== "orphan-reference") continue;
      for (const blockId of finding.blockIds) {
        if (acceptedPatchBlockIds.has(blockId) || removedBlockIds.includes(blockId)) continue;
        const target = resolveEditableTarget(committedDoc, blockId);
        if (!target) continue;
        if (target.block.type !== "paragraph") continue;
        const words = blockPlainText(target.block).trim().split(/\s+/).filter(Boolean).length;
        if (words > 80 || words === 0) continue;
        if (blockHasLink(target.block)) continue;
        if (blockNumbers(target.block).length > 0) continue;
        if (blockAttributions(target.block).length > 0) continue;
        if ((params.protectedSentencesByBlockId?.[blockId]?.length ?? 0) > 0) continue;
        if (target.component.blocks.length <= 1) continue;
        const removalCandidate = structuredClone(committedDoc);
        const removalTarget = resolveEditableTarget(removalCandidate, blockId);
        if (!removalTarget) continue;
        removalTarget.component.blocks.splice(removalTarget.index, 1);
        removalTarget.component.status = "normalized";
        const removalReasons = validateOrphanRemoval(
          committedDoc,
          removalCandidate,
          params.validateProductionCandidate,
          params.research,
        );
        if (removalReasons.length > 0) {
          diagnostics.push(`orphan removal for ${blockId} rejected: ${removalReasons.join("; ")}`);
          continue;
        }
        committedDoc = removalCandidate;
        removedBlockIds.push(blockId);
        patches.push({
          patchId: `${id}-patch-removed-${removedBlockIds.length}`,
          blockId,
          findingIds: [finding.findingId],
          beforeFingerprint: fingerprintHtml(renderEditorialBlocksToWordPress([target.block])),
          afterFingerprint: "",
          accepted: true,
          rejectionReasons: [],
        });
      }
    }
  }

  // Second semantic verification pass (bounded, verification-only). It confirms
  // each blocking finding is actually resolved in the committed candidate and
  // detects whether an accepted patch introduced a NEW blocking defect. Style
  // is never reopened. Any unresolved or newly introduced blocking finding
  // fails closed — deterministic validation alone cannot prove an anaphoric or
  // cohesion defect was semantically repaired.
  let verified = false;
  if (deterministicAccepted && (acceptedEdits.length > 0 || removedBlockIds.length > 0)) {
    try {
      callCount++;
      const response = await params.aiCall(
        verificationMessages({
          blockingFindings: blocking,
          candidate: committedDoc,
          research: params.research,
          brandRules,
          protectedBlockIds: params.protectedBlockIds,
        }),
        { responseFormat: { type: "json_object" }, temperature: 0, timeoutMs: 120_000 },
        "final-document-verification",
      );
      const verification = parseVerification(response.content, blocking.map((finding) => finding.findingId));
      const anyUnresolved = verification.resolved.some((entry) => !entry.resolved);
      const newBlockingDefect = verification.newBlocking.filter((entry) =>
        BLOCKING_CATEGORIES.has(entry.category as EditorialFindingCategory)
        && entry.confidence >= FULL_DOCUMENT_EDITORIAL_BLOCKING_CONFIDENCE_MIN,
      );
      if (anyUnresolved) {
        diagnostics.push(
          `verification unresolved findings: ${verification.resolved.filter((entry) => !entry.resolved).map((entry) => entry.findingId).join(", ")}`,
        );
      } else if (newBlockingDefect.length > 0) {
        diagnostics.push(`verification reported new blocking defect: ${newBlockingDefect.map((entry) => entry.findingId).join(", ")}`);
      } else {
        verified = true;
      }
    } catch (error) {
      diagnostics.push(`verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const patchedOrRemovedBlockIds = new Set([...acceptedPatchBlockIds, ...removedBlockIds]);
  const resolvedFindingIds = new Set<string>();
  for (const finding of blocking) {
    if (finding.blockIds.some((blockId) => patchedOrRemovedBlockIds.has(blockId))) {
      resolvedFindingIds.add(finding.findingId);
    }
  }
  const unresolvedFindingIds = blocking
    .filter((finding) => !resolvedFindingIds.has(finding.findingId) || !verified)
    .map((finding) => finding.findingId);
  const accepted = deterministicAccepted && verified && unresolvedFindingIds.length === 0;
  const committedFingerprint = accepted
    ? fingerprintHtml(renderArticleDocument(committedDoc))
    : baselineFingerprint;
  return {
    runId: id,
    mode,
    status: accepted ? "accepted" : "rejected",
    doc: accepted ? committedDoc : baseline,
    baselineFingerprint,
    outputFingerprint: committedFingerprint,
    findings,
    selectedUnitIds,
    patches,
    unresolvedFindingIds,
    diagnostics,
    callCount,
    mandatoryOverflow: false,
    accepted,
    blockingCount: blocking.length,
    stylisticCount,
    verified,
  };
}
