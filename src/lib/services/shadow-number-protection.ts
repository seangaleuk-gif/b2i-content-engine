// ── Shared shadow number-placeholder protection/restore ──
//
// Used by both the coherent-chunk shadow translation and the bilingual
// whole-document editorial polish. Reuses the production-proven placeholder
// utilities so formatting variants (10,000 vs 10000) can never false-positive.

import { protectNumbersInEditorialBlocks, restoreNumbersInEditorialBlocks, analyzeBlockPlaceholderIntegrity } from "./editorial-block-protection";
import { protectNumbersInHtml, tryRestoreNumbersInHtml } from "./translation-validator";
import type { TranslationChunk, TranslatedUnitResult } from "./translation-chunk-planner";
import type { TranslationSourceUnit } from "./translation-source-document";

export interface ShadowTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ShadowProviderResponse {
  content: string;
  finishReason?: string;
  usage?: ShadowTokenUsage;
  attemptsUsed?: number;
  truncated?: boolean;
  model?: string;
}

export interface RestoreState {
  placeholders: string[];
  originalValues: string[];
  kind: "block" | "html";
}

export interface RestoredResponse {
  units: TranslatedUnitResult[];
  integrity: Map<string, { lost: string[]; extra: string[] }>;
}

/** Replace numbers in a chunk's units with `__NUM_n__` placeholders before submission. */
export function protectChunkForSubmission(chunk: TranslationChunk): {
  protectedChunk: TranslationChunk;
  restoreStates: Map<string, RestoreState>;
} {
  const restoreStates = new Map<string, RestoreState>();
  const protectedUnits = chunk.units.map((unit): TranslationSourceUnit => {
    switch (unit.type) {
      case "introduction-block":
      case "section-block":
      case "conclusion-block": {
        const { blocks, state } = protectNumbersInEditorialBlocks([unit.block]);
        restoreStates.set(unit.sourceId, { ...state, kind: "block" });
        return { ...unit, block: blocks[0] };
      }
      case "faq-answer": {
        const htmlState = protectNumbersInHtml(unit.answerHtml || unit.answerText);
        const textState = protectNumbersInHtml(unit.answerText || "");
        restoreStates.set(unit.sourceId, { placeholders: htmlState.placeholders, originalValues: htmlState.originalValues, kind: "html" });
        return { ...unit, answerHtml: htmlState.protectedHtml, answerText: textState.protectedHtml };
      }
      case "cta":
        return unit;
      default: {
        const s = protectNumbersInHtml(unit.text);
        restoreStates.set(unit.sourceId, { placeholders: s.placeholders, originalValues: s.originalValues, kind: "html" });
        return { ...unit, text: s.protectedHtml };
      }
    }
  });
  return { protectedChunk: { ...chunk, units: protectedUnits }, restoreStates };
}

/** Restore protected numbers from returned units and report placeholder integrity. */
export function restoreResponseUnits(
  returnedUnits: TranslatedUnitResult[],
  restoreStates: Map<string, RestoreState>,
): RestoredResponse {
  const integrity = new Map<string, { lost: string[]; extra: string[] }>();
  const units = returnedUnits.map((unit) => {
    const state = restoreStates.get(unit.sourceUnitId);
    if (!state) return unit;
    if (state.kind === "block" && unit.block) {
      const { lost, extra } = analyzeBlockPlaceholderIntegrity([unit.block], state.placeholders);
      integrity.set(unit.sourceUnitId, { lost, extra });
      const blocks = restoreNumbersInEditorialBlocks([unit.block], state);
      return { ...unit, block: blocks[0] };
    }
    if (unit.answerHtml !== undefined || unit.answerText !== undefined) {
      const html = tryRestoreNumbersInHtml(unit.answerHtml ?? "", state.placeholders, state.originalValues);
      const text = tryRestoreNumbersInHtml(unit.answerText ?? "", state.placeholders, state.originalValues);
      integrity.set(unit.sourceUnitId, { lost: html.lost, extra: html.extras });
      return { ...unit, answerHtml: html.html, answerText: text.html };
    }
    if (unit.text !== undefined) {
      const r = tryRestoreNumbersInHtml(unit.text, state.placeholders, state.originalValues);
      integrity.set(unit.sourceUnitId, { lost: r.lost, extra: r.extras });
      return { ...unit, text: r.html };
    }
    return unit;
  });
  return { units, integrity };
}
