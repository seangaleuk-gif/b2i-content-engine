// ── Final complete-document editorial quality control ──
//
// This stage deliberately separates diagnosis, bounded rewriting and semantic
// acceptance.  The model never owns document assembly or final publication
// acceptance; ArticleDocument remains canonical and code validates every edit.

import {
  type ArticleDocument,
  fingerprintHtml,
  renderArticleDocument,
} from "@/lib/blog/article-document";
import type { ChatMessage, ChatOptions } from "@/lib/services/deepseek";
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

export type EditorialFindingCategory =
  | "cross-section-repetition"
  | "section-overlap"
  | "contradiction"
  | "unsupported-claim"
  | "exaggerated-claim"
  | "awkward-english"
  | "mechanical-english"
  | "brand-positioning";

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
}

interface DiagnosisEnvelope {
  findings: FullDocumentFinding[];
}

interface AcceptanceDecision {
  blockId: string;
  decision: "accept" | "reject";
  reasonCodes: string[];
}

const AUTO_EDITABLE_CATEGORIES = new Set<EditorialFindingCategory>([
  "cross-section-repetition",
  "section-overlap",
  "awkward-english",
  "mechanical-english",
]);

const BLOCKING_SEVERITIES = new Set<EditorialFindingSeverity>(["critical", "high"]);

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
    "cross-section-repetition", "section-overlap", "contradiction", "unsupported-claim",
    "exaggerated-claim", "awkward-english", "mechanical-english", "brand-positioning",
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
  if (typeof raw.message !== "string" || !raw.message.trim()) {
    throw new Error(`finding ${index} has no message`);
  }
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`finding ${index} has invalid confidence`);
  }
  return {
    findingId: typeof raw.findingId === "string" && raw.findingId.trim()
      ? raw.findingId.trim()
      : `model-${index + 1}`,
    category: raw.category as EditorialFindingCategory,
    severity: raw.severity as EditorialFindingSeverity,
    blockIds: [...new Set(raw.blockIds as string[])],
    message: raw.message.trim(),
    evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds.map(String) : [],
    brandRuleIds: Array.isArray(raw.brandRuleIds) ? raw.brandRuleIds.map(String) : [],
    confidence,
    source: "model",
  };
}

export function parseFullDocumentDiagnosis(content: string): DiagnosisEnvelope {
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

Return only {"findings":[...]} where each finding has exactly: findingId, category, severity, blockIds, message, evidenceIds, brandRuleIds, confidence.
Allowed categories: cross-section-repetition, section-overlap, contradiction, unsupported-claim, exaggerated-claim, awkward-english, mechanical-english, brand-positioning.
Allowed severities: critical, high, medium, low. Confidence is 0..1.
Use the exact stable block IDs supplied in editableBlocks. A finding may reference two or more block IDs. If an issue is confined to protected content and has no editable block ID, use an empty blockIds array and identify the protected field in the message.
Treat unsupported factual assertions, contradictory recommendations, guarantees and brand-positioning conflicts as high or critical. Do not flag a claim as supported unless the supplied research actually supports it. Detect semantic repetition and overlapping section purposes, not merely identical wording.`,
    },
    { role: "user", content: JSON.stringify(context) },
  ];
}

function deterministicRepetitionFindings(doc: ArticleDocument): FullDocumentFinding[] {
  return findRepetitionPairTargets(doc).map((target, index) => ({
    findingId: `det-repetition-${index + 1}`,
    category: "cross-section-repetition",
    severity: "high",
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
    const key = `${finding.category}:${[...finding.blockIds].sort().join("|")}:${finding.message.toLowerCase()}`;
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
      accepted: mode === "shadow",
    };
  }

  const targetErrors = validateFindingTargets(modelFindings, validIds);
  if (targetErrors.length > 0) {
    diagnostics.push(...targetErrors);
    if (mode === "enforce") {
      return {
        runId: id, mode, status: "rejected", doc: baseline, baselineFingerprint,
        outputFingerprint: baselineFingerprint, findings: modelFindings, selectedUnitIds: [], patches: [],
        unresolvedFindingIds: modelFindings
          .filter((finding) => BLOCKING_SEVERITIES.has(finding.severity))
          .map((finding) => finding.findingId),
        diagnostics, callCount, mandatoryOverflow: false, accepted: false,
      };
    }
    modelFindings = modelFindings.filter((finding) => finding.blockIds.every((blockId) => validIds.has(blockId)));
  }
  const findings = mergeFindings(modelFindings, deterministicRepetitionFindings(baseline));
  const blocking = findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));

  if (mode === "shadow") {
    return {
      runId: id, mode, status: "shadow", doc: baseline, baselineFingerprint,
      outputFingerprint: baselineFingerprint, findings, selectedUnitIds: [], patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId), diagnostics, callCount,
      mandatoryOverflow: false, accepted: true,
    };
  }

  const safeIds = new Set(findProseOnlyEditableBlockIds(
    baseline,
    params.keyphrase,
    params.research,
    params.protectedSentencesByBlockId ?? {},
  ));
  const selected: string[] = [];
  for (const finding of findings) {
    if (!AUTO_EDITABLE_CATEGORIES.has(finding.category)) continue;
    // Deterministic repetition findings name the preserved occurrence first
    // and the later repair target last. Never rewrite the preserved block.
    const candidateIds = finding.source === "deterministic"
      && finding.category === "cross-section-repetition"
      ? finding.blockIds.slice(-1)
      : finding.blockIds;
    for (const blockId of candidateIds) {
      if (safeIds.has(blockId) && validIds.has(blockId) && !selected.includes(blockId)) selected.push(blockId);
    }
  }
  const mandatorySelected = selected.filter((blockId) =>
    findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity) && finding.blockIds.includes(blockId)),
  );
  const mandatoryOverflow = mandatorySelected.length > FULL_DOCUMENT_EDITORIAL_EDIT_CAP;
  if (mandatoryOverflow) {
    return {
      runId: id, mode, status: "rejected", doc: baseline, baselineFingerprint,
      outputFingerprint: baselineFingerprint, findings, selectedUnitIds: selected, patches: [],
      unresolvedFindingIds: blocking.map((finding) => finding.findingId),
      diagnostics: [...diagnostics, `mandatory edit capacity exceeded (${mandatorySelected.length} > ${FULL_DOCUMENT_EDITORIAL_EDIT_CAP})`],
      callCount, mandatoryOverflow: true, accepted: false,
    };
  }
  const selectedUnitIds = [
    ...mandatorySelected,
    ...selected.filter((id) => !mandatorySelected.includes(id)),
  ].slice(0, FULL_DOCUMENT_EDITORIAL_EDIT_CAP);

  if (selectedUnitIds.length === 0) {
    const unresolved = blocking.map((finding) => finding.findingId);
    return {
      runId: id, mode, status: unresolved.length === 0 ? "accepted" : "rejected", doc: baseline,
      baselineFingerprint, outputFingerprint: baselineFingerprint, findings, selectedUnitIds,
      patches: [], unresolvedFindingIds: unresolved, diagnostics, callCount,
      mandatoryOverflow: false, accepted: unresolved.length === 0,
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
      mode: "general",
      maxAttempts: 1,
      fullDocumentContext: context,
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

  const resolvedFindingIds = new Set<string>();
  for (const finding of findings) {
    if (
      AUTO_EDITABLE_CATEGORIES.has(finding.category)
      && finding.blockIds.some((blockId) => patches.some((patch) => patch.blockId === blockId && patch.accepted))
    ) {
      resolvedFindingIds.add(finding.findingId);
    }
  }
  const unresolvedFindingIds = blocking
    .filter((finding) => !resolvedFindingIds.has(finding.findingId))
    .map((finding) => finding.findingId);
  const accepted = deterministicAccepted && unresolvedFindingIds.length === 0;
  const committedDoc = accepted ? finalDoc : baseline;
  return {
    runId: id,
    mode,
    status: accepted ? "accepted" : "rejected",
    doc: committedDoc,
    baselineFingerprint,
    outputFingerprint: fingerprintHtml(renderArticleDocument(committedDoc)),
    findings,
    selectedUnitIds,
    patches,
    unresolvedFindingIds,
    diagnostics,
    callCount,
    mandatoryOverflow: false,
    accepted,
  };
}
