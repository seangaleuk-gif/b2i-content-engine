// ── B2I Cantonese language pack (versioned, retrieval-based) ──
//
// A versioned, retrieval-based B2I Cantonese language pack that teaches the
// existing translation and editorial calls how B2I writes professional Hong Kong
// Cantonese across future topics. It is NOT a growing blacklist and NOT a
// deterministic sentence-replacement engine.
//
// Retrieval is local and deterministic (no AI/embedding call). Only APPROVED
// examples are retrievable; raw model output is never auto-approved.

export const B2I_CANTONESE_LANGUAGE_PACK_VERSION = "2026.08.02.v1";

// ── Terminology (stable, controlled termbase) ──
// These map to the deterministic glossary. Keep concise and controlled.

export interface B2iTerminologyEntry {
  en: string;
  zh: string;
}

export const B2I_CANTONESE_TERMINOLOGY: B2iTerminologyEntry[] = [
  { en: "influencer marketing", zh: "創作者市場推廣" },
  { en: "creator / influencer", zh: "創作者" },
  { en: "campaign", zh: "推廣活動" },
  { en: "follower", zh: "粉絲" },
  { en: "engagement rate", zh: "互動率" },
  { en: "rate card", zh: "價目表" },
  { en: "brief", zh: "合作簡報" },
];

// ── Preferred Hong Kong terminology / register policy ──
// One preferred term per reusable concept unless context genuinely requires
// variation. This is policy guidance (not a sentence-replacement list): the
// model must keep the chosen term consistent throughout the article. Natural
// Hong Kong phrasing is preferred over literal mainland/cross-strait forms.

export interface B2iTerminologyPolicy {
  en: string;
  preferred: string;
  avoid?: string[];
  note?: string;
}

export const B2I_CANTONESE_TERMINOLOGY_POLICY: B2iTerminologyPolicy[] = [
  { en: "creator", preferred: "創作者", avoid: ["網紅"], note: "consistent across the article" },
  { en: "follower", preferred: "粉絲", avoid: ["追蹤者", "follower"], note: "pick one term and use it consistently" },
  { en: "target audience", preferred: "目標受眾", avoid: ["目標群組", "受眾檔案"] },
  { en: "brand fit", preferred: "適合品牌", avoid: ["品牌匹配", "品牌配合"], note: "prefer natural Hong Kong phrasing over 匹配" },
  { en: "engagement", preferred: "互動", avoid: ["互動度"] },
  { en: "reach", preferred: "觸及", avoid: ["覆蓋人數"] },
  { en: "conversion", preferred: "轉換", note: "business meaning, keep consistent" },
  { en: "campaign", preferred: "推廣活動", avoid: ["廣告活動"] },
  { en: "performance", preferred: "成效", avoid: ["表現"] },
  { en: "publisher", preferred: "發布者 / 媒體", avoid: ["出版商"], note: "use 媒體 when it refers to the outlet" },
  { en: "source", preferred: "來源", avoid: ["資料來源"] },
  { en: "call to action", preferred: "行動呼籲", avoid: ["行動召喚"] },
  { en: "partnership", preferred: "合作夥伴", avoid: ["夥伴關係"] },
  { en: "brand awareness", preferred: "品牌認知", avoid: ["品牌知名度"] },
];

/** Render the terminology/register policy as a compact prompt section. */
export function buildTerminologyPolicyPrompt(): string {
  const lines = B2I_CANTONESE_TERMINOLOGY_POLICY.map((p) => {
    const avoid = p.avoid && p.avoid.length > 0 ? `; avoid ${p.avoid.join("、")}` : "";
    const note = p.note ? ` (${p.note})` : "";
    return `- ${p.en} → ${p.preferred}${avoid}${note}`;
  });
  return [
    "PREFERRED HONG KONG TERMINOLOGY (one term per concept unless context genuinely requires variation):",
    ...lines,
    "Choose one primary term per concept and use it consistently across the entire article. Prefer natural Hong Kong phrasing over 匹配; use Hong Kong Traditional Chinese character forms; and distinguish professional business language from unnecessary formal written Chinese. Keep approved English brands and acronyms in English.",
  ].join("\n");
}

// ── Deterministic terminology ledger (local, no API call) ──
// Built before the monolingual proofread from the approved policy and the terms
// actually selected during bilingual revision. Chooses one preferred term per
// concept (the approved preferred form when present in the revised text, else
// the policy default). Rendered as a compact immutable-constraint section so the
// final proofreader keeps terminology consistent without seeing English prose.

export interface TerminologyLedgerEntry {
  concept: string;
  preferred: string;
  observed: string[];
}

export function buildTerminologyLedger(
  chineseTexts: string[],
  policy: B2iTerminologyPolicy[] = B2I_CANTONESE_TERMINOLOGY_POLICY,
): TerminologyLedgerEntry[] {
  const joined = chineseTexts.join("\n");
  const ledger: TerminologyLedgerEntry[] = [];
  for (const p of policy) {
    const observed = (p.avoid ?? []).filter((v) => v && joined.includes(v));
    ledger.push({ concept: p.en, preferred: p.preferred, observed });
  }
  return ledger;
}

export function buildTerminologyLedgerPrompt(ledger: TerminologyLedgerEntry[]): string {
  if (ledger.length === 0) return "";
  const lines = ledger.map((entry) => {
    const observed = entry.observed.length > 0 ? ` (observed: ${entry.observed.join("、")})` : "";
    return `- ${entry.concept} → ${entry.preferred}${observed}`;
  });
  return [
    "TERMINOLOGY LEDGER (immutable constraints): use ONE preferred term per concept consistently across the whole document. Correct any variant back to the preferred term unless context genuinely requires variation.",
    ...lines,
  ].join("\n");
}

// ── Durable style principles ──

export const B2I_CANTONESE_STYLE_PRINCIPLES: string[] = [
  "professional Hong Kong business-blog voice",
  "conversational but not slang-heavy",
  "natural Cantonese sentence structure",
  "no Mainland Chinese terminology",
  "no unnecessary English when natural Cantonese exists",
  "brands, platforms and recognised acronyms may remain English",
  "preserve meaning rather than English syntax",
  "avoid literal passive constructions",
  "avoid direct translations of English metaphors",
  "avoid formal written-Chinese wording inside conversational Cantonese",
  "maintain terminology consistently throughout the article",
];

// ── Approved parallel examples ──

export interface B2iCantoneseExample {
  id: string;
  en: string;
  zh: string;
  tags: string[];
  domain: string;
  principles: string[];
  version: string;
  approved: boolean;
}

export const B2I_CANTONESE_EXAMPLES: B2iCantoneseExample[] = [
  { id: "align-goals", en: "align campaign goals", zh: "確保雙方對推廣活動目標有共識", tags: ["alignment", "campaign", "goals"], domain: "campaign", principles: ["meaning", "natural"], version: "2026.08.02.v1", approved: true },
  { id: "tiktok-focused", en: "TikTok-focused partners", zh: "以 TikTok 為主嘅合作夥伴", tags: ["platform", "tiktok"], domain: "platform", principles: ["brands", "natural"], version: "2026.08.02.v1", approved: true },
  { id: "creator-led", en: "creator-led marketing", zh: "由創作者主導嘅市場推廣", tags: ["creator", "marketing"], domain: "creator", principles: ["natural"], version: "2026.08.02.v1", approved: true },
  { id: "data-driven", en: "data-driven strategy", zh: "以數據為基礎嘅策略", tags: ["data", "strategy"], domain: "data", principles: ["natural"], version: "2026.08.02.v1", approved: true },
  { id: "mobile-first", en: "mobile-first experience", zh: "以手機使用體驗為先嘅設計", tags: ["mobile", "experience"], domain: "product", principles: ["natural"], version: "2026.08.02.v1", approved: true },
  { id: "platform-content", en: "platform-specific content", zh: "針對唔同平台製作嘅內容", tags: ["platform", "content"], domain: "platform", principles: ["natural"], version: "2026.08.02.v1", approved: true },
  { id: "right-match", en: "find the right match", zh: "搵到真正適合嘅合作夥伴", tags: ["matching", "partner"], domain: "partnership", principles: ["meaning"], version: "2026.08.02.v1", approved: true },
  { id: "keep-honest", en: "keep everyone honest", zh: "令各方都可以按清晰目標衡量成效", tags: ["accountability", "goals"], domain: "campaign", principles: ["metaphor", "meaning"], version: "2026.08.02.v1", approved: true },
  { id: "new-territory", en: "bring global influencer-marketing ideas into new territory", zh: "將國際經驗同新嘅推廣方式帶入本地市場", tags: ["global", "local", "expansion"], domain: "expansion", principles: ["metaphor", "meaning"], version: "2026.08.02.v1", approved: true },
  { id: "beauty-brand", en: "what works for a beauty brand", zh: "對美容品牌有效嘅方法", tags: ["brand", "beauty", "effectiveness"], domain: "brand", principles: ["meaning"], version: "2026.08.02.v1", approved: true },
  { id: "nice-to-have", en: "nice-to-have", zh: "可有可無嘅附加項目", tags: ["optional", "product"], domain: "product", principles: ["metaphor"], version: "2026.08.02.v1", approved: true },
  { id: "build-loyalty", en: "ultimately builds loyalty", zh: "長遠建立顧客忠誠度", tags: ["loyalty", "longterm"], domain: "loyalty", principles: ["meaning"], version: "2026.08.02.v1", approved: true },
  { id: "owned-power", en: "owned brand power", zh: "品牌本身嘅影響力", tags: ["brand", "influence"], domain: "brand", principles: ["metaphor"], version: "2026.08.02.v1", approved: true },
  { id: "relatable-voices", en: "voices that feel like home", zh: "熟悉、可信同有共鳴嘅聲音", tags: ["audience", "voices", "trust"], domain: "audience", principles: ["metaphor"], version: "2026.08.02.v1", approved: true },
];

// ── Unapproved candidates (never retrievable until explicitly approved) ──

export const B2I_CANTONESE_CANDIDATES: B2iCantoneseExample[] = [
  { id: "candidate-raw-output-1", en: "a raw model output correction awaiting approval", zh: "尚未批准嘅示例", tags: [], domain: "general", principles: [], version: "2026.08.02.v1", approved: false },
];

// ── Deterministic local retrieval ──

export interface B2iRetrievalContext {
  sourceUnitType?: string;
  headingTerms?: string[];
  domainTerm?: string;
}

export interface RetrievedExample {
  example: B2iCantoneseExample;
  score: number;
}

export interface B2iRetrievalOptions {
  maxExamples?: number;
  maxPromptChars?: number;
  minScore?: number;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "by",
  "at", "is", "are", "be", "was", "were", "that", "this", "its", "their", "our",
  "you", "your", "we", "they", "from", "as", "into", "about", "more",
]);

// Generic words that should not, on their own, cause an example to be retrieved.
const GENERIC_WORDS = new Set([
  "brand", "marketing", "strategy", "content", "product", "business", "market",
  "ideas", "growth", "service",
]);

function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]*/g) || []).filter((w) => !STOP_WORDS.has(w) && w.length > 1);
}

/**
 * Hybrid relevance score: keyword + exact-phrase + tag + domain + heading overlap.
 * Concept words and exact source-phrase overlap are weighted most heavily; generic
 * words alone never retrieve an unrelated example.
 */
export function scoreExample(
  example: B2iCantoneseExample,
  sourceText: string,
  context: B2iRetrievalContext = {},
): number {
  const sourceLower = sourceText.toLowerCase();
  const sourceKw = new Set(keywords(sourceText));
  let score = 0;
  for (const kw of keywords(example.en)) {
    if (sourceKw.has(kw)) score += GENERIC_WORDS.has(kw) ? 0 : 1.5;
  }
  for (const phrase of example.en.toLowerCase().split(/\s+/)) {
    if (phrase.length >= 3 && !STOP_WORDS.has(phrase) && !GENERIC_WORDS.has(phrase) && sourceLower.includes(phrase)) score += 2.5;
  }
  for (const tag of example.tags) if (!GENERIC_WORDS.has(tag) && sourceLower.includes(tag)) score += 1;
  if (example.domain && !GENERIC_WORDS.has(example.domain) && sourceLower.includes(example.domain)) score += 0.5;
  if (context.domainTerm && sourceLower.includes(context.domainTerm.toLowerCase())) score += 0.5;
  for (const term of (context.headingTerms ?? [])) {
    if (sourceLower.includes(term.toLowerCase())) score += 0.5;
  }
  return score;
}

/**
 * Retrieve the best approved examples for a source chunk. Local and deterministic:
 * only approved examples, bounded set, prompt-size budget, deterministic ordering
 * for ties, and nothing retrieved when relevance is below the threshold.
 */
export function retrieveCantoneseExamples(
  sourceText: string,
  context: B2iRetrievalContext = {},
  options: B2iRetrievalOptions = {},
): RetrievedExample[] {
  const maxExamples = options.maxExamples ?? 8;
  const maxPromptChars = options.maxPromptChars ?? 1200;
  const minScore = options.minScore ?? 0;

  const scored = B2I_CANTONESE_EXAMPLES
    .filter((example) => example.approved)
    .map((example) => ({ example, score: scoreExample(example, sourceText, context) }))
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id));

  // Diversity: keep the first example per tag-key (avoids near-duplicates).
  const seenTagKey = new Set<string>();
  const diverse: RetrievedExample[] = [];
  for (const r of scored) {
    const key = r.example.tags.join("|");
    if (seenTagKey.has(key)) continue;
    seenTagKey.add(key);
    diverse.push(r);
    if (diverse.length >= maxExamples) break;
  }

  // Strict prompt-size budget.
  const result: RetrievedExample[] = [];
  let chars = 0;
  for (const r of diverse) {
    const approx = r.example.en.length + r.example.zh.length + 48;
    if (result.length > 0 && chars + approx > maxPromptChars) break;
    result.push(r);
    chars += approx;
  }
  return result;
}

/** Render retrieved examples as a compact prompt section. */
export function buildLanguagePackExamplePrompt(retrieved: RetrievedExample[]): string {
  if (retrieved.length === 0) return "";
  const lines = retrieved.map((r) => `- ${r.example.en} → ${r.example.zh}`);
  return [
    "B2I CANTONESE STYLE EXAMPLES (v" + B2I_CANTONESE_LANGUAGE_PACK_VERSION + "; retrieved for this content):",
    "These approved examples demonstrate B2I's preferred Hong Kong Cantonese style for similar ideas. Use them as guidance:",
    ...lines,
    "Follow the grammatical and stylistic patterns where relevant. Do NOT copy facts or names from examples. Do NOT force an example when the context differs. Preserve the source meaning, numbers, names, links and claims exactly.",
  ].join("\n");
}
