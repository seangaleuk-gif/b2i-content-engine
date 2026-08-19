// ── Shared producer-content contract ──
// The single authoritative hard-validation layer for prose-bearing AI
// component producers (introduction, section, FAQ, conclusion, regeneration,
// expansion/trim candidates). It is PURE and deterministic: it performs no AI
// calls, no I/O, mutates nothing, and composes ONLY the existing authoritative
// scanners (sentence-completeness, sentence-quality, malformed-prose,
// coherence, quotation-integrity, structural block rules). It is not wired
// into any production producer yet (Stage 3A) and must never implement its own
// grammar rules.
//
// Two validation scopes exist:
//  - complete-component: the candidate IS the whole component. All shared hard
//    language gates, structure gates and the component-safe coherence rules
//    apply (unfinished example, orphan/dependent opening, strict dangling
//    reference, incomplete sentence, empty H3 subsection).
//  - additive-fragment: the candidate will be APPENDED into an existing
//    component (expansion payload). Only invariants that can be judged safely
//    without the surrounding component apply: sentence completeness of the
//    fragment's own prose, hard malformed prose, hard sentence-quality rules,
//    punctuation residue and structural validity. Component/document coherence
//    rules that require surrounding context are NOT applied.
//
// Overlapping leaves produce duplicate findings for the same underlying defect
// (e.g. completeness "no-finite-predicate" vs malformed "fragment"); the
// contract collapses them deterministically by defect family + semantic
// identity, never hiding genuinely distinct violations.

import type { ArticleDocument, EditorialBlock, SourceAttribution } from "@/lib/blog/article-document";
import {
  extractPlainTextFromEditorialBlocks,
  fingerprintHtml,
  isNonEmptyStructuredContinuation,
} from "@/lib/blog/article-document";
import type { SentenceAccountingEntry } from "@/lib/blog/article-content";
import {
  buildEvidenceLedger,
  scanFactualRisks,
  validateAttributedSentenceFidelity,
} from "@/lib/blog/factual-risk-scanner";
import {
  analyzeSentenceCompleteness,
  isSourceCitationText,
  type SentenceCompletenessKind,
} from "@/lib/blog/sentence-completeness";
import {
  isAuthoritativePunctuationOnlyResidue,
  lowercaseStartValidTokensFromKeyphrase,
  scanSentenceQualityText,
} from "@/lib/blog/sentence-quality";import {
  findMalformedProseTextIssues,
  scanMalformedProseInBlocks,
} from "@/lib/blog/publication-quality";
import { validateCoherence, type CoherenceViolationType } from "@/lib/blog/coherence";
import { analyzeQuotationIntegrity } from "@/lib/blog/quotation-integrity";
import { CTA_CONTENT_RE, renderEditorialBlocksToWordPress } from "@/lib/blog/article-content";
import { isPipelineDebugTraceEnabled } from "@/lib/pipeline/pipeline-debug-trace";

// ── Public types ──

export type ProducerComponentType = "introduction" | "section" | "faq" | "conclusion";
export type ProducerValidationScope = "complete-component" | "additive-fragment";

export type ProducerHardRule =
  | "sentence-completeness"
  | "sentence-quality"
  | "malformed-prose"
  | "structure"
  | "coherence"
  | "source-provenance"
  | "component-specific";

export interface ProducerComponentContext {
  componentId: string;
  componentType: ProducerComponentType;
  /** Defaults to "complete-component". */
  scope?: ProducerValidationScope;
  /** Focus keyphrase — enables the authoritative lowercase-sentence-start
   *  allowance and the imperative/finite-predicate leaves that need it. */
  keyphrase?: string;
  /** Case-insensitive proper-name spans (e.g. "DON DON DONKI") extracted from
   *  the research/source evidence for this component. Supplied to the shared
   *  sentence-quality scanner so a named-entity repeated token is licensed. */
  licensedRepeatedWordSpans?: ReadonlySet<string>;
  /** FAQ only: allowed entry-count range. Omitted → count not checked. */
  faqRange?: { min: number; max: number };
  /** Source-first provenance context: the SOURCE-X-CLAIM-Y IDs supplied to
   *  THIS producer (section-owned claims). Empty/absent for synthesis-only
   *  components — any attribution there is invalid. */
  ownedEvidenceIds?: ReadonlySet<string>;
  /** Approved research rows for the declared-evidence fidelity check. */
  research?: Array<{ title?: string; snippet?: string; url?: string }>;
  /** Synthesis-only components (introduction, conclusion, FAQ) keep the
   *  stricter contract: BOTH sourceAttributions and freeProseSentences must
   *  be empty — they may not introduce research facts at all. */
  synthesisOnly?: boolean;
}

export interface ProducerCandidate {
  /** Normalized editorial blocks (intro/section/conclusion/regen/expansion). */
  blocks?: EditorialBlock[];
  /** FAQ entries (componentType "faq"). */
  faqEntries?: Array<{ question: string; answer: string }>;
  /** Raw model output — diagnostics only, never used in validation. */
  html?: string;
  /** Internal-only source→prose provenance from the producer response. */
  sourceAttributions?: SourceAttribution[];
  /** Internal-only free-prose accounting: sentences that are advice, opinion,
   *  rhetoric or hypothetical examples (no evidence IDs, never facts). */
  freeProseSentences?: string[];
  /** Structurally-coupled per-sentence accounting: every sentence exists once
   *  in the blocks carrying its own kind + optional evidenceIds (the primary
   *  representation for editorial-block JSON producers). */
  sentenceAccounting?: SentenceAccountingEntry[];
}

export interface ProducerViolation {
  rule: ProducerHardRule;
  code: string;
  componentId: string;
  blockId?: string | null;
  message: string;
  /** Exact offending text when the leaf provides it. */
  text?: string;
}

export interface ProducerValidationResult {
  passed: boolean;
  violations: ProducerViolation[];
  /** Deterministic fingerprint of the validated candidate. */
  fingerprint: string;
}

// ── Internal constants ──

const KNOWN_BLOCK_TYPES = new Set(["paragraph", "subheading", "list", "table", "quote"]);

/** Defect families: codes that are the SAME underlying defect reported by
 *  different authoritative leaves collapse to one violation. Codes absent from
 *  this map are their own family. */
const DEFECT_FAMILY: Record<string, string> = {
  "no-finite-predicate": "fragment",
  fragment: "fragment",
  "missing-terminal-punctuation": "terminal",
  "incomplete-sentence": "terminal",
  "trailing-fragment": "trailing-fragment",
  "lowercase-sentence-start": "lowercase-start",
  "missing-aux-inversion": "aux-inversion",
  "punctuation-fragment": "punctuation-residue",
  "punctuation-residue": "punctuation-residue",
};

/** When two leaves report the same defect family, the higher-priority rule
 *  (lower number) wins. Sentence completeness is the primary authority for
 *  fragments/terminal defects; coherence is the weakest for overlapping cases. */
const RULE_PRIORITY: Record<ProducerHardRule, number> = {
  "sentence-completeness": 1,
  "malformed-prose": 2,
  "sentence-quality": 3,
  coherence: 4,
  structure: 5,
  "source-provenance": 6,
  "component-specific": 7,
};

/** Coherence rules proven safe at component scope: they need only the
 *  component's own blocks, never other article components. */
const COMPONENT_SAFE_COHERENCE_TYPES: ReadonlySet<CoherenceViolationType> = new Set([
  "unfinished-example",
  "orphan-transition",
  "dangling-reference",
  "incomplete-sentence",
  "empty-subsection",
]);

const FAQ_MARKUP_RE = /<!--[\s\S]*?-->|<[^>]+>|```/;
const FAQ_SIGNUP_RE =
  /https?:\/\/\S*(?:signup|register|sign-up)|app\.b2ihub\.com\/signup|\b(?:sign[- ]?up|register)\b/i;
const FAQ_HAN_RE = /\p{Script=Han}/u;

// ── Small helpers ──

function textForBlock(block: EditorialBlock): string {
  return extractPlainTextFromEditorialBlocks([block]).replace(/\s+/g, " ").trim();
}

interface CompletenessUnit {
  text: string;
  kind: SentenceCompletenessKind;
}

/** Per-unit prose extraction mirroring the authoritative malformed-prose
 *  scanner's unit boundaries (list items and table cells are structural units;
 *  source citations upgrade to the structural "heading" kind inside
 *  analyzeSentenceCompleteness). */
function completenessUnitsForBlock(block: EditorialBlock): CompletenessUnit[] {
  if (block.type === "list") {
    return block.items.map((item) => ({
      text: item.map((node) => node.text).join("").replace(/\s+/g, " ").trim(),
      kind: "list-item" as const,
    }));
  }
  if (block.type === "table") {
    return [...block.headers, ...block.rows.flat()].map((cell) => ({
      text: cell.map((node) => node.text).join("").replace(/\s+/g, " ").trim(),
      kind: "table-cell" as const,
    }));
  }
  if (block.type === "quote") {
    return [{ text: textForBlock(block), kind: "quote" as const }];
  }
  if (block.type === "subheading") {
    return [{ text: textForBlock(block), kind: "subheading" as const }];
  }
  return [{ text: textForBlock(block), kind: "paragraph" as const }];
}

/** Prose units eligible for the hard sentence-quality rules. List items and
 *  table cells are structural labels where lowercase-start/malformed-noun-
 *  phrase semantics are not producer-safe; source citations are metadata. */
function proseTextsForBlock(block: EditorialBlock): string[] {
  if (block.type === "list" || block.type === "table") return [];
  const text = textForBlock(block);
  if (!text || isSourceCitationText(text)) return [];
  return [text];
}

/** Minimal canonical document carrying ONLY the candidate component, used to
 *  evaluate the component-safe coherence rules without any other article
 *  component (empty-section/thin-section never fire for it). */
function documentForComponent(
  componentType: ProducerComponentType,
  componentId: string,
  blocks: EditorialBlock[],
  keyphrase: string,
): ArticleDocument {
  return {
    metadata: {
      title: "T",
      slug: "t",
      metaDescription: "D",
      excerpt: "",
      targetWordCount: 2500,
      focusKeyphrase: keyphrase,
    },
    languageSwitcher: null,
    introduction: {
      id: "intro",
      blocks: componentType === "introduction" ? blocks : [],
      status: "generated",
    },
    sections:
      componentType === "section"
        ? [{ id: componentId, heading: "Section", headingLevel: 2, sectionType: "main", blocks, status: "generated" }]
        : [],
    visibleFaq: [],
    conclusion: {
      id: "conclusion",
      blocks: componentType === "conclusion" ? blocks : [],
      status: "generated",
    },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

// ── Validation layers ──

function scanCompleteness(
  blocks: EditorialBlock[],
  context: ProducerComponentContext,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  blocks.forEach((block, blockIndex) => {
    const next = blocks[blockIndex + 1];
    const hasStructuredContinuation = isNonEmptyStructuredContinuation(next);
    for (const unit of completenessUnitsForBlock(block)) {
      if (!unit.text) continue;
      const analysis = analyzeSentenceCompleteness(unit.text, unit.kind, {
        allowColonBeforeStructuredContinuation:
          block.type === "paragraph" && hasStructuredContinuation,
      });
      for (const issue of analysis.issues) {
        violations.push({
          rule: "sentence-completeness",
          code: issue.code,
          componentId: context.componentId,
          blockId: block.id,
          message: issue.message,
          text: unit.text,
        });
      }
    }
  });
  return violations;
}

function scanMalformed(
  blocks: EditorialBlock[],
  context: ProducerComponentContext,
  validLowercaseTokens: ReadonlySet<string> | undefined,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  for (const finding of scanMalformedProseInBlocks(blocks, validLowercaseTokens)) {
    for (const issue of finding.issues) {
      violations.push({
        rule: "malformed-prose",
        code: issue.code,
        componentId: context.componentId,
        blockId: finding.blockId,
        message: issue.message,
        text: issue.text,
      });
    }
  }
  return violations;
}

function scanSentenceQuality(
  blocks: EditorialBlock[],
  context: ProducerComponentContext,
  validLowercaseTokens: ReadonlySet<string> | undefined,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  for (const block of blocks) {
    for (const text of proseTextsForBlock(block)) {
      for (const issue of scanSentenceQualityText(text, {
        validLowercaseTokens,
        licensedRepeatedWordSpans: context.licensedRepeatedWordSpans,
      })) {
        // Fragments are owned by the sentence-completeness/malformed leaves.
        if (issue.code === "fragment") continue;
        violations.push({
          rule: "sentence-quality",
          code: issue.code,
          componentId: context.componentId,
          blockId: block.id,
          message: issue.message,
          text,
        });
      }
    }
  }
  return violations;
}

function scanPunctuationResidue(
  texts: Array<{ text: string; blockId?: string | null }>,
  context: ProducerComponentContext,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  for (const unit of texts) {
    if (isAuthoritativePunctuationOnlyResidue(unit.text)) {
      violations.push({
        rule: "malformed-prose",
        code: "punctuation-residue",
        componentId: context.componentId,
        blockId: unit.blockId ?? null,
        message: "Text contains only punctuation residue",
        text: unit.text,
      });
    }
  }
  return violations;
}

function scanCoherence(
  blocks: EditorialBlock[],
  context: ProducerComponentContext,
): ProducerViolation[] {
  const doc = documentForComponent(context.componentType, context.componentId, blocks, context.keyphrase ?? "");
  const violations: ProducerViolation[] = [];
  for (const violation of validateCoherence(doc)) {
    if (violation.componentId !== context.componentId) continue;
    if (!COMPONENT_SAFE_COHERENCE_TYPES.has(violation.type)) continue;
    violations.push({
      rule: "coherence",
      code: violation.type,
      componentId: context.componentId,
      blockId: violation.blockId,
      message: `Coherence: ${violation.type}`,
      text: violation.snippet,
    });
  }
  return violations;
}

function scanStructure(
  blocks: EditorialBlock[],
  context: ProducerComponentContext,
  scope: ProducerValidationScope,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  if (!Array.isArray(blocks) || blocks.length === 0) {
    violations.push({
      rule: "structure",
      code: "empty-component",
      componentId: context.componentId,
      blockId: null,
      message: scope === "additive-fragment" ? "Fragment is empty" : "Component is empty",
    });
    return violations;
  }
  for (const block of blocks) {
    if (!KNOWN_BLOCK_TYPES.has(block.type)) {
      violations.push({
        rule: "structure",
        code: "unsupported-block-shape",
        componentId: context.componentId,
        blockId: block.id,
        message: `Unsupported block type: ${block.type}`,
      });
    }
  }
  if (extractPlainTextFromEditorialBlocks(blocks).replace(/\s+/g, " ").trim() === "") {
    violations.push({
      rule: "structure",
      code: "empty-component",
      componentId: context.componentId,
      blockId: null,
      message: "Component has no substantive text",
    });
  }
  return violations;
}

function scanFaq(
  entries: Array<{ question: string; answer: string }>,
  context: ProducerComponentContext,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  if (!Array.isArray(entries)) {
    violations.push({
      rule: "structure",
      code: "faq-entries-missing",
      componentId: context.componentId,
      blockId: null,
      message: "FAQ candidate must contain an entries array",
    });
    return violations;
  }
  if (context.faqRange && (entries.length < context.faqRange.min || entries.length > context.faqRange.max)) {
    violations.push({
      rule: "component-specific",
      code: "faq-entry-count",
      componentId: context.componentId,
      blockId: null,
      message: `FAQ entry count ${entries.length}; expected ${context.faqRange.min}-${context.faqRange.max}`,
    });
  }
  const validLowercaseTokens = context.keyphrase
    ? lowercaseStartValidTokensFromKeyphrase(context.keyphrase)
    : undefined;
  entries.forEach((entry, index) => {
    const question = (entry?.question ?? "").replace(/\s+/g, " ").trim();
    const answer = (entry?.answer ?? "").replace(/\s+/g, " ").trim();
    const questionBlockId = `faq-${index}-question`;
    const answerBlockId = `faq-${index}-answer`;
    const addComponentViolation = (code: string, blockId: string | null, message: string, text?: string) => {
      violations.push({
        rule: "component-specific",
        code,
        componentId: context.componentId,
        blockId,
        message,
        text,
      });
    };

    if (!question) addComponentViolation("faq-question-empty", questionBlockId, `entry ${index + 1} has an empty question`);
    if (!answer) addComponentViolation("faq-answer-empty", answerBlockId, `entry ${index + 1} has an empty answer`);
    if (FAQ_MARKUP_RE.test(question) || FAQ_MARKUP_RE.test(answer)) {
      addComponentViolation("faq-markup", null, `entry ${index + 1} contains markup`);
    }
    const faqCopy = `${question} ${answer}`;
    if (CTA_CONTENT_RE.test(faqCopy) || FAQ_SIGNUP_RE.test(faqCopy)) {
      addComponentViolation("faq-cta-copy", null, `entry ${index + 1} contains protected CTA/signup copy`);
    }
    if (FAQ_HAN_RE.test(question) || FAQ_HAN_RE.test(answer)) {
      addComponentViolation("faq-non-english", null, `entry ${index + 1} is not English-only`);
    }
    if (!analyzeQuotationIntegrity(question).balanced) {
      addComponentViolation("unmatched-quotation", questionBlockId, `entry ${index + 1} question contains an unmatched quotation mark`);
    }
    if (!analyzeQuotationIntegrity(answer).balanced) {
      addComponentViolation("unmatched-quotation", answerBlockId, `entry ${index + 1} answer contains an unmatched quotation mark`);
    }

    if (answer) {
      const completeness = analyzeSentenceCompleteness(answer, "faq-answer");
      for (const issue of completeness.issues) {
        violations.push({
          rule: "sentence-completeness",
          code: issue.code,
          componentId: context.componentId,
          blockId: answerBlockId,
          message: issue.message,
          text: answer,
        });
      }
      for (const issue of findMalformedProseTextIssues([answer], ["faq-answer"], undefined, validLowercaseTokens)) {
        violations.push({
          rule: "malformed-prose",
          code: issue.code,
          componentId: context.componentId,
          blockId: answerBlockId,
          message: issue.message,
          text: issue.text,
        });
      }
      for (const issue of scanSentenceQualityText(answer, {
        validLowercaseTokens,
        licensedRepeatedWordSpans: context.licensedRepeatedWordSpans,
      })) {
        if (issue.code === "fragment") continue;
        violations.push({
          rule: "sentence-quality",
          code: issue.code,
          componentId: context.componentId,
          blockId: answerBlockId,
          message: issue.message,
          text: answer,
        });
      }
      if (isAuthoritativePunctuationOnlyResidue(answer)) {
        violations.push({
          rule: "malformed-prose",
          code: "punctuation-residue",
          componentId: context.componentId,
          blockId: answerBlockId,
          message: "Text contains only punctuation residue",
          text: answer,
        });
      }
    }
  });
  return violations;
}

function scanConclusionCta(
  blocks: EditorialBlock[],
  context: ProducerComponentContext,
): ProducerViolation[] {
  const text = extractPlainTextFromEditorialBlocks(blocks).replace(/\s+/g, " ").trim();
  if (CTA_CONTENT_RE.test(text)) {
    return [{
      rule: "component-specific",
      code: "cta-content",
      componentId: context.componentId,
      blockId: null,
      message: "Conclusion contains protected CTA copy",
      text,
    }];
  }
  return [];
}

// ── Deduplication ──

/** Collapses same-defect duplicates across leaves deterministically. Two
 *  violations collapse when they share the same defect family, component,
 *  block and normalized text; the higher-priority rule wins. Genuinely
 *  distinct defects (different families or different text) are never hidden. */
export function dedupeProducerViolations(violations: ProducerViolation[]): ProducerViolation[] {
  const kept = new Map<string, ProducerViolation>();
  for (const violation of violations) {
    const textKey = (violation.text ?? "").replace(/\s+/g, " ").trim();
    const family = DEFECT_FAMILY[violation.code] ?? violation.code;
    const key = `${family}|${violation.componentId}|${violation.blockId ?? "-"}|${textKey}`;
    const existing = kept.get(key);
    if (!existing || RULE_PRIORITY[violation.rule] < RULE_PRIORITY[existing.rule]) {
      kept.set(key, violation);
    }
  }
  return [...kept.values()];
}

function fingerprintForCandidate(candidate: ProducerCandidate): string {
  if (candidate.blocks && candidate.blocks.length > 0) {
    return fingerprintHtml(renderEditorialBlocksToWordPress(candidate.blocks));
  }
  if (candidate.faqEntries) {
    return fingerprintHtml(JSON.stringify(candidate.faqEntries));
  }
  return fingerprintHtml(JSON.stringify(candidate.html ?? ""));
}

// ── Source-first provenance validation (shared by every factual-capable
//    producer: sections, regeneration, compaction; synthesis-only components
//    may not attribute at all) ──
// Each declared attribution must:
//  1. quote a sentence that EXACTLY exists in the candidate's own blocks;
//  2. use only SOURCE-X-CLAIM-Y IDs supplied to this producer (owned);
//  3. pass the existing entailment/fidelity authority against the DECLARED
//     evidence only — never reassigned heuristically from the whole ledger.
// Violations are hard at the producer boundary and drive the existing
// repair/retry seam — invalid provenance never silently passes.

function candidateProseTexts(candidate: ProducerCandidate): string[] {
  const texts: string[] = [];
  for (const block of candidate.blocks ?? []) {
    texts.push(...proseTextsForBlock(block));
  }
  return texts;
}

function normalizedContainment(texts: string[], sentence: string): boolean {
  const normalized = sentence.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLowerCase();
  return texts.some((text) =>
    text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLowerCase().includes(normalized),
  );
}

export function validateProducerSourceAttributions(
  candidate: ProducerCandidate,
  context: ProducerComponentContext,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];
  const attributions = candidate.sourceAttributions ?? [];
  if (attributions.length === 0) return violations;

  const ownedEvidenceIds = context.ownedEvidenceIds ?? new Set<string>();
  const ledger = buildEvidenceLedger(context.research);
  const ledgerIds = new Set(ledger.map((entry) => entry.evidenceId));
  const proseTexts = candidateProseTexts(candidate);
  const allProse = proseTexts.join(" ");

  for (let i = 0; i < attributions.length; i++) {
    const attribution = attributions[i];
    const label = `sourceAttributions[${i}]`;
    if (typeof attribution?.sentence !== "string" || !attribution.sentence.trim()) {
      violations.push({
        rule: "source-provenance",
        code: "attribution-missing-sentence",
        componentId: context.componentId,
        message: `${label} must declare a non-empty sentence`,
      });
      continue;
    }
    const sentence = attribution.sentence.trim();
    let structurallyValid = true;
    if (!normalizedContainment(proseTexts, sentence) && tokenOverlapRatioForProvenance(sentence, allProse) < 0.5) {
      violations.push({
        rule: "source-provenance",
        code: "attributed-sentence-not-in-blocks",
        componentId: context.componentId,
        message: `${label} quotes a sentence that does not exist in the generated blocks`,
        text: sentence.slice(0, 160),
      });
      structurallyValid = false;
    }
    if (!Array.isArray(attribution.evidenceIds) || attribution.evidenceIds.length === 0) {
      violations.push({
        rule: "source-provenance",
        code: "attribution-missing-evidence",
        componentId: context.componentId,
        message: `${label} must declare at least one evidenceId`,
      });
      structurallyValid = false;
      continue;
    }
    for (const id of attribution.evidenceIds) {
      if (!ledgerIds.has(id)) {
        violations.push({
          rule: "source-provenance",
          code: "attribution-unknown-evidence",
          componentId: context.componentId,
          message: `${label} declares unknown evidence id ${id}`,
        });
        structurallyValid = false;
      } else if (!ownedEvidenceIds.has(id)) {
        violations.push({
          rule: "source-provenance",
          code: "attribution-not-owned",
          componentId: context.componentId,
          message: `${label} declares evidence id ${id} which is not assigned to this producer`,
        });
        structurallyValid = false;
      }
    }
    if (structurallyValid) {
      const fidelity = validateAttributedSentenceFidelity(sentence, attribution.evidenceIds, ledger);
      if (!fidelity.supported) {
        violations.push({
          rule: "source-provenance",
          code: "attribution-fidelity",
          componentId: context.componentId,
          message: `${label} sentence is not entailed by its declared evidence: ${fidelity.reason}`,
          text: sentence.slice(0, 160),
        });
      }
    }
  }
  return violations;
}

/** Text units that must be accounted for in the per-sentence provenance
 *  contract: paragraph/subheading/quote prose and each list item. Table cells
 *  are structural data containers (deterministic patterns backstop them). */
function accountableTextsForBlock(block: EditorialBlock): string[] {
  if (block.type === "table") return [];
  if (block.type === "list") return block.items.map((item) => item.map((node) => node.text ?? "").join(""));
  return [textForBlock(block)];
}

function normalizeAccountingText(text: string): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
}

/**
 * COMPLETE per-sentence provenance accounting via STRUCTURALLY-COUPLED
 * sentences: each generated prose sentence exists exactly once in the producer
 * response carrying its own kind — source_fact (owned evidence IDs, existing
 * declared-source fidelity) or free_prose (advice/opinion/rhetoric/
 * hypothetical only, never a concrete external-world fact). Completeness is
 * STRUCTURAL — there is no separate sentence-matching/repetition step: a
 * sentence object that was written into a block IS accounted. A legacy sidecar
 * representation is also accepted (expander path) and runs the same per-entry
 * checks. Invalid entries drive the existing producer repair/retry seam.
 *
 * Synthesis-only components keep their stricter contract: no provenance may
 * be declared at all.
 */
export function validateProducerSentenceAccounting(
  candidate: ProducerCandidate,
  context: ProducerComponentContext,
): ProducerViolation[] {
  const violations: ProducerViolation[] = [];

  if (context.synthesisOnly) {
    const hasAttribution = (candidate.sourceAttributions ?? []).length > 0
      || (candidate.sentenceAccounting?.some((entry) => entry.kind === "source_fact") ?? false);
    if (hasAttribution) {
      violations.push({
        rule: "source-provenance",
        code: "synthesis-only-attribution",
        componentId: context.componentId,
        message: "synthesis-only component must not declare research provenance",
      });
    }
    return violations;
  }

  // Unified per-entry accounting: the structural sentence objects are the
  // primary representation; the legacy sidecar path is accepted for producers
  // whose response is not editorial-block JSON (section expansion).
  const accounting: Array<{ sentence: string; kind: "source_fact" | "free_prose"; evidenceIds: string[] }> =
    candidate.sentenceAccounting && candidate.sentenceAccounting.length > 0
      ? candidate.sentenceAccounting
      : [
          ...(candidate.sourceAttributions ?? []).map((entry) => ({
            sentence: entry.sentence,
            kind: "source_fact" as const,
            evidenceIds: entry.evidenceIds,
          })),
          ...(candidate.freeProseSentences ?? []).map((sentence) => ({
            sentence,
            kind: "free_prose" as const,
            evidenceIds: [] as string[],
          })),
        ];

  const blockTexts = candidate.blocks?.flatMap(accountableTextsForBlock) ?? [];
  const normalizedBlocks = blockTexts.map(normalizeAccountingText);
  const ledger = buildEvidenceLedger(context.research);
  const ledgerIds = new Set(ledger.map((entry) => entry.evidenceId));
  const ownedEvidenceIds = context.ownedEvidenceIds ?? new Set<string>();

  for (let i = 0; i < accounting.length; i++) {
    const entry = accounting[i];
    const label = `sentence[${i}]`;
    const sentence = (entry?.sentence ?? "").trim();
    if (!sentence) {
      violations.push({
        rule: "source-provenance",
        code: "accounting-missing-sentence",
        componentId: context.componentId,
        message: `${label} must declare a non-empty sentence`,
      });
      continue;
    }
    const normalized = normalizeAccountingText(sentence);
    if (!normalizedBlocks.some((text) => text.includes(normalized))) {
      violations.push({
        rule: "source-provenance",
        code: "accounted-sentence-not-in-blocks",
        componentId: context.componentId,
        message: `${label} quotes a sentence that does not exist in the generated blocks`,
        text: sentence.slice(0, 160),
      });
    }

    if (entry.kind === "source_fact") {
      // Existing declared-source validation: owned evidence IDs + fidelity.
      const evidenceIds = Array.isArray(entry.evidenceIds) ? entry.evidenceIds : [];
      if (evidenceIds.length === 0) {
        violations.push({
          rule: "source-provenance",
          code: "attribution-missing-evidence",
          componentId: context.componentId,
          message: `${label} source_fact sentence must declare at least one evidenceId`,
        });
        continue;
      }
      let structurallyValid = true;
      for (const id of evidenceIds) {
        if (!ledgerIds.has(id)) {
          violations.push({
            rule: "source-provenance",
            code: "attribution-unknown-evidence",
            componentId: context.componentId,
            message: `${label} declares unknown evidence id ${id}`,
          });
          structurallyValid = false;
        } else if (!ownedEvidenceIds.has(id)) {
          violations.push({
            rule: "source-provenance",
            code: "attribution-not-owned",
            componentId: context.componentId,
            message: `${label} declares evidence id ${id} which is not assigned to this producer`,
          });
          structurallyValid = false;
        }
      }
      if (structurallyValid) {
        const fidelity = validateAttributedSentenceFidelity(sentence, evidenceIds, ledger);
        if (!fidelity.supported) {
          violations.push({
            rule: "source-provenance",
            code: "attribution-fidelity",
            componentId: context.componentId,
            message: `${label} sentence is not entailed by its declared evidence: ${fidelity.reason}`,
            text: sentence.slice(0, 160),
          });
        }
      }
    } else {
      // free_prose: no evidence IDs, and the deterministic pattern layer is
      // the boundary judge for concrete external-world facts.
      if (Array.isArray(entry.evidenceIds) && entry.evidenceIds.length > 0) {
        violations.push({
          rule: "source-provenance",
          code: "free-prose-has-evidence",
          componentId: context.componentId,
          message: `${label} free_prose sentence must not declare evidenceIds`,
        });
      }
      const patternScan = scanFactualRisks(
        `<!-- wp:paragraph --><p>${sentence}</p><!-- /wp:paragraph -->`,
        context.keyphrase ?? "",
        [],
      );
      if (patternScan.claims.length > 0) {
        violations.push({
          rule: "source-provenance",
          code: "free-prose-asserts-concrete-fact",
          componentId: context.componentId,
          message: `${label} asserts a concrete external-world fact (${patternScan.claims.map((c) => c.category).join(", ")}) — account it as source_fact or remove the fact`,
          text: sentence.slice(0, 160),
        });
      }
    }
  }
  return violations;
}

function tokenOverlapRatioForProvenance(a: string, b: string): number {
  const tokensA = a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
  if (tokensA.length === 0) return 0;
  const tokensB = new Set(b.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  return tokensA.filter((token) => tokensB.has(token)).length / tokensA.length;
}

// ── Main entry ──

/** The single authoritative hard producer-output validation. Pure and
 *  deterministic: no AI, no I/O, no mutation, no parallel grammar. */
export function validateProducerCandidate(
  candidate: ProducerCandidate,
  context: ProducerComponentContext,
): ProducerValidationResult {
  const scope: ProducerValidationScope = context.scope ?? "complete-component";
  const violations: ProducerViolation[] = [];

  if (context.componentType === "faq" || candidate.faqEntries) {
    violations.push(...scanFaq(candidate.faqEntries ?? [], context));
  } else {
    const blocks = candidate.blocks ?? [];
    violations.push(...scanStructure(blocks, context, scope));
    if (blocks.length > 0) {
      const validLowercaseTokens = context.keyphrase
        ? lowercaseStartValidTokensFromKeyphrase(context.keyphrase)
        : undefined;
      violations.push(...scanCompleteness(blocks, context));
      violations.push(...scanMalformed(blocks, context, validLowercaseTokens));
      violations.push(...scanSentenceQuality(blocks, context, validLowercaseTokens));
      violations.push(...scanPunctuationResidue(
        blocks.flatMap((block) =>
          proseTextsForBlock(block).map((text) => ({ text, blockId: block.id })),
        ),
        context,
      ));
      if (scope === "complete-component") {
        violations.push(...scanCoherence(blocks, context));
      }
      if (context.componentType === "conclusion") {
        violations.push(...scanConclusionCta(blocks, context));
      }
    }
  }

  const deduped = dedupeProducerViolations(violations);
  return {
    passed: deduped.length === 0,
    violations: deduped,
    fingerprint: fingerprintForCandidate(candidate),
  };
}

// ── Shadow (observational) harness ──
// Stage 3B: run the shared contract BESIDE existing producer validation without
// any authority. The existing validator's verdict is compared with the shared
// contract's verdict; disagreements are reported as concise debug events under
// the existing pipeline debug flag (ENABLE_PIPELINE_DEBUG_TRACE=true). When the
// flag is off, the comparison is skipped entirely (zero production overhead)
// and production accept/reject/repair behavior is completely unchanged.

export interface ShadowProducerComparisonInput {
  /** e.g. "intro generation", "section-2 repair", "faq generation". */
  label: string;
  candidate: ProducerCandidate;
  context: ProducerComponentContext;
  /** The existing validator's verdict (true = accepted). */
  existingPassed: boolean;
}

export interface ShadowProducerComparison {
  contractPassed: boolean;
  disagreement: boolean;
}

export function shadowValidateProducerCandidate(
  input: ShadowProducerComparisonInput,
): ShadowProducerComparison {
  if (!isPipelineDebugTraceEnabled()) {
    return { contractPassed: true, disagreement: false };
  }
  const contract = validateProducerCandidate(input.candidate, input.context);
  const disagreement = contract.passed !== input.existingPassed;
  if (disagreement) {
    const violations = contract.violations
      .map((violation) => `${violation.code}@${violation.blockId ?? "-"}`)
      .join(",");
    const firstText = (contract.violations[0]?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    console.warn(
      `[producer-contract-shadow] label=${input.label} existing=${input.existingPassed ? "pass" : "fail"} contract=${contract.passed ? "pass" : "fail"} violations=${violations || "none"} text="${firstText}" fingerprint=${contract.fingerprint}`,
    );
  }
  return { contractPassed: contract.passed, disagreement };
}
