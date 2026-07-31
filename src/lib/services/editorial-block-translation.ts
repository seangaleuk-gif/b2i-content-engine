import { type EditorialBlock, type InlineContent, parseWordPressEditorialBlocks, renderEditorialBlocksToWordPress, validateEditorialBlocks } from "@/lib/blog/article-content";
import { checkCompleteness, checkLinksPreserved, checkNumbersPreserved } from "./translation-validator";
import { protectNumbersInEditorialBlocks, restoreNumbersInEditorialBlocks, checkBlockNumbersPreserved, checkBlockLinksPreserved, extractNumbersFromEditorialBlocks, extractLinksFromEditorialBlocks, type NumberProtectionState } from "./editorial-block-protection";
import { serializeTranslationPayload, extractTranslationJson, normalizeTranslationPayload, reconstructEditorialBlocks, validateConclusionPolicy, type TranslationComponentPayload, type TranslationLinkMap } from "./translation-dto";

export interface ValidationParity {
  numbersMatch: boolean;
  linksMatch: boolean;
  diagnostics: string[];
}

export interface TranslateEditorialBlocksOptions {
  blocks: EditorialBlock[];
  componentId: string;
  componentKind: "introduction" | "section" | "conclusion";
  context?: Record<string, unknown>;
  translateProtectedHtml: (protectedHtml: string) => Promise<string>;
  repairProtectedHtml?: (protectedHtml: string, error: string) => Promise<string | null>;
  onStatus?: (status: { passed: boolean; metrics: { sourceChars: number; translatedChars: number; ratio: number; sourceNumbers: number; translatedNumbers: number; numbersMatch: number } }) => void;
}

export interface TranslateEditorialBlocksResult {
  blocks: EditorialBlock[];
  translatedHtml: string;
  passed: boolean;
  metrics: {
    sourceChars: number;
    translatedChars: number;
    ratio: number;
    sourceNumbers: number;
    translatedNumbers: number;
    numbersMatch: number;
  };
  validationParity?: ValidationParity;
}

export class EditorialBlockTranslationError extends Error {
  constructor(
    message: string,
    public readonly componentId: string,
  ) {
    super(message);
    this.name = "EditorialBlockTranslationError";
  }
}

// ── Placeholder integrity ──
// Validated against parsed EditorialBlock[] inline content (authoritative).

interface PlaceholderIntegrity {
  ok: boolean;
  errors: string[];
}

export function extractAllTextFromInlineContent(blocks: EditorialBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "subheading":
      case "quote":
        for (const node of block.content) parts.push(node.text);
        break;
      case "list":
        for (const item of block.items) {
          for (const node of item) parts.push(node.text);
        }
        break;
      case "table":
        for (const row of [block.headers, ...block.rows]) {
          for (const cell of row) {
            for (const node of cell) parts.push(node.text);
          }
        }
        break;
    }
  }
  return parts.join(" ");
}

export function checkPlaceholderIntegrity(
  translatedBlocks: EditorialBlock[],
  state: NumberProtectionState,
): PlaceholderIntegrity {
  const errors: string[] = [];
  const allText = extractAllTextFromInlineContent(translatedBlocks);
  const expectedPlaceholders = new Set(state.placeholders);

  // Check each expected placeholder in parsed inline text
  for (const ph of state.placeholders) {
    const escaped = ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = (allText.match(new RegExp(escaped, "g")) || []).length;
    if (count === 0) {
      errors.push(`missing placeholder: ${ph}`);
    } else if (count > 1) {
      errors.push(`duplicated placeholder: ${ph} appears ${count} times`);
    }
  }

  // Check for unknown placeholders in parsed inline text
  const unknownPhs = allText.match(/__NUM_\d+__/g) || [];
  for (const ph of unknownPhs) {
    if (!expectedPlaceholders.has(ph)) {
      errors.push(`unknown placeholder: ${ph}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function checkNoPlaceholdersRemain(blocks: EditorialBlock[]): string[] {
  const text = extractAllTextFromInlineContent(blocks);
  const found = text.match(/__NUM_\d+__/g);
  return found || [];
}


function inlineShape(content: InlineContent[]): string {
  return content.map((node) => node.type === "link" ? `link:${node.href}` : node.type).join(",");
}

/**
 * Translation may change text only. Block order, block kinds, list/table
 * dimensions and inline formatting/link positions remain canonical.
 */
export function editorialStructureSignature(blocks: EditorialBlock[]): string[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "paragraph":
      case "quote":
        return `${block.type}[${inlineShape(block.content)}]`;
      case "subheading":
        return `${block.type}:${block.level}[${inlineShape(block.content)}]`;
      case "list":
        return `${block.type}:${block.ordered}:${block.items.length}[${block.items.map(inlineShape).join("|")}]`;
      case "table":
        return `${block.type}:${block.headers.length}:${block.rows.length}[h:${block.headers.map(inlineShape).join("|")};r:${block.rows.map((row) => row.map(inlineShape).join("|")).join(";")}]`;
    }
  });
}

function sameStringSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ── Candidate evaluation (shared for initial and repaired candidates) ──
// Parse → validate placeholders → restore → block validate → structured number/link (authoritative) → HTML shadow

interface CandidateEvaluation {
  blocks: EditorialBlock[];
  translatedHtml: string;
  passed: boolean;
  failReason: string;
  shadow: {
    htmlNumbersMatch: boolean;
    htmlLinksMatch: boolean;
  };
}

function evaluateCandidate(
  sourceBlocks: EditorialBlock[],
  candidateHtml: string,
  componentId: string,
  protectionState: NumberProtectionState,
  sourceHtml: string,
): CandidateEvaluation {
  // 1. Parse the translated HTML into protected blocks
  const parsed = parseWordPressEditorialBlocks(candidateHtml, componentId);
  if (parsed.errors.length > 0) {
    throw new EditorialBlockTranslationError(
      `Failed to parse translated HTML for ${componentId}: ${parsed.errors.join("; ")}`,
      componentId,
    );
  }

  const translatedProtectedBlocks = parsed.blocks;

  // 2. Validate placeholder integrity in parsed editorial blocks
  const integrity = checkPlaceholderIntegrity(translatedProtectedBlocks, protectionState);
  if (!integrity.ok) {
    return {
      blocks: translatedProtectedBlocks, translatedHtml: candidateHtml, passed: false,
      failReason: `placeholder integrity: ${integrity.errors.join("; ")}`,
      shadow: { htmlNumbersMatch: false, htmlLinksMatch: false },
    };
  }

  // 3. Restore numbers in blocks
  const translatedBlocks = restoreNumbersInEditorialBlocks(translatedProtectedBlocks, protectionState);

  // Confirm no placeholders remain after restoration
  const remaining = checkNoPlaceholdersRemain(translatedBlocks);
  if (remaining.length > 0) {
    return {
      blocks: translatedBlocks, translatedHtml: candidateHtml, passed: false,
      failReason: `placeholders remain after restoration: ${remaining.join(", ")}`,
      shadow: { htmlNumbersMatch: false, htmlLinksMatch: false },
    };
  }

  // 4. Canonical structure and content validation (AUTHORITATIVE)
  const structureMatch = sameStringSequence(
    editorialStructureSignature(sourceBlocks),
    editorialStructureSignature(translatedBlocks),
  );
  const blockValidationErrors = validateEditorialBlocks(translatedBlocks);

  // 5. Structured number/link validation (AUTHORITATIVE)
  const blockNumCheck = checkBlockNumbersPreserved(sourceBlocks, translatedBlocks);
  const sourceLinks = extractLinksFromEditorialBlocks(sourceBlocks);
  const translatedLinks = extractLinksFromEditorialBlocks(translatedBlocks);
  const blockLinksLost = checkBlockLinksPreserved(sourceBlocks, translatedBlocks);
  const numbersMatch = blockNumCheck.lost.length === 0 && blockNumCheck.extras.length === 0;
  const linksMatch = sameStringSequence(sourceLinks, translatedLinks);

  // Render restored blocks once for completeness and the final result.
  const translatedHtml = renderEditorialBlocksToWordPress(translatedBlocks);
  const completeness = checkCompleteness(sourceHtml, translatedHtml, componentId);

  // 6. HTML shadow validation (diagnostic only, on restored content)
  const shadow = runHtmlShadow(sourceBlocks, translatedBlocks);

  // 7. Build fail reason
  const failParts: string[] = [];
  if (!structureMatch) {
    failParts.push("editorial block or inline structure changed");
  }
  if (blockValidationErrors.length > 0) {
    failParts.push(`invalid editorial blocks: ${blockValidationErrors.join("; ")}`);
  }
  if (!completeness.passed) {
    failParts.push(`translation incomplete or contains excessive English (ratio=${completeness.ratio.toFixed(2)})`);
  }
  if (!numbersMatch) {
    const details: string[] = [];
    if (blockNumCheck.lost.length > 0) details.push(`lost: ${blockNumCheck.lost.join(", ")}`);
    if (blockNumCheck.extras.length > 0) details.push(`extra: ${blockNumCheck.extras.join(", ")}`);
    failParts.push(`number mismatch (${details.join("; ")})`);
  }
  if (!linksMatch) {
    const extraLinks = translatedLinks.filter((link, index) => sourceLinks[index] !== link);
    failParts.push(`URL sequence changed${blockLinksLost.length > 0 ? `; lost: ${blockLinksLost.join(", ")}` : ""}${extraLinks.length > 0 ? `; changed/extra: ${extraLinks.join(", ")}` : ""}`);
  }

  const passed = failParts.length === 0;

  return {
    blocks: translatedBlocks, translatedHtml, passed,
    failReason: failParts.join("; "),
    shadow,
  };
}

function runHtmlShadow(
  sourceBlocks: EditorialBlock[],
  restoredTranslatedBlocks: EditorialBlock[],
): { htmlNumbersMatch: boolean; htmlLinksMatch: boolean } {
  const sourceHtml = renderEditorialBlocksToWordPress(sourceBlocks);
  const translatedHtml = renderEditorialBlocksToWordPress(restoredTranslatedBlocks);
  const htmlLinksLost = checkLinksPreserved(sourceHtml, translatedHtml);
  const htmlNumCheck = checkNumbersPreserved(sourceHtml, translatedHtml);
  const htmlNumbersMatch = htmlNumCheck.lost.length === 0;
  const htmlLinksMatch = htmlLinksLost.length === 0;
  return { htmlNumbersMatch, htmlLinksMatch };
}

// ── Try a candidate, falling back if it fails ──

async function tryCandidate(
  sourceBlocks: EditorialBlock[],
  candidateHtml: string,
  componentId: string,
  protectionState: NumberProtectionState,
  sourceHtml: string,
  sourceNumCount: number,
  onStatus: TranslateEditorialBlocksOptions["onStatus"],
): Promise<TranslateEditorialBlocksResult | { retry: CandidateEvaluation }> {
  const evaluation = evaluateCandidate(
    sourceBlocks, candidateHtml, componentId, protectionState, sourceHtml,
  );

  if (evaluation.passed) {
    const metrics = {
      sourceChars: sourceHtml.length,
      translatedChars: evaluation.translatedHtml.length,
      ratio: sourceHtml.length > 0 ? evaluation.translatedHtml.length / sourceHtml.length : 0,
      sourceNumbers: sourceNumCount,
      translatedNumbers: extractNumbersFromEditorialBlocks(evaluation.blocks).length,
      numbersMatch: 1,
    };
    if (onStatus) onStatus({ passed: true, metrics });

    return {
      blocks: evaluation.blocks,
      translatedHtml: evaluation.translatedHtml,
      passed: true,
      metrics,
      validationParity: {
        numbersMatch: true,
        linksMatch: true,
        diagnostics: buildParityDiagnostics(evaluation),
      },
    };
  }

  return { retry: evaluation };
}

function buildParityDiagnostics(
  evaluation: CandidateEvaluation,
): string[] {
  const diag: string[] = [];
  if (evaluation.shadow.htmlNumbersMatch !== evaluation.passed) {
    diag.push(`shadow-disagreement: HTML numbers=${evaluation.shadow.htmlNumbersMatch}, structured=${evaluation.passed}`);
  }
  if (!evaluation.shadow.htmlNumbersMatch && evaluation.passed) {
    diag.push("shadow-false-positive: HTML flagged numbers but structured passed");
  }
  if (evaluation.shadow.htmlNumbersMatch && !evaluation.passed) {
    diag.push("shadow-false-negative: HTML passed numbers but structured flagged");
  }
  return diag;
}

async function attemptRepair(
  protectedHtml: string,
  error: string,
  repairProtectedHtml: (protectedHtml: string, error: string) => Promise<string | null>,
): Promise<string | null> {
  try {
    return await repairProtectedHtml(protectedHtml, error);
  } catch {
    return null;
  }
}

function fallbackResult(
  sourceBlocks: EditorialBlock[],
  componentId: string,
  sourceNumCount: number,
): TranslateEditorialBlocksResult {
  const sourceHtml = renderEditorialBlocksToWordPress(sourceBlocks);
  const fallbackBlocks = parseWordPressEditorialBlocks(sourceHtml, componentId);
  return {
    blocks: fallbackBlocks.blocks,
    translatedHtml: sourceHtml,
    passed: false,
    metrics: {
      sourceChars: sourceHtml.length, translatedChars: sourceHtml.length, ratio: 1,
      sourceNumbers: sourceNumCount, translatedNumbers: 0, numbersMatch: 0,
    },
  };
}

const EMPTY_METRICS = { sourceChars: 0, translatedChars: 0, ratio: 0, sourceNumbers: 0, translatedNumbers: 0, numbersMatch: 0 };

export async function translateEditorialBlocks(
  options: TranslateEditorialBlocksOptions,
): Promise<TranslateEditorialBlocksResult> {
  const { blocks, componentId, translateProtectedHtml, repairProtectedHtml, onStatus } = options;

  if (!blocks || blocks.length === 0) {
    return { blocks: [], translatedHtml: "", passed: true, metrics: EMPTY_METRICS };
  }

  // 1. Protect numbers in EditorialBlock[] (returns new blocks, never mutates source)
  const { blocks: protectedBlocks, state: protectionState } = protectNumbersInEditorialBlocks(blocks);
  const sourceNumCount = protectionState.placeholders.length;

  // 2. Render protected blocks to HTML (AI still receives protected WordPress HTML)
  const protectedHtml = renderEditorialBlocksToWordPress(protectedBlocks);

  // 3. Call AI translation. Provider failures are isolated to this component:
  // return a failed fallback so the orchestrator can continue translating the
  // remaining article and report one complete diagnostic set.
  let translatedProtectedHtml: string;
  try {
    translatedProtectedHtml = await translateProtectedHtml(protectedHtml);
  } catch {
    const fallback = fallbackResult(blocks, componentId, sourceNumCount);
    if (onStatus) onStatus({ passed: false, metrics: fallback.metrics });
    return fallback;
  }

  // 4. Attempt 1: evaluate the initial candidate. Malformed provider output is
  // treated like any other component failure rather than aborting the route.
  let firstAttempt: Awaited<ReturnType<typeof tryCandidate>>;
  try {
    firstAttempt = await tryCandidate(
      blocks, translatedProtectedHtml, componentId, protectionState, protectedHtml, sourceNumCount, onStatus,
    );
  } catch {
    const fallback = fallbackResult(blocks, componentId, sourceNumCount);
    if (onStatus) onStatus({ passed: false, metrics: fallback.metrics });
    return fallback;
  }

  if ("retry" in firstAttempt) {
    // Structured validation failed — attempt repair
    if (repairProtectedHtml) {
      const repaired = await attemptRepair(protectedHtml, firstAttempt.retry.failReason, repairProtectedHtml);
      if (repaired) {
        try {
          const secondAttempt = await tryCandidate(
            blocks, repaired, componentId, protectionState, protectedHtml, sourceNumCount, onStatus,
          );
          if (!("retry" in secondAttempt)) {
            return secondAttempt;
          }
        } catch {
          // Fall through to the source-preserving failed result below.
        }
      }
    }

    // Repair failed or not available — fallback to source
    const fallback = fallbackResult(blocks, componentId, sourceNumCount);
    if (onStatus) onStatus({ passed: false, metrics: fallback.metrics });
    return fallback;
  }

  return firstAttempt;
}

// ── Structured translation shadow mode (conclusion only, diagnostic) ──

export interface StructuredTranslationShadowOptions {
  enabled: boolean;
  translatePayload: (
    payloadJson: string,
    context: { componentKind: "conclusion"; componentId: string },
  ) => Promise<string>;
  repairPayload?: (
    sourcePayloadJson: string,
    invalidResponse: string,
    errors: string[],
    context: { componentKind: "conclusion"; componentId: string },
  ) => Promise<string | null>;
}

export interface StructuredTranslationShadowResult {
  enabled: boolean;
  attempted: boolean;
  passed: boolean;
  repaired: boolean;
  componentKind: "conclusion";
  componentId: string;
  errors: string[];
  metrics?: {
    sourceCharacters: number;
    translatedCharacters: number;
    characterRatio: number;
    blockCount: number;
  };
}

export async function runConclusionStructuredShadow(
  protectedBlocks: EditorialBlock[],
  protectionState: NumberProtectionState,
  componentId: string,
  options: StructuredTranslationShadowOptions,
): Promise<StructuredTranslationShadowResult> {
  if (!options.enabled) {
    return { enabled: false, attempted: false, passed: false, repaired: false, componentKind: "conclusion", componentId, errors: [] };
  }

  const baseResult = { enabled: true, componentKind: "conclusion" as const, componentId };

  // Serialize protected blocks to DTO
  const { payload, linkMap } = serializeTranslationPayload(protectedBlocks, "conclusion");
  const payloadJson = JSON.stringify(payload);

  // Call AI
  let responseJson: string;
  try {
    responseJson = await options.translatePayload(payloadJson, { componentKind: "conclusion", componentId });
  } catch {
    return { ...baseResult, attempted: true, passed: false, repaired: false, errors: ["translation call failed"] };
  }

  // Core evaluation: normalize → reconstruct → validate → restore → verify
  async function evaluateStructuredPayload(
    response: string,
  ): Promise<{ passed: boolean; errors: string[] }> {
    const norm = normalizeTranslationPayload(response, payload);
    if (!norm.payload) {
      return { passed: false, errors: norm.errors };
    }

    const recon = reconstructEditorialBlocks(norm.payload, protectedBlocks, linkMap);
    if (recon.errors.length > 0) {
      return { passed: false, errors: recon.errors };
    }

    const integ = checkPlaceholderIntegrity(recon.blocks, protectionState);
    if (!integ.ok) {
      return { passed: false, errors: [`placeholder integrity: ${integ.errors.join("; ")}`] };
    }

    const restored = restoreNumbersInEditorialBlocks(recon.blocks, protectionState);

    const remaining = checkNoPlaceholdersRemain(restored);
    if (remaining.length > 0) {
      return { passed: false, errors: [`placeholders remain: ${remaining.join(", ")}`] };
    }

    const valErrors = validateEditorialBlocks(restored);
    if (valErrors.length > 0) {
      return { passed: false, errors: valErrors };
    }

    const ctaErr: string[] = [];
    validateConclusionPolicy(norm.payload.blocks, ctaErr);
    if (ctaErr.length > 0) {
      return { passed: false, errors: ctaErr };
    }

    const numCheck = checkBlockNumbersPreserved(protectedBlocks, recon.blocks);
    if (numCheck.lost.length > 0 || numCheck.extras.length > 0) {
      const d: string[] = [];
      if (numCheck.lost.length > 0) d.push(`lost: ${numCheck.lost.join(", ")}`);
      if (numCheck.extras.length > 0) d.push(`extra: ${numCheck.extras.join(", ")}`);
      return { passed: false, errors: [`number mismatch (${d.join("; ")})`] };
    }

    const linksLost = checkBlockLinksPreserved(protectedBlocks, recon.blocks);
    if (linksLost.length > 0) {
      return { passed: false, errors: [`links lost: ${linksLost.join(", ")}`] };
    }

    const readableText = extractAllTextFromInlineContent(restored);
    if (!readableText.trim()) {
      return { passed: false, errors: ["no readable content"] };
    }

    return { passed: true, errors: [] };
  }

  let evaluation = await evaluateStructuredPayload(responseJson);
  let repaired = false;

  if (!evaluation.passed && options.repairPayload) {
    try {
      const repairResponse = await options.repairPayload(payloadJson, responseJson, evaluation.errors, { componentKind: "conclusion", componentId });
      if (repairResponse) {
        evaluation = await evaluateStructuredPayload(repairResponse);
        if (evaluation.passed) repaired = true;
      }
    } catch {
      // repair threw
    }
  }

  if (!evaluation.passed) {
    return { ...baseResult, attempted: true, passed: false, repaired, errors: evaluation.errors };
  }

  return {
    ...baseResult, attempted: true, passed: true, repaired, errors: [],
    metrics: {
      sourceCharacters: payloadJson.length,
      translatedCharacters: responseJson.length,
      characterRatio: payloadJson.length > 0 ? responseJson.length / payloadJson.length : 0,
      blockCount: payload.blocks.length,
    },
  };
}
