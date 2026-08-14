// ── Quotation integrity ──
// Context-aware quotation analysis shared by generation acceptance,
// deterministic sentence removal and the final publication-quality gate.
// This leaf module has no ArticleDocument dependency, which keeps every
// producer and validator on one quotation rule without creating import cycles.

export interface QuotationRange {
  start: number;
  end: number;
  style: "straight" | "smart";
}

export interface QuotationIntegrityAnalysis {
  balanced: boolean;
  spans: QuotationRange[];
  unmatchedOffsets: number[];
}

/**
 * A straight double quote immediately after a digit is an inch mark only when
 * no straight quotation is currently open. This preserves ordinary measures
 * (`13" screen`) while still recognizing the closing mark in a valid numeric
 * quotation (`the answer was "5"`).
 */
function isStandaloneInchMark(
  text: string,
  index: number,
  straightQuoteOpen: number | null,
): boolean {
  if (!/\d/.test(text[index - 1] ?? "")) return false;
  const followingWords = text.slice(index + 1);
  if (
    /^\s*(?:screen|display|monitor|panel|laptop|tablet|phone|television|tv|wheel|diameter|wide|long|high|tall|deep|thick)\b/i
      .test(followingWords)
  ) {
    return true;
  }
  if (straightQuoteOpen !== null) return false;
  const next = text[index + 1] ?? "";
  return next === "" || /[\s,.;:!?)}\]]/.test(next);
}

/**
 * Analyze paired English double quotation marks. Smart quotes are directional;
 * straight quotes toggle open/closed state after contextual inch marks are
 * excluded. Apostrophes and single quotation marks are deliberately outside
 * this detector because they are also valid contractions/possessives.
 */
export function analyzeQuotationIntegrity(text: string): QuotationIntegrityAnalysis {
  const spans: QuotationRange[] = [];
  const unmatchedOffsets: number[] = [];
  let smartQuoteOpen: number | null = null;
  let straightQuoteOpen: number | null = null;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "“") {
      if (smartQuoteOpen !== null) unmatchedOffsets.push(smartQuoteOpen);
      smartQuoteOpen = index;
      continue;
    }
    if (character === "”") {
      if (smartQuoteOpen === null) {
        unmatchedOffsets.push(index);
      } else {
        spans.push({ start: smartQuoteOpen, end: index + 1, style: "smart" });
        smartQuoteOpen = null;
      }
      continue;
    }
    if (character !== '"' || isStandaloneInchMark(text, index, straightQuoteOpen)) {
      continue;
    }
    if (straightQuoteOpen === null) {
      straightQuoteOpen = index;
    } else {
      spans.push({ start: straightQuoteOpen, end: index + 1, style: "straight" });
      straightQuoteOpen = null;
    }
  }

  if (smartQuoteOpen !== null) unmatchedOffsets.push(smartQuoteOpen);
  if (straightQuoteOpen !== null) unmatchedOffsets.push(straightQuoteOpen);
  unmatchedOffsets.sort((left, right) => left - right);
  spans.sort((left, right) => left.start - right.start);
  return {
    balanced: unmatchedOffsets.length === 0,
    spans,
    unmatchedOffsets,
  };
}
