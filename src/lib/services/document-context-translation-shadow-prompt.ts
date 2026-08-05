// ── Document-context shadow prompt construction (Stage 2B) ──
//
// Builds the provider prompts for the disabled-by-default coherent-chunk
// translation shadow. This module only constructs prompts; it never calls an
// AI provider. It is additive and not used by the production translation path.

import type { ChatMessage } from "@/lib/services/deepseek";
import { buildTranslationGlossaryPrompt } from "./translation-glossary";
import { buildCantoneseStyleExamplePrompt } from "./translation-style-examples";
import { buildTerminologyPolicyPrompt } from "./b2i-cantonese-language-pack";
import { buildAvoidedTerminologyGuidance } from "./zh-hk-style-contract";
import { EDITORIAL_PATCH_UNIT_KEY } from "./cantonese-style-linter";
import type { EditorialBlock } from "@/lib/blog/article-content";
import type { DocumentBrief, TranslationChunk } from "./translation-chunk-planner";
import type { TranslationSourceUnit } from "./translation-source-document";
import { serializeTranslationSourceDocument, type TranslationSourceDocument } from "./translation-source-document";

/** Concatenated visible source text of an editorial block for retrieval scoring. */
function blockSourceText(block: EditorialBlock): string {
  const collect = (nodes: Array<{ text?: string }>): string => nodes.map((n) => n.text ?? "").join(" ");
  switch (block.type) {
    case "list":
      return block.items.map(collect).join(" ");
    case "table":
      return [...block.headers.map(collect), ...block.rows.flat().map(collect)].join(" ");
    default:
      return collect(block.content);
  }
}

/** Visible plain text of a translation source unit, for terminology-relevance checks. */
function unitVisibleText(unit: TranslationSourceUnit): string {
  switch (unit.type) {
    case "introduction-block":
    case "section-block":
    case "conclusion-block":
      return blockSourceText(unit.block);
    case "faq-answer":
      return unit.answerText ?? "";
    case "cta":
      return "";
    default:
      return unit.text ?? "";
  }
}

/** Concatenated English source text of a chunk, used for local example retrieval. */
export function chunkSourceText(chunk: TranslationChunk): string {
  return chunk.units.map((unit) => {
    switch (unit.type) {
      case "introduction-block":
      case "section-block":
      case "conclusion-block":
        return blockSourceText(unit.block);
      case "faq-answer":
        return unit.answerText || unit.answerHtml || "";
      case "cta":
        return unit.html || "";
      default:
        return unit.text || "";
    }
  }).join(" ");
}

export function serializeShadowChunkUnits(chunk: TranslationChunk): string {
  return JSON.stringify(chunk.units.map((unit) => {
    switch (unit.type) {
      case "faq-answer":
        return { sourceUnitId: unit.sourceId, answerHtml: unit.answerHtml, answerText: unit.answerText };
      case "introduction-block":
      case "section-block":
      case "conclusion-block":
        return { sourceUnitId: unit.sourceId, block: unit.block };
      case "cta":
        return { sourceUnitId: unit.sourceId, html: unit.html };
      default:
        return { sourceUnitId: unit.sourceId, text: unit.text };
    }
  }));
}

function formatHeadingOutline(brief: DocumentBrief): string {
  if (brief.headingOutline.length === 0) return "(no headings)";
  return brief.headingOutline.map((heading, index) => `${index + 1}. ${heading}`).join("\n");
}

/** Reusable faithful-translation contract shared by every translation chunk. */
export const FAITHFUL_TRANSLATION_CONTRACT: string = [
  "FAITHFUL TRANSLATION CONTRACT (applies to every unit):",
  "- Translate faithfully, sentence by sentence, into natural, professional Hong Kong Cantonese.",
  "- Preserve all meaning, claims, examples, certainty, emphasis and paragraph purpose. Never add, remove, summarise, expand, improve or reinterpret content.",
  "- Translate idioms and figurative language by their intended meaning, not literal English wording.",
  "- Keep the source tone: friendly, clear and professional.",
  "- Use consistent terminology throughout the entire document (see REQUIRED PROJECT GLOSSARY).",
  "- Avoid overly formal written Chinese, Mainland Chinese terminology (e.g. 營銷-based terms such as 網紅營銷, 影響力行銷) and excessive slang.",
  "- Render numbers, percentages, prices, dates, brand names and source names exactly as they appear.",
  "",
  "SILENT INTERNAL VERIFICATION (perform internally before returning; NEVER output this step, any draft, findings or review notes):",
  "- Compare every translation directly against its immutable English source and correct ANY of: literal English sentence structures that read unnaturally in Cantonese; unnatural Hong Kong Cantonese phrasing; Mainland Chinese terminology; excessive slang; formal written-Chinese wording that conflicts with the required conversational Cantonese register; terminology inconsistent with the REQUIRED PROJECT GLOSSARY; untranslated English left in any unit.",
  "- Correct any added, removed, weakened or strengthened meaning, certainty, comparison, claim, example or number.",
  "- Preserve source unit IDs, order, paragraph purpose, facts, examples, certainty, names, numbers, URLs and formatting exactly.",
  "- Translate ONLY your assigned units. Return ONLY the final verified translation JSON — no drafts, explanations, findings or review notes.",
].join("\n");

/** Render the faithful translation contract section for the prompt. */
export function buildFaithfulTranslationContract(): string {
  return FAITHFUL_TRANSLATION_CONTRACT;
}

/**
 * Serialize the COMPLETE English article as lossless read-only context. Delivered
 * to every translation call so the model can compare its assigned units against
 * the full source without being able to translate or return non-assigned units.
 */
export function serializeFullEnglishArticleContext(sourceDoc: TranslationSourceDocument): string {
  return serializeTranslationSourceDocument(sourceDoc);
}

/** System prompt carrying the immutable document brief, register, glossary and canonical rules. */
export function buildDocumentContextShadowSystemPrompt(brief: DocumentBrief, brandProfile = ""): string {
  return [
    "You are a senior bilingual editor translating an English business blog into natural Hong Kong Traditional Chinese (zh-HK) with a consistent conversational Cantonese register.",
    "",
    buildFaithfulTranslationContract(),
    "",
    "DOCUMENT CONTEXT:",
    `- English title: ${brief.englishTitle}`,
    brief.focusKeyphrase ? `- Focus keyphrase: ${brief.focusKeyphrase}` : "- Focus keyphrase: (none)",
    `- Article purpose: ${brief.articlePurpose || "(none)"}`,
    "- Full ordered heading outline:",
    formatHeadingOutline(brief).split("\n").map((line) => `  ${line}`).join("\n"),
    "",
    "CANONICAL ENGLISH SOURCE:",
    "The approved English source is canonical. Translate it faithfully and do not independently fact-check, weaken, strengthen or edit its meaning. Preserve claims, qualifications, comparisons, numbers, negation, entities and sources exactly.",
    "",
    "LANGUAGE & REGISTER:",
    `- ${brief.languageRegister}.`,
    `- ${brief.codeSwitchingRule}`,
    "",
    brandProfile ? ["BRAND VOICE (compact):", brandProfile].join("\n") : "",
    "",
    "REQUIRED PROJECT GLOSSARY:",
    buildTranslationGlossaryPrompt(),
    "",
    "STRUCTURED OUTPUT CONTRACT (strict JSON):",
    "Return exactly one JSON object with a \"units\" array. Provide EXACTLY one translated unit for every sourceUnitId in the ASSIGNED SOURCE UNITS (the units listed in the user message under \"SOURCE UNITS (English):\"), in the same order. Do not add, omit, duplicate, reorder or invent sourceUnitIds.",
    "The complete English article in the user message is READ-ONLY CONTEXT ONLY. Translate ONLY the ASSIGNED SOURCE UNITS. Never return, add, modify or translate a unit outside the ASSIGNED set, even though the full article is provided for comparison.",
    "Each unit must be one of:",
    '- { "sourceUnitId": "...", "text": "..." }  for metadata, headings and FAQ questions',
    '- { "sourceUnitId": "...", "block": { ... } }  for editorial blocks — preserve block type, inline node structure, href URLs and numbers exactly',
    '- { "sourceUnitId": "...", "answerHtml": "...", "answerText": "..." }  for FAQ answers',
    "STRUCTURAL PRESERVATION (mandatory): Every returned unit MUST copy its assigned `sourceUnitId`, `type` and structural fields exactly. A paragraph must stay a paragraph; a list keeps the exact same item count; a table keeps the exact header/row dimensions; a subheading keeps its level; inline `link` nodes keep the same position and href. Never merge, split, retype, reorder, drop or restructure a unit. A paragraph must never become a list, table, heading or other block type.",
    "EXAMPLES ARE LANGUAGE-ONLY: the approved B2I style examples and the retrieved Cantonese corpus examples in the user message demonstrate LANGUAGE ONLY (natural phrasing and register). They must NEVER influence the JSON shape, block type, list/table dimensions, or inline structure of any returned unit. Do not copy their presentation or flatten link-bearing source lines into plain text.",
    "Preserve every URL, number, percentage, date, brand and proper noun exactly.",
    "Protected numbers are encoded as `__NUM_n__` placeholder tokens. Preserve EVERY `__NUM_n__` token exactly and in the exact place a number should appear — never expand, translate, reorder, remove, duplicate or invent any placeholder token.",
    "SOURCE-REFERENCE LINES: when a unit is a source citation line that begins with 「來源：」 / 「資料來源：」 / \"Source:\" and contains a link, translate the source title inside the link into a faithful, natural Traditional Chinese display title. Keep the href URL byte-for-byte unchanged and keep the inline `link` node in the exact same position within the block (the block must remain `paragraph` with the same inline node sequence). Do not show the English original title beside the Chinese title, and never flatten the link into plain text.",
    "Do not translate href URLs, do not add new URLs, do not generate WordPress structure, schema, CTA HTML or additional sections, and do not add explanations or commentary.",
    "Return ONLY the final verified translation JSON object (the assigned units). No markdown fences, no drafts, no explanations, findings, review notes or commentary before or after.",
  ].join("\n");
}

/** User prompt carrying the COMPLETE read-only English article, the silent internal
 *  verification step, and the ASSIGNED source units this call must translate. */
export function buildDocumentContextShadowUserPrompt(
  brief: DocumentBrief,
  chunk: TranslationChunk,
  sourceDoc: TranslationSourceDocument,
  previousContext: string,
  styleExamples = "",
): string {
  const terminologyGuidance = buildAvoidedTerminologyGuidance([chunkSourceText(chunk)], { includeAll: true });
  return [
    "Translate the ASSIGNED English source units below into natural Hong Kong Traditional Chinese (zh-HK), preserving the canonical meaning and all protected content.",
    "",
    terminologyGuidance ? ["", terminologyGuidance].join("\n") : "",
    "",
    styleExamples ? ["", styleExamples].join("\n") : "",
    "",
    "COMPLETE ENGLISH ARTICLE (READ-ONLY CONTEXT ONLY — for internal comparison and continuity; NEVER translate, return or modify units from this list):",
    serializeFullEnglishArticleContext(sourceDoc),
    "",
    "SILENT INTERNAL VERIFICATION (perform internally before you return; NEVER output this step, any draft, findings or notes):",
    "Before returning the JSON, compare every assigned translation directly against its immutable English source and correct ANY of the following issues:",
    "- literal English sentence structures that do not read naturally in Cantonese;",
    "- unnatural Hong Kong Cantonese phrasing;",
    "- Mainland Chinese terminology (e.g. 營銷-based terms such as 網紅營銷);",
    "- excessive slang;",
    "- formal written-Chinese wording that conflicts with the required conversational Cantonese register;",
    "- terminology inconsistent with the REQUIRED PROJECT GLOSSARY;",
    "- untranslated English left in any unit;",
    "- any added, removed, weakened or strengthened meaning, certainty, comparison, claim, example or number.",
    "Preserve source unit IDs, order, paragraph purpose, facts, examples, certainty, names, numbers, URLs and formatting exactly.",
    "Translate ONLY the ASSIGNED SOURCE UNITS below. Never return, add, modify or translate a unit outside the ASSIGNED set, even though the complete English article is provided as context.",
    "Return ONLY the final verified translation JSON (the assigned units). No drafts, explanations, findings, review notes, markdown or commentary.",
    "",
    "PREVIOUS TRANSLATED CONTEXT (for continuity):",
    previousContext ? previousContext : "(none — this is the first chunk)",
    "",
    "SOURCE UNITS (English):",
    serializeShadowChunkUnits(chunk),
    "",
    "Return the structured JSON translation as specified.",
  ].join("\n");
}

/** Full messages (system + user) for one shadow chunk. */
export function buildDocumentContextShadowMessages(
  brief: DocumentBrief,
  chunk: TranslationChunk,
  sourceDoc: TranslationSourceDocument,
  previousContext: string,
  styleExamples = "",
  brandProfile = "",
): ChatMessage[] {
  return [
    { role: "system", content: buildDocumentContextShadowSystemPrompt(brief, brandProfile) },
    { role: "user", content: buildDocumentContextShadowUserPrompt(brief, chunk, sourceDoc, previousContext, styleExamples) },
  ];
}

// ── Bilingual whole-document editorial polish ──

function serializeEditorialUnits(units: TranslationSourceUnit[]): string {
  return JSON.stringify(units.map((unit) => {
    switch (unit.type) {
      case "faq-answer":
        return { sourceUnitId: unit.sourceId, answerHtml: unit.answerHtml, answerText: unit.answerText };
      case "introduction-block":
      case "section-block":
      case "conclusion-block":
        return { sourceUnitId: unit.sourceId, block: unit.block };
      case "cta":
        return { sourceUnitId: unit.sourceId, html: unit.html, protected: true };
      default:
        return { sourceUnitId: unit.sourceId, text: unit.text };
    }
  }));
}

/** System prompt for the bilingual whole-document editorial polish (compact brief + patch contract). */
export function buildShadowEditorialSystemPrompt(brief?: DocumentBrief, brandPrinciples = ""): string {
  const lines: string[] = [
    "You are a senior Hong Kong Cantonese editor improving the natural flow and register of a translated article.",
    "The approved English source is canonical. Improve ONLY style and naturalness; do not add, remove, weaken, soften or fact-check claims, numbers, URLs, brands, headings, FAQ count or document structure.",
  ];
  if (brief) {
    lines.push(
      "",
      "DOCUMENT BRIEF:",
      `- English title: ${brief.englishTitle}`,
      brief.focusKeyphrase ? `- Focus keyphrase: ${brief.focusKeyphrase}` : "- Focus keyphrase: (none)",
      "- Heading outline:",
      (brief.headingOutline.length ? brief.headingOutline : ["(none)"]).map((h, i) => `  ${i + 1}. ${h}`).join("\n"),
      `- Language/register: ${brief.languageRegister}`,
      `- ${brief.codeSwitchingRule}`,
    );
  }
  if (brandPrinciples) {
    lines.push("", "BRAND VOICE PRINCIPLES:", brandPrinciples);
  }
  lines.push(
    "",
    "PATCH CONTRACT (return ONLY changed units, as a single JSON object):",
    '- Return { "units": [ ... ], "resolvedFindingTokens": [ "F001", ... ], "reviewedUnchangedFindings": [ { "findingToken": "F002", "reasonCode": "natural-already" }, ... ] }.',
    "- \"units\" must contain ONLY the units you edited; omit unchanged units.",
    "- Each returned unit must be one of:",
    '  - { "sourceUnitId": "...", "text": "..." }  for metadata, headings and FAQ questions',
    '  - { "sourceUnitId": "...", "block": { ... } }  for editorial blocks (preserve block type, inline-node structure, href URLs and numbers exactly)',
    '  - { "sourceUnitId": "...", "answerHtml": "...", "answerText": "..." }  for FAQ answers',
    "- Every returned sourceUnitId must belong to the current batch. No unknown, duplicated or malformed IDs.",
    "- Preserve every protected number placeholder `__NUM_n__`, URL, HTML attribute, brand and inline-node structure exactly. Do not edit CTA/schema/language-switcher content.",
    "- Every supplied finding token must appear in exactly one accounting array:",
    '    "resolvedFindingTokens" — ONLY findings whose unit you genuinely improved with a real text change (a byte-identical patch is not a change);',
    '    "reviewedUnchangedFindings" — findings you deliberately left unchanged, each with exactly one valid "reasonCode": natural-already | preferred-absent | context-conflict | source-fidelity.',
    "- Return only supplied tokens. Never invent, renumber or reconstruct tokens.",
    "- Return ONLY the JSON object. No markdown, no prose, no reasoning or commentary.",
    "",
    "AUDIENCE & VOICE:",
    "- Write for a professional Hong Kong business blog in natural spoken-style Cantonese, without becoming slang-heavy.",
    "- Prioritize clarity and native phrasing over literal English sentence structure.",
    "- Keep terminology consistent; avoid formal written-Chinese wording inside otherwise Cantonese prose.",
    "- Avoid Mainland Chinese terminology (e.g. 視頻, 質檢, 營銷平台).",
    "",
    "TERMINOLOGY POLICY (use these preferred terms consistently):",
    "- 創作者市場推廣 for influencer/creator marketing",
    "- 創作者 for creator/influencer",
    "- 推廣活動 for campaign",
    "- 互動 or 互動率 for engagement",
    "- 讚好 for Like/likes; 儲存 for saves; 分享 for shares; 留言 for comments",
    "- 合作簡報 for brief; 收費表 or 價目表 for rate card; 有效 for work/works",
    "- 關鍵意見領袖 only when the English source explicitly says KOL",
    "- English brand and platform names stay unchanged: Instagram, YouTube, TikTok, WeChat, YKONE, Open Influence, Assembly, StarNgage, Luna, B2I Hub, B2C, KPI, Reel.",
    "",
    buildTerminologyPolicyPrompt(),
    "",
    "BILINGUAL REVISION FOCUS (do this internally before returning the patch):",
    "Compare every Cantonese unit directly with its immutable English source. Correct meaning drift, missing subjects/objects/head nouns, changed actors/recipients, changed numbers or certainty, changed comparisons, mistranslated business concepts, literal English sentence structure, terminology mistakes and incomplete phrases. Require full-sentence rewriting when meaning cannot be corrected safely with a small edit.",
    "SOURCE-REFERENCE LINES: localize the source title inside each 「來源：」 citation link into a faithful, natural Traditional Chinese display title; keep the href byte-for-byte; never show the English original beside the Chinese title.",
    "Do not perform a broad full-document style review here; that is handled by the final proofread.",
    "",
    buildCantoneseStyleExamplePrompt(),
  );
  return lines.join("\n");
}

/** User prompt for one editorial batch: current-batch EN + ZH units plus bounded context. */
export function buildShadowEditorialBatchUserPrompt(
  sourceUnits: TranslationSourceUnit[],
  protectedCandidateUnits: TranslationSourceUnit[],
  previousContext: string,
  nextHeading: string,
  qualityHints = "",
  styleExamples = "",
  findingsPrompt = "",
): string {
  const hintSection = qualityHints
    ? ["", qualityHints].join("\n")
    : "";
  const examplesSection = styleExamples
    ? ["", styleExamples, "Compare the draft's naturalness and structure against these examples and improve it where the current draft is awkward or less natural."].join("\n")
    : "";
  const findingsSection = findingsPrompt
    ? ["", findingsPrompt].join("\n")
    : "";
  const terminologyGuidance = buildAvoidedTerminologyGuidance(protectedCandidateUnits.map((u) => unitVisibleText(u)));
  return [
    hintSection,
    findingsSection,
    terminologyGuidance ? ["", terminologyGuidance].join("\n") : "",
    examplesSection,
    "PREVIOUS CONTEXT (from the preceding batch, for continuity):",
    previousContext ? previousContext : "(none — first batch)",
    "",
    "NEXT CONTEXT (first heading of the following batch):",
    nextHeading ? nextHeading : "(none — final batch)",
    "",
    "IMMUTABLE ENGLISH SOURCE UNITS (current batch, canonical):",
    serializeEditorialUnits(sourceUnits),
    "",
    "CURRENT CHINESE CANDIDATE UNITS (current batch, edit these; numbers are protected as __NUM_n__ placeholders):",
    serializeEditorialUnits(protectedCandidateUnits),
    "",
    "Return ONLY the units you changed, as the JSON patch contract above. When findings were supplied, account for every token EXACTLY once in resolvedFindingTokens OR reviewedUnchangedFindings (each with a valid reasonCode). Never return an unchanged unit.",
  ].join("\n");
}

/** Full messages (system + user) for one editorial batch. */
export function buildShadowEditorialBatchMessages(
  brief: DocumentBrief,
  sourceUnits: TranslationSourceUnit[],
  protectedCandidateUnits: TranslationSourceUnit[],
  previousContext: string,
  nextHeading: string,
  qualityHints = "",
  styleExamples = "",
  findingsPrompt = "",
  brandPrinciples = "",
): ChatMessage[] {
  return [
    { role: "system", content: buildShadowEditorialSystemPrompt(brief, brandPrinciples) },
    { role: "user", content: buildShadowEditorialBatchUserPrompt(sourceUnits, protectedCandidateUnits, previousContext, nextHeading, qualityHints, styleExamples, findingsPrompt) },
  ];
}

// ── Full-document monolingual proofread (final editorial call) ──
// A clean, independent senior Hong Kong Cantonese proofread of the complete
// revised Chinese document. It receives NO full English prose beside each unit
// (to prevent it copying English syntax) — only compact immutable constraints
// protecting names, numbers, URLs, source-reference IDs, approved terminology,
// protected tokens and factual claims.

/** Compact immutable constraints for the monolingual proofread. */
export function buildMonolingualConstraints(
  opts: {
    hasSourceReferences?: boolean;
    protectedTokens?: string[];
  } = {},
): string {
  const lines: string[] = [
    "IMMUTABLE CONSTRAINTS (apply these; never rewrite or translate English content):",
    "- Preserve every name, brand, platform, acronym and proper noun exactly.",
    "- Preserve every number, percentage, date and currency value exactly.",
    "- Preserve every URL, link and href exactly; never add or remove links.",
    "- Preserve every protected token (`__NUM_n__`) and inline structure exactly.",
  ];
  if (opts.hasSourceReferences) {
    lines.push("- Source-reference lines: keep the 「來源：」 label and the link; you may improve the localized display title only, never change the URL or show the English original beside it.");
  }
  lines.push("- Never change the meaning, certainty, quantity, comparison, actor, recipient or factual claims of the article.");
  lines.push("- Do NOT translate the article from English again; the document is already Chinese. You are proofreading the Chinese.");
  return lines.join("\n");
}

/** System prompt for the monolingual full-document proofread. */
export function buildShadowMonolingualSystemPrompt(registerGuidance = ""): string {
  return [
    "You are a senior Hong Kong Cantonese editor performing a final full-document proofread of an already-translated Traditional Chinese (zh-HK) business blog.",
    "Your job is NOT to translate English again. The document is already Chinese. Improve its naturalness as independent Hong Kong business writing.",
    "",
    "FINAL PROOFREAD SCOPE:",
    "- natural Hong Kong Cantonese",
    "- professional but conversational business tone",
    "- consistent register across every section",
    "- awkward collocations",
    "- mixed spoken and written-Chinese grammar",
    "- non-Hong-Kong terminology",
    "- excessive slang",
    "- repeated sentence patterns",
    "- malformed or incomplete sentences",
    "- inconsistent terminology",
    "- unnatural headings",
    "- punctuation and spacing",
    "- cross-section flow and consistency",
    "",
    "Require complete sentence rewriting when a sentence is malformed, awkward or unnatural.",
    "",
    "EDITORIAL STANDARD (advisory findings):",
    "- Improve awkward but publishable wording when a clearer, more natural and more professional Hong Kong Cantonese version is available.",
    "- Leave a finding unchanged only when the current wording is already natural, professional and consistent with the B2I Hub voice.",
    "- Never return a unit in `units` unless its reader-facing content has actually changed. Never echo an unchanged unit.",
    "",
    registerGuidance ? ["REGISTER GUIDANCE (zh-HK):", registerGuidance].join("\n") : "",
    "",
    "PATCH CONTRACT (return ONLY changed units, as a single JSON object):",
    `- Every patch contains "${EDITORIAL_PATCH_UNIT_KEY}".`,
    `- Copy ${EDITORIAL_PATCH_UNIT_KEY} exactly from the supplied document. Never rename, shorten, reconstruct or translate it.`,
    '- Each unit is one of: { "sourceUnitId": "...", "text": "..." } for metadata/headings/FAQ questions; { "sourceUnitId": "...", "block": { ... } } for editorial blocks; { "sourceUnitId": "...", "answerHtml": "...", "answerText": "..." } for FAQ answers.',
    `- Every returned ${EDITORIAL_PATCH_UNIT_KEY} must exist in the document. No unknown, duplicated or malformed IDs.`,
    `- Each ${EDITORIAL_PATCH_UNIT_KEY} may appear at most ONCE in units. Review every finding for a unit together and return ONE consolidated revision per unit; never return separate revisions for separate findings.`,
    "- Unchanged units must not appear in units.",
    "- Preserve every protected number placeholder `__NUM_n__`, URL, HTML attribute, brand and inline-node structure exactly.",
    "- Do not edit CTA, schema or language-switcher content.",
    "- Rewrite units only when their reader-facing Chinese content genuinely changes.",
    "- Do not report which findings were resolved — the application determines resolution by comparing the final document with the supplied findings.",
    '- For every finding you deliberately leave unchanged, include its finding token in "reviewedUnchangedFindings" with exactly one valid "reasonCode": natural-already | preferred-absent | context-conflict | source-fidelity. Do not invent other reasons.',
    "- Return only supplied tokens. Never invent, renumber or reconstruct tokens.",
    "- Return ONLY the JSON object. No markdown, no prose, no reasoning or commentary.",
    "",
    "Example (one unit improved, one deliberately unchanged):",
    '{ "units": [ { "sourceUnitId": "section.3.block.2", "block": { "id": "zh-section-3-wp-2", "type": "paragraph", "content": [ { "type": "text", "text": "整合所有相關問題後嘅單一最終版本" } ] } } ], "reviewedUnchangedFindings": [ { "findingToken": "F011", "reasonCode": "natural-already" } ] }',
  ].join("\n");
}

/** User prompt for the monolingual proofread: full revised Chinese units + compact constraints. */
export function buildShadowMonolingualUserPrompt(
  chineseUnits: TranslationSourceUnit[],
  constraints: string,
  terminologyLedger: string,
  monolingualFindingsPrompt = "",
): string {
  const sections: string[] = [];
  if (monolingualFindingsPrompt) sections.push(monolingualFindingsPrompt);
  const terminologyGuidance = buildAvoidedTerminologyGuidance(chineseUnits.map((u) => unitVisibleText(u)), { includeAll: true });
  if (terminologyGuidance) sections.push(terminologyGuidance);
  if (terminologyLedger) sections.push(terminologyLedger);
  sections.push(constraints);
  sections.push(
    "COMPLETE REVISED CHINESE DOCUMENT UNITS (proofread these; numbers are protected as __NUM_n__ placeholders):",
    serializeEditorialUnits(chineseUnits),
  );
  sections.push(
    "Return ONLY the units you changed, as the JSON patch contract above. Do not report which findings were resolved — the application determines that from the final document. For every finding you deliberately leave unchanged, include its finding token in reviewedUnchangedFindings with one valid reasonCode. Never return an unchanged unit.",
  );
  return sections.join("\n\n");
}

/** Full messages (system + user) for the monolingual proofread. */
export function buildShadowMonolingualMessages(
  chineseUnits: TranslationSourceUnit[],
  opts: {
    constraints: string;
    terminologyLedger: string;
    monolingualFindingsPrompt?: string;
    registerGuidance?: string;
  },
): ChatMessage[] {
  return [
    { role: "system", content: buildShadowMonolingualSystemPrompt(opts.registerGuidance) },
    { role: "user", content: buildShadowMonolingualUserPrompt(chineseUnits, opts.constraints, opts.terminologyLedger, opts.monolingualFindingsPrompt) },
  ];
}
