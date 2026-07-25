// ── Factual-Risk Scanner ──
// Post-generation scan that flags unsupported precise claims in editable article content.
// Uses only supplied project research text — never the live web.
//
// Supported claims are retained.
// Unsupported claims in editable content trigger targeted regeneration.
// If regeneration still has unsupported claims, the offending sentence is removed.

import { countReadableWords, containsExactPhrase } from "@/lib/services/text-utils";

// ── Types ──

export interface FactualRisk {
  /** Array of claims found in the article text */
  claims: ScannedClaim[];
  /** Whether the article contains any high-risk (likely unsupported) claims */
  hasHighRisk: boolean;
}

export interface ScannedClaim {
  /** The exact claim text fragment */
  text: string;
  /** Position in the HTML where the claim starts */
  htmlPosition: number;
  /** The claim category */
  category: ClaimCategory;
  /** Whether this claim appears to be supported by research text */
  supported: boolean;
  /** Section index (which H2 section this appears in) */
  sectionIndex: number;
}

export type ClaimCategory =
  | "percentage"
  | "currency_amount"
  | "numerical_growth"
  | "testimonial_quote"
  | "business_result";

// ── Claim detection patterns ──

const CLAIM_PATTERNS: Array<{ category: ClaimCategory; regex: RegExp }> = [
  // Percentages
  { category: "percentage", regex: /\d{1,3}%\s*(?:of|increase|decrease|growth|drop|rise|fall|more|less|jump|surge)/gi },
  { category: "percentage", regex: /(?:over|nearly|almost|approximately|about)\s*\d{1,3}%/gi },
  // Numerical growth claims
  { category: "numerical_growth", regex: /(?:increased|decreased|grew|fell|rose|dropped|doubled|tripled|jumped|surged)\s+(?:by|from|to)\s+\d+/gi },
  { category: "numerical_growth", regex: /(?:jumped|surged|shot up|soared|plummeted|plunged)\s+(?:\d+)/gi },
  { category: "numerical_growth", regex: /\d+\s*(?:percent|per cent|times|x)\s+(?:increase|decrease|growth|drop|rise|fall|more)/gi },
  // Business results
  { category: "business_result", regex: /generated?\s+\d+\s*(?:percent|%|times|x|more)/gi },
  { category: "business_result", regex: /(?:sales|revenue|traffic|leads|conversions?)\s+(?:rose|increased|grew|jumped|surged)\s+\d+/gi },
  { category: "business_result", regex: /\d+\s*(?:percent|%)\s+(?:increase|decrease|growth|boost|rise|drop)\s+in\s+(?:sales|revenue|traffic|leads|conversions?|engagement|visits?)/gi },
  // Testimonials with quotation marks
  { category: "testimonial_quote", regex: /"[^"]{10,}"/gi },
  // Unnamed business testimonials
  { category: "testimonial_quote", regex: /(?:a|one)\s+(?:local|small|Hong Kong)\s+(?:business|brand|company|shop|store|cafe|bakery|studio)\s+(?:told us|shared|reported|said|noted|found|experienced|saw)/gi },
  // "X more" claims
  { category: "business_result", regex: /\d+\s*(?:times|x)\s+more\s+(?:sales|revenue|traffic|leads|engagement|visits?|conversions?)/gi },
];

// ── Research-source text extraction ──

function extractResearchText(research?: Array<{ title?: string; snippet?: string; url?: string }>): string {
  if (!research || research.length === 0) return "";
  return research
    .map((r) => `${r.title || ""} ${r.snippet || ""}`)
    .join(" ")
    .toLowerCase();
}

// ── Scanner ──

export function scanFactualRisks(
  html: string,
  keyphrase: string,
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): FactualRisk {
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const researchText = extractResearchText(research);

  // Find H2 section boundaries for claim positioning
  const h2Positions: number[] = [];
  const h2Re = /<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi;
  let h2m: RegExpExecArray | null;
  while ((h2m = h2Re.exec(html)) !== null) {
    h2Positions.push(h2m.index);
  }

  function findSectionIndex(pos: number): number {
    let idx = 0;
    for (let i = h2Positions.length - 1; i >= 0; i--) {
      if (pos >= h2Positions[i]) { idx = i; break; }
    }
    return idx;
  }

  const claims: ScannedClaim[] = [];

  for (const { category, regex } of CLAIM_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(bodyText)) !== null) {
      // Deduplicate by matching text
      const text = m[0].trim();
      if (claims.some((c) => c.text === text)) continue;

      // Find approximate position in HTML
      const htmlPos = html.indexOf(m[0]);
      if (htmlPos < 0) continue;

      // Check if claim is in a protected block (CTA, switcher, schema)
      const beforeClaim = html.substring(0, htmlPos);
      const lastOpenComment = beforeClaim.lastIndexOf("<!--");
      const lastCloseComment = beforeClaim.lastIndexOf("-->");
      if (lastOpenComment > lastCloseComment) continue; // Inside a comment block

      const sectionIndex = findSectionIndex(htmlPos);
      const claimText = m[0].toLowerCase();

      // Check if the claim number is supported by research text
      let supported = false;
      if (researchText.length > 0) {
        // Extract the number from the claim
        const numMatch = claimText.match(/\d+([\d.,]*)/);
        if (numMatch) {
          const num = numMatch[0].replace(/[,.]/g, "");
          // Check if this number appears in research near related keywords
          const researchHasNumber = new RegExp(`\\b${num}\\b`).test(researchText);
          if (researchHasNumber) {
            // Even if number exists, check it's used with the same context
            const keywords = claimText.replace(/\d+[\d.,]*/g, "").trim().split(/\s+/).filter(Boolean);
            const keywordOverlap = keywords.filter((kw) => researchText.includes(kw)).length;
            supported = researchHasNumber && keywordOverlap >= Math.min(2, keywords.length);
          }
        }
      }

      claims.push({
        text: m[0],
        htmlPosition: htmlPos,
        category,
        supported,
        sectionIndex,
      });
    }
  }

  const hasHighRisk = claims.some((c) => !c.supported);
  return { claims, hasHighRisk };
}

// ── Claim removal from section body ──

export function removeUnsupportedSentences(
  sectionHtml: string,
  unsupportedClaims: ScannedClaim[],
): { html: string; sentencesRemoved: number } {
  let modified = sectionHtml;
  let removed = 0;

  for (const claim of unsupportedClaims) {
    // Check if the claim text is within this section HTML
    const idx = modified.indexOf(claim.text);
    if (idx < 0) continue;

    // Try to remove the entire sentence containing the claim
    const beforeText = modified.substring(0, idx);
    const afterText = modified.substring(idx);

    // Find sentence boundaries
    const sentenceStart = Math.max(
      beforeText.lastIndexOf(". ") + 2,
      beforeText.lastIndexOf(".\n") + 2,
      beforeText.lastIndexOf("? ") + 2,
      beforeText.lastIndexOf("! ") + 2,
      0,
    );
    const sentenceEnd = (() => {
      const endIdx = afterText.search(/[.?!]\s/);
      return endIdx >= 0 ? idx + endIdx + 1 : modified.length;
    })();

    if (sentenceEnd > sentenceStart) {
      const sentence = modified.substring(sentenceStart, sentenceEnd).trim();
      // Don't remove if it would leave an orphaned paragraph
      const remainingAfter = modified.substring(sentenceEnd).trim();
      if (remainingAfter.length > 0 || sentenceStart > 0) {
        modified = modified.substring(0, sentenceStart) + remainingAfter;
        removed++;
      }
    }
  }

  // Clean up empty paragraphs that may result
  modified = modified.replace(
    /<!--\s*wp:paragraph\s*-->\s*\n?<p>\s*<\/p>\s*\n?<!--\s*\/wp:paragraph\s*-->/gi,
    "",
  );

  return { html: modified, sentencesRemoved: removed };
}

// ── Format claims for logging ──

export function formatClaimLog(claims: ScannedClaim[]): string {
  const supported = claims.filter((c) => c.supported);
  const unsupported = claims.filter((c) => !c.supported);
  const lines: string[] = [];
  lines.push(`Claims found: ${claims.length} (${unsupported.length} unsupported)`);
  for (const c of unsupported) {
    lines.push(`  [UNSUPPORTED] [${c.category}] section=${c.sectionIndex} text="${c.text.substring(0, 80)}"`);
  }
  for (const c of supported) {
    lines.push(`  [SUPPORTED]   [${c.category}] section=${c.sectionIndex} text="${c.text.substring(0, 80)}"`);
  }
  return lines.join("\n");
}
