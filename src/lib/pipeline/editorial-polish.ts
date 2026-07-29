// ── Atomic editorial-polish stage ──
// AI may propose block-level edits. Code owns target resolution, parsing,
// protection, validation and the final commit/reject decision.

import {
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  type EditorialBlock,
  countCanonicalVisibleWords,
  fingerprintHtml,
  parseArticleDocumentFromHtml,
  parseWordPressEditorialBlocks,
  renderArticleDocument,
  renderEditorialBlocksToWordPress,
  extractPlainTextFromEditorialBlocks,
} from "@/lib/blog/article-document";
import type { InlineContent } from "@/lib/blog/article-content";
import { validateEditorialBlocks } from "@/lib/blog/article-content";
import { computeKeyphraseDensity } from "@/lib/content-standards";
import { createNumberExpressionRegex } from "@/lib/services/translation-number-grammar";
import type { ChatMessage, ChatOptions } from "@/lib/services/deepseek";
import {
  countRepeatedIdeaPairs,
  detectMalformedProseTexts,
  editableTextsFromDocument,
} from "@/lib/blog/publication-quality";
import { extractReadableText } from "@/lib/seo/seo-text-utils";

export function isEditorialPolishEnabled(): boolean {
  return process.env.ENABLE_EDITORIAL_POLISH === "true";
}

export type EditablePolishBlockType = "paragraph" | "list" | "subheading";

export interface PolishBlock {
  blockId: string;
  type: EditablePolishBlockType;
  html: string;
}

export interface PolishEdit {
  blockId: string;
  replacementHtml: string;
  reason: string;
}

export interface PolishResponse {
  edits: PolishEdit[];
}

export interface SectionSummary {
  index: number;
  heading: string;
  summary: string;
}

export interface PolishRequest {
  blocks: PolishBlock[];
  sectionSummaries: SectionSummary[];
  keyphrase: string;
  title: string;
  metaDescription: string;
}

export interface CandidateValidation {
  passed: boolean;
  reasons: string[];
}

export interface EditorialPolishOptions {
  validateProductionCandidate?: (candidate: ArticleDocument) => CandidateValidation;
  maxAttempts?: number;
}

export interface EditorialPolishResult {
  accepted: boolean;
  reason: string;
  inputWordCount: number;
  candidateWordCount: number;
  proposedEdits: number;
  appliedEdits: number;
  keyphraseBefore: number;
  keyphraseAfter: number;
  internalLinksBefore: number;
  internalLinksAfter: number;
  externalLinksBefore: number;
  externalLinksAfter: number;
  newNumericClaims: number;
  repeatedParagraphsRemoved: number;
  spacingFixesApplied: number;
  attempts: number;
}

interface EditableTarget {
  publicBlock: PolishBlock;
  componentKind: "introduction" | "section" | "conclusion";
  componentId: string;
  blockIndex: number;
  originalBlock: EditorialBlock;
}

interface LinkRecord {
  href: string;
  anchorText: string;
  blockId: string;
  isInternal: boolean;
}

interface ParsedProposal {
  edits: PolishEdit[];
  recovered: boolean;
}

interface PreparedEdit {
  edit: PolishEdit;
  target: EditableTarget;
  replacementBlock: EditorialBlock;
}

const MAX_EDIT_REASON_LENGTH = 500;
const MAX_RESPONSE_EDITS_MULTIPLIER = 1;
const ATTRIBUTION_RE = /\b(?:according to|research (?:from|by|shows?)|a study (?:from|by|shows?)|data (?:from|shows?)|industry (?:research|data|insights?) (?:from|shows?)?)/gi;

function cloneDoc(doc: ArticleDocument): ArticleDocument {
  return structuredClone(doc);
}

function stableBlockId(
  kind: EditableTarget["componentKind"],
  componentId: string,
  blockId: string,
): string {
  return `${kind}:${encodeURIComponent(componentId)}:${encodeURIComponent(blockId)}`;
}

function isEditableBlock(block: EditorialBlock): block is Extract<
  EditorialBlock,
  { type: EditablePolishBlockType }
> {
  return block.type === "paragraph" || block.type === "list" || block.type === "subheading";
}

function collectComponentTargets(
  targets: EditableTarget[],
  kind: EditableTarget["componentKind"],
  component: ArticleComponent,
): void {
  for (let blockIndex = 0; blockIndex < component.blocks.length; blockIndex++) {
    const block = component.blocks[blockIndex];
    if (!isEditableBlock(block)) continue;
    const blockId = stableBlockId(kind, component.id, block.id);
    targets.push({
      publicBlock: {
        blockId,
        type: block.type,
        html: renderEditorialBlocksToWordPress([block]),
      },
      componentKind: kind,
      componentId: component.id,
      blockIndex,
      originalBlock: block,
    });
  }
}

function createEditableTargets(doc: ArticleDocument): EditableTarget[] {
  const targets: EditableTarget[] = [];
  collectComponentTargets(targets, "introduction", doc.introduction);
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;
    collectComponentTargets(targets, "section", section);
  }
  collectComponentTargets(targets, "conclusion", doc.conclusion);
  return targets;
}

export function extractEditableBlocks(doc: ArticleDocument): PolishBlock[] {
  return createEditableTargets(doc).map((target) => target.publicBlock);
}

function summarizeBlocks(blocks: EditorialBlock[], maxLength = 700): string {
  return extractPlainTextFromEditorialBlocks(blocks)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildSectionSummaries(doc: ArticleDocument): SectionSummary[] {
  const summaries: SectionSummary[] = [
    {
      index: 0,
      heading: "Introduction",
      summary: summarizeBlocks(doc.introduction.blocks),
    },
  ];

  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading" || section.sectionType === "conclusion-heading") continue;
    summaries.push({
      index: summaries.length,
      heading: section.heading,
      summary: summarizeBlocks(section.blocks),
    });
  }

  summaries.push({
    index: summaries.length,
    heading: "Conclusion",
    summary: summarizeBlocks(doc.conclusion.blocks),
  });
  return summaries;
}

export function buildPolishPrompt(request: PolishRequest): ChatMessage[] {
  const systemPrompt = `You are the senior copy editor for a Hong Kong-focused SEO article.

Read all supplied blocks before proposing edits. The article was generated section by section, so make it read as one coherent, professionally written article.

Your authority is deliberately narrow:
- Return only JSON: {"edits":[{"blockId":"...","replacementHtml":"...","reason":"..."}]}.
- Return a complete replacement for one existing editable block per edit.
- Edit only supplied paragraph, list and existing H3 block IDs.
- Preserve the block type. A paragraph stays one paragraph. An H3 stays one H3. A list keeps its ordered/unordered type and the same number of items.
- Do not return the whole article. Do not add, remove, merge, split or reorder blocks.
- Do not edit H2 headings, FAQ, FAQ schema, CTA, language switcher, conclusion markers, title, slug or metadata.
- Preserve every href exactly and in the same order. Anchor wording may improve.
- Preserve every number, percentage, currency, date, time, named source and factual attribution exactly.
- Do not rewrite a sentence containing a number, factual attribution or link. The only permitted change inside a linked sentence is clearer anchor wording.
- Do not invent facts, statistics, sources, studies, links, product features or platform rules.
- If two blocks appear to conflict factually, leave the factual wording unchanged for the deterministic research stage to handle.
- Repair broken fragments, unmatched quotation marks or parentheses, missing words and malformed sentences.
- Remove repeated explanations by keeping the strongest explanation and turning the weaker block into useful, specific guidance or a natural transition. Never leave an empty or filler block.
- Keep recommendations consistent across sections. If a recommendation contains a protected number, do not try to reconcile it; leave it for the deterministic factual gate.
- Treat conclusion blocks as a concise synthesis only: do not introduce a new example, tactic, recommendation, platform feature or factual claim there.
- Vary sentence openings and remove robotic phrases such as "The key is", "Remember", "That's why", "That's the beauty of" and "Think of it as".
- Proofread every replacement character by character. Reject corrupt tokens, accidental word joins and unfinished fragments.
- Use Hong Kong context only when it is genuinely relevant. Avoid repeatedly dropping district names into generic examples.
- Reduce forced exact-keyphrase repetition. Do not add another occurrence of "${request.keyphrase}".
- Keep the total article word count within 10% of the original.
- Make every replacement valid WordPress block HTML with its matching opening and closing block comments.

If no block needs editing, return {"edits":[]}.`;

  const userPayload = {
    article: {
      title: request.title,
      metaDescription: request.metaDescription,
      focusKeyphrase: request.keyphrase,
    },
    sectionMemory: request.sectionSummaries,
    editableBlocks: request.blocks,
  };

  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Edit the article using the rules above.\n\n${JSON.stringify(userPayload)}\n\nReturn only the JSON edits object.`,
    },
  ];
}

function parsePolishResponse(content: string): ParsedProposal {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let parsed: unknown;
  let recovered = false;
  let parsedOk = false;
  for (let i = 0; i < candidates.length; i++) {
    try {
      parsed = JSON.parse(candidates[i]);
      recovered = i > 0;
      parsedOk = true;
      break;
    } catch {
      // Try the next deterministic wrapper recovery.
    }
  }
  if (!parsedOk) throw new Error("Invalid JSON response from AI");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Editorial response must be a JSON object");
  }

  const root = parsed as Record<string, unknown>;
  const unknownRootKeys = Object.keys(root).filter((key) => key !== "edits");
  if (unknownRootKeys.length > 0) {
    throw new Error(`Editorial response contains unknown fields: ${unknownRootKeys.join(", ")}`);
  }
  const edits = root.edits;
  if (!Array.isArray(edits)) throw new Error("Editorial response is missing an edits array");

  const normalized: PolishEdit[] = edits.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Edit ${index} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    const unknownEditKeys = Object.keys(value).filter(
      (key) => !["blockId", "replacementHtml", "reason"].includes(key),
    );
    if (unknownEditKeys.length > 0) {
      throw new Error(`Edit ${index} contains unknown fields: ${unknownEditKeys.join(", ")}`);
    }
    if (typeof value.blockId !== "string" || !value.blockId.trim()) {
      throw new Error(`Edit ${index} has an invalid blockId`);
    }
    if (typeof value.replacementHtml !== "string" || !value.replacementHtml.trim()) {
      throw new Error(`Edit ${index} has empty replacementHtml`);
    }
    if (typeof value.reason !== "string" || !value.reason.trim()) {
      throw new Error(`Edit ${index} has an invalid reason`);
    }
    if (value.reason.length > MAX_EDIT_REASON_LENGTH) {
      throw new Error(`Edit ${index} reason is too long`);
    }
    return {
      blockId: value.blockId,
      replacementHtml: value.replacementHtml.trim(),
      reason: value.reason.trim(),
    };
  });

  return { edits: normalized, recovered };
}

function inlineGroups(block: EditorialBlock): InlineContent[][] {
  if (block.type === "list") return block.items;
  if (block.type === "table") return [...block.headers, ...block.rows.flat()];
  return [block.content];
}

function linksFromBlock(block: EditorialBlock): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  for (const group of inlineGroups(block)) {
    for (const inline of group) {
      if (inline.type === "link") links.push({ href: inline.href, text: inline.text });
    }
  }
  return links;
}

function textFromBlock(block: EditorialBlock): string {
  return extractPlainTextFromEditorialBlocks([block]);
}

function extractNumbers(text: string): string[] {
  return [...text.matchAll(createNumberExpressionRegex("gi"))].map((match) =>
    match[0].replace(/\s+/g, " ").toLowerCase(),
  );
}

export function extractNumericClaims(html: string): string[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  return extractNumbers(text);
}

function extractAttributions(text: string): string[] {
  return [...text.matchAll(new RegExp(ATTRIBUTION_RE.source, "gi"))].map((match) =>
    match[0].replace(/\s+/g, " ").toLowerCase(),
  );
}

function protectedFactSentences(block: EditorialBlock): string[] {
  let linkIndex = 0;
  const groupTexts = inlineGroups(block).map((group) =>
    group.map((inline) => {
      if (inline.type === "link") return ` __B2I_LINK_${linkIndex++}__ `;
      return inline.text;
    }).join(""),
  );
  const sentences = groupTexts.flatMap(
    (text) => text.match(/[^.!?]+(?:[.!?]+(?:["”’)]*)|$)/g) ?? [],
  );
  return sentences
    .filter((sentence) =>
      /__B2I_LINK_\d+__/.test(sentence)
      || extractNumbers(sentence).length > 0
      || new RegExp(ATTRIBUTION_RE.source, "i").test(sentence),
    )
    .map((sentence) => sentence.replace(/\s+/g, " ").trim().toLowerCase());
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseReplacement(edit: PolishEdit, target: EditableTarget): EditorialBlock {
  const parsed = parseWordPressEditorialBlocks(edit.replacementHtml, `editorial-polish-${target.originalBlock.id}`);
  if (parsed.errors.length > 0) {
    throw new Error(`${edit.blockId}: ${parsed.errors.join("; ")}`);
  }
  if (parsed.warnings.length > 0) {
    throw new Error(`${edit.blockId}: ${parsed.warnings.join("; ")}`);
  }
  if (parsed.blocks.length !== 1) {
    throw new Error(`${edit.blockId}: replacement must contain exactly one WordPress block`);
  }

  const replacement = parsed.blocks[0];
  if (replacement.type !== target.originalBlock.type) {
    throw new Error(
      `${edit.blockId}: block type changed from ${target.originalBlock.type} to ${replacement.type}`,
    );
  }
  if (!isEditableBlock(replacement)) {
    throw new Error(`${edit.blockId}: unsupported replacement block type`);
  }
  if (
    target.originalBlock.type === "list"
    && replacement.type === "list"
    && (
      target.originalBlock.ordered !== replacement.ordered
      || target.originalBlock.items.length !== replacement.items.length
    )
  ) {
    throw new Error(`${edit.blockId}: list structure changed`);
  }

  const originalLinks = linksFromBlock(target.originalBlock).map((link) => link.href);
  const replacementLinks = linksFromBlock(replacement).map((link) => link.href);
  if (!sameStrings(originalLinks, replacementLinks)) {
    throw new Error(`${edit.blockId}: href values or link count changed`);
  }

  const originalNumbers = extractNumbers(textFromBlock(target.originalBlock));
  const replacementNumbers = extractNumbers(textFromBlock(replacement));
  if (!sameStrings(originalNumbers, replacementNumbers)) {
    throw new Error(`${edit.blockId}: numeric facts changed`);
  }

  const originalAttributions = extractAttributions(textFromBlock(target.originalBlock));
  const replacementAttributions = extractAttributions(textFromBlock(replacement));
  for (const attribution of replacementAttributions) {
    if (!originalAttributions.includes(attribution)) {
      throw new Error(`${edit.blockId}: new factual attribution introduced`);
    }
  }

  if (
    !sameStrings(
      protectedFactSentences(target.originalBlock),
      protectedFactSentences(replacement),
    )
  ) {
    throw new Error(
      `${edit.blockId}: sentence containing a number, attribution or link was rewritten`,
    );
  }

  replacement.id = target.originalBlock.id;
  const blockErrors = validateEditorialBlocks([replacement]);
  if (blockErrors.length > 0) {
    throw new Error(`${edit.blockId}: ${blockErrors.join("; ")}`);
  }
  return replacement;
}

function prepareEdits(doc: ArticleDocument, edits: PolishEdit[]): PreparedEdit[] {
  const targets = createEditableTargets(doc);
  const byId = new Map(targets.map((target) => [target.publicBlock.blockId, target]));
  if (edits.length > targets.length * MAX_RESPONSE_EDITS_MULTIPLIER) {
    throw new Error(`Editorial response contains too many edits (${edits.length})`);
  }

  const seen = new Set<string>();
  return edits.map((edit) => {
    if (seen.has(edit.blockId)) throw new Error(`Duplicate edit for ${edit.blockId}`);
    seen.add(edit.blockId);
    const target = byId.get(edit.blockId);
    if (!target) throw new Error(`Unknown or protected blockId: ${edit.blockId}`);
    return {
      edit,
      target,
      replacementBlock: parseReplacement(edit, target),
    };
  });
}

function resolveComponent(
  doc: ArticleDocument,
  target: EditableTarget,
): ArticleComponent | ArticleSection {
  if (target.componentKind === "introduction") return doc.introduction;
  if (target.componentKind === "conclusion") return doc.conclusion;
  const section = doc.sections.find((item) => item.id === target.componentId);
  if (!section) throw new Error(`Section disappeared while applying ${target.publicBlock.blockId}`);
  return section;
}

export function applyEdits(doc: ArticleDocument, edits: PolishEdit[]): ArticleDocument {
  const prepared = prepareEdits(doc, edits);
  const clone = cloneDoc(doc);
  for (const item of prepared) {
    const component = resolveComponent(clone, item.target);
    const current = component.blocks[item.target.blockIndex];
    if (!current || current.id !== item.target.originalBlock.id) {
      throw new Error(`Stable block target changed: ${item.edit.blockId}`);
    }
    component.blocks[item.target.blockIndex] = structuredClone(item.replacementBlock);
  }
  return clone;
}

function isWordChar(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizeInlineSpacing(content: InlineContent[]): number {
  let repairs = 0;
  for (let index = 1; index < content.length; index++) {
    const previous = content[index - 1];
    const current = content[index];
    const previousText = previous.text;
    const currentText = current.text;
    if (!previousText || !currentText) continue;
    if (
      isWordChar(previousText.slice(-1))
      && isWordChar(currentText.charAt(0))
      && !/\s$/.test(previousText)
      && !/^\s/.test(currentText)
    ) {
      if (previous.type === "text") previous.text += " ";
      else current.text = ` ${current.text}`;
      repairs++;
    }
  }
  return repairs;
}

function repairEditableSpacing(doc: ArticleDocument): number {
  let repairs = 0;
  const components: ArticleComponent[] = [
    doc.introduction,
    ...doc.sections.filter(
      (section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading",
    ),
    doc.conclusion,
  ];
  for (const component of components) {
    for (const block of component.blocks) {
      for (const group of inlineGroups(block)) repairs += normalizeInlineSpacing(group);
    }
  }
  return repairs;
}

export function normalizeLinkSpacing(html: string): string {
  return html
    .replace(/([\p{L}\p{N}])(<a\b)/giu, "$1 $2")
    .replace(/(<\/a>)([\p{L}\p{N}])/giu, "$1 $2");
}

export function normalizeArticleSpacing(html: string): string {
  return normalizeLinkSpacing(html)
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])\s{2,}/g, "$1 ");
}

export function deterministicCleanup(html: string): string {
  return normalizeArticleSpacing(html)
    .replace(/<!--\s*wp:paragraph\s*-->\s*<p>\s*<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi, "");
}

export function extractAllLinks(doc: ArticleDocument): LinkRecord[] {
  const targetByBlockId = new Map(
    createEditableTargets(doc).map((target) => [target.originalBlock.id, target.publicBlock.blockId]),
  );
  const links: LinkRecord[] = [];
  const components: ArticleComponent[] = [doc.introduction, ...doc.sections, doc.conclusion];
  for (const component of components) {
    for (const block of component.blocks) {
      const blockId = targetByBlockId.get(block.id) ?? block.id;
      for (const link of linksFromBlock(block)) {
        links.push({
          href: link.href,
          anchorText: link.text,
          blockId,
          isInternal: link.href.startsWith("/blog/")
            || /^https?:\/\/(?:www\.)?b2ihub\.com\/blog\//i.test(link.href),
        });
      }
    }
  }
  return links;
}

export function countExactKeyphrase(html: string, keyphrase: string): number {
  const target = keyphrase.trim().toLowerCase();
  if (!target) return 0;
  // Strip wp:html blocks so FAQ schema, CTA and language-switcher text
  // (which are application-owned) are excluded from the visible count.
  const stripped = extractReadableText(html);
  const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(target, position)) >= 0) {
    count++;
    position += target.length;
  }
  return count;
}

function canonicalLinkSignature(doc: ArticleDocument): string[] {
  return extractAllLinks(doc).map((link) => `${link.isInternal ? "i" : "e"}:${link.href}`);
}

function structureSignature(doc: ArticleDocument): unknown {
  const componentShape = (component: ArticleComponent) => component.blocks.map((block) => ({
    id: block.id,
    type: block.type,
    listItems: block.type === "list" ? block.items.length : undefined,
    ordered: block.type === "list" ? block.ordered : undefined,
  }));
  return {
    metadata: doc.metadata,
    introduction: { id: doc.introduction.id, blocks: componentShape(doc.introduction) },
    sections: doc.sections.map((section) => ({
      id: section.id,
      heading: section.heading,
      headingLevel: section.headingLevel,
      sectionType: section.sectionType,
      blocks: componentShape(section),
    })),
    conclusion: { id: doc.conclusion.id, blocks: componentShape(doc.conclusion) },
  };
}

function protectedSignature(doc: ArticleDocument): unknown {
  return {
    visibleFaq: doc.visibleFaq.map((e) => ({ question: e.question, answerText: e.answerText })),
    languageSwitcher: doc.languageSwitcher ? { fingerprint: doc.languageSwitcher.fingerprint } : null,
    cta: doc.cta ? { fingerprint: doc.cta.fingerprint } : null,
    faqSchema: doc.faqSchema ? { fingerprint: doc.faqSchema.fingerprint } : null,
  };
}

function repeatedIdeaPairs(doc: ArticleDocument): number {
  return countRepeatedIdeaPairs(editableTextsFromDocument(doc));
}

export function detectMalformedProse(doc: ArticleDocument): string[] {
  const texts = editableTextsFromDocument(doc);
  const issues = detectMalformedProseTexts(texts);
  const blockIds = extractEditableBlocks(doc).map((b) => b.blockId);
  return issues.map((issue, idx) => {
    const match = issue.match(/^text (\d+)/);
    if (match) {
      const ti = parseInt(match[1], 10);
      const blockId = ti < blockIds.length ? blockIds[ti] : `block-${ti}`;
      return issue.replace(/^text \d+/, `block ${blockId}`);
    }
    return issue;
  });
}

export function validateCandidate(
  original: ArticleDocument,
  candidate: ArticleDocument,
  keyphrase: string,
  validateProductionCandidate?: EditorialPolishOptions["validateProductionCandidate"],
): CandidateValidation {
  const reasons: string[] = [];
  if (JSON.stringify(structureSignature(original)) !== JSON.stringify(structureSignature(candidate))) {
    reasons.push("article structure or protected H2/H3 block structure changed");
  }
  if (JSON.stringify(protectedSignature(original)) !== JSON.stringify(protectedSignature(candidate))) {
    reasons.push("FAQ, CTA, schema or language switcher changed");
  }

  const originalLinks = canonicalLinkSignature(original);
  const candidateLinks = canonicalLinkSignature(candidate);
  if (!sameStrings(originalLinks, candidateLinks)) reasons.push("URL destinations or link count changed");

  const inputWordCount = countCanonicalVisibleWords(original);
  const candidateWordCount = countCanonicalVisibleWords(candidate);
  if (Math.abs(candidateWordCount - inputWordCount) > inputWordCount * 0.1) {
    reasons.push(`word count changed by more than 10%: ${inputWordCount} → ${candidateWordCount}`);
  }

  const originalHtml = renderArticleDocument(original);
  const candidateHtml = renderArticleDocument(candidate);
  const keyphraseBefore = countExactKeyphrase(originalHtml, keyphrase);
  const keyphraseAfter = countExactKeyphrase(candidateHtml, keyphrase);
  if (keyphraseAfter > keyphraseBefore) reasons.push("exact keyphrase count increased");
  if (
    candidateWordCount >= 500
    && computeKeyphraseDensity(keyphraseAfter, keyphrase, candidateWordCount) > 3
  ) {
    reasons.push("keyphrase density exceeds 3%");
  }

  const originalNumbers = extractNumericClaims(originalHtml);
  const candidateNumbers = extractNumericClaims(candidateHtml);
  if (!sameStrings(originalNumbers, candidateNumbers)) reasons.push("numeric facts changed");

  if (repeatedIdeaPairs(candidate) > repeatedIdeaPairs(original)) {
    reasons.push("near-duplicate paragraph count increased");
  }
  const malformed = detectMalformedProse(candidate);
  if (malformed.length > 0) reasons.push(...malformed);

  const parsed = parseArticleDocumentFromHtml(candidateHtml, candidate);
  if (!parsed.doc) {
    reasons.push(`WordPress parser rejected candidate: ${parsed.errors.join("; ")}`);
  } else if (fingerprintHtml(renderArticleDocument(parsed.doc)) !== fingerprintHtml(candidateHtml)) {
    reasons.push("WordPress round-trip changed candidate content");
  }

  if (validateProductionCandidate) {
    const production = validateProductionCandidate(candidate);
    if (!production.passed) {
      reasons.push(...production.reasons.map((reason) => `production validation: ${reason}`));
    }
  }

  return { passed: reasons.length === 0, reasons };
}

function resultForFailure(
  articleDoc: ArticleDocument,
  keyphrase: string,
  reason: string,
  proposedEdits: number,
  appliedEdits: number,
  attempts: number,
): { doc: ArticleDocument; result: EditorialPolishResult } {
  const html = renderArticleDocument(articleDoc);
  const links = extractAllLinks(articleDoc);
  const wordCount = countCanonicalVisibleWords(articleDoc);
  const keyphraseCount = countExactKeyphrase(html, keyphrase);
  return {
    doc: articleDoc,
    result: {
      accepted: false,
      reason,
      inputWordCount: wordCount,
      candidateWordCount: wordCount,
      proposedEdits,
      appliedEdits,
      keyphraseBefore: keyphraseCount,
      keyphraseAfter: keyphraseCount,
      internalLinksBefore: links.filter((link) => link.isInternal).length,
      internalLinksAfter: links.filter((link) => link.isInternal).length,
      externalLinksBefore: links.filter((link) => !link.isInternal).length,
      externalLinksAfter: links.filter((link) => !link.isInternal).length,
      newNumericClaims: 0,
      repeatedParagraphsRemoved: 0,
      spacingFixesApplied: 0,
      attempts,
    },
  };
}

export async function runEditorialPolish(
  articleDoc: ArticleDocument,
  keyphrase: string,
  aiCall: (messages: ChatMessage[], options?: ChatOptions) => Promise<{ content: string }>,
  options: EditorialPolishOptions = {},
): Promise<{ doc: ArticleDocument; result: EditorialPolishResult }> {
  const originalHtml = renderArticleDocument(articleDoc);
  const inputWordCount = countCanonicalVisibleWords(articleDoc);
  const keyphraseBefore = countExactKeyphrase(originalHtml, keyphrase);
  const linksBefore = extractAllLinks(articleDoc);
  const internalLinksBefore = linksBefore.filter((link) => link.isInternal).length;
  const externalLinksBefore = linksBefore.filter((link) => !link.isInternal).length;
  const repeatsBefore = repeatedIdeaPairs(articleDoc);
  const maxAttempts = Math.max(1, Math.min(2, options.maxAttempts ?? 2));
  const request: PolishRequest = {
    blocks: extractEditableBlocks(articleDoc),
    sectionSummaries: buildSectionSummaries(articleDoc),
    keyphrase,
    title: articleDoc.metadata.title,
    metaDescription: articleDoc.metadata.metaDescription,
  };
  const baseMessages = buildPolishPrompt(request);
  let previousResponse = "";
  let rejectionReason = "";
  let lastProposedEdits = 0;

  // Pre-processing: detect conclusion numeric claims that do not appear in the
  // main editorial sections. The conclusion must not introduce new unsupported
  // percentages, counts or statistics.
  const conclusionHtml = renderEditorialBlocksToWordPress(articleDoc.conclusion.blocks);
  const sectionHtml = articleDoc.sections
    .filter((s) => s.sectionType !== "faq-heading")
    .map((s) => renderEditorialBlocksToWordPress(s.blocks))
    .join(" ");
  const conclusionNumbers = extractNumericClaims(conclusionHtml);
  const sectionNumbers = extractNumericClaims(sectionHtml);
  const newConclusionClaims = conclusionNumbers.filter((n) => !sectionNumbers.includes(n));
  if (newConclusionClaims.length > 0) {
    console.log(`[editorial-polish] conclusion has ${newConclusionClaims.length} new numeric claim(s): ${newConclusionClaims.join(", ")}`);

    // Try to remove the complete conclusion block containing each new claim.
    // Only removes blocks that aren't the last one (to avoid emptying the conclusion).
    const conclusionBlocks = [...articleDoc.conclusion.blocks];
    const originalBlockCount = conclusionBlocks.length;
    const blocksToRemove = conclusionBlocks
      .map((block, idx) => ({ block, idx, html: renderEditorialBlocksToWordPress([block]) }))
      .filter(({ html }) => extractNumericClaims(html).some((n) => newConclusionClaims.includes(n)))
      .filter(({ idx }) => idx < originalBlockCount - 1 || originalBlockCount <= 1);

    if (blocksToRemove.length > 0 && blocksToRemove.length < originalBlockCount) {
      // Remove offending blocks
      const removeIndices = new Set(blocksToRemove.map((b) => b.idx));
      const remainingBlocks = conclusionBlocks.filter((_, idx) => !removeIndices.has(idx));
      console.log(`[editorial-polish] removed ${blocksToRemove.length} conclusion block(s) containing new numeric claims`);
      articleDoc.conclusion.blocks = remainingBlocks;

      // Re-scan after removal
      const newConcHtml = renderEditorialBlocksToWordPress(articleDoc.conclusion.blocks);
      const remainingClaims = extractNumericClaims(newConcHtml).filter((n) => newConclusionClaims.includes(n));
      if (remainingClaims.length === 0) {
        console.log(`[editorial-polish] all new conclusion numeric claims resolved by block removal`);
      } else {
        console.log(`[editorial-polish] ${remainingClaims.length} claim(s) remain after removal — will attempt AI regeneration`);
        // Fall through to regeneration
      }
    }

    // If removal didn't resolve all claims, try AI regeneration
    const remainingAfterRemoval = extractNumericClaims(renderEditorialBlocksToWordPress(articleDoc.conclusion.blocks))
      .filter((n) => newConclusionClaims.includes(n));
    if (remainingAfterRemoval.length > 0) {
      console.log(`[editorial-polish] regenerating conclusion to resolve ${remainingAfterRemoval.length} remaining new claim(s)`);
      try {
        const regenMsg = `Rewrite the conclusion WITHOUT these unsupported claims: ${remainingAfterRemoval.join(", ")}. Do not invent new statistics, percentages, user counts or dates. Use only information present in the article.`;
        const regenRes = await aiCall(
          [
            { role: "system", content: "You are an editor removing unsupported numeric claims from the conclusion. Return ONLY the cleaned conclusion HTML." },
            { role: "user", content: `${regenMsg}\n\nConclusion:\n${renderEditorialBlocksToWordPress(articleDoc.conclusion.blocks)}` },
          ],
          { maxTokens: 2048, timeoutMs: 60_000 },
        );
        const regenHtml = regenRes.content;
        const regenParsed = parseWordPressEditorialBlocks(regenHtml, "conclusion-regen");
        if (regenParsed.blocks.length > 0) {
          articleDoc.conclusion.blocks = regenParsed.blocks;
          const regenClaims = extractNumericClaims(regenHtml).filter((n) => newConclusionClaims.includes(n));
          if (regenClaims.length > 0) {
            console.log(`[editorial-polish] regenerated conclusion STILL contains ${regenClaims.length} new claim(s) — hard rejection`);
          } else {
            console.log(`[editorial-polish] regenerated conclusion is clean`);
          }
        }
      } catch {
        console.log(`[editorial-polish] conclusion regeneration failed — will proceed with editorial polish`);
      }
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = attempt === 1
      ? baseMessages
      : [
          ...baseMessages,
          { role: "assistant" as const, content: previousResponse },
          {
            role: "user" as const,
            content: `The proposal was rejected atomically for these reasons: ${rejectionReason}. Return a corrected complete edits JSON object. Do not explain.`,
          },
        ];

    let responseContent = "";
    try {
      const response = await aiCall(messages, {
        responseFormat: { type: "json_object" },
        temperature: attempt === 1 ? 0.35 : 0.2,
        maxTokens: 16_384,
        timeoutMs: 120_000,
      });
      responseContent = response.content;
      previousResponse = responseContent;
    } catch {
      rejectionReason = "AI call failed";
      if (attempt === maxAttempts) {
        return resultForFailure(articleDoc, keyphrase, rejectionReason, 0, 0, attempt);
      }
      continue;
    }

    let proposal: ParsedProposal;
    try {
      proposal = parsePolishResponse(responseContent);
      lastProposedEdits = proposal.edits.length;
    } catch (error) {
      rejectionReason = error instanceof Error ? error.message : "Malformed editorial response";
      if (attempt === maxAttempts) {
        return resultForFailure(
          articleDoc,
          keyphrase,
          rejectionReason,
          lastProposedEdits,
          0,
          attempt,
        );
      }
      continue;
    }

    let candidate = cloneDoc(articleDoc);
    let spacingFixesApplied = repairEditableSpacing(candidate);
    try {
      candidate = applyEdits(candidate, proposal.edits);
      spacingFixesApplied += repairEditableSpacing(candidate);
    } catch (error) {
      rejectionReason = error instanceof Error ? error.message : "Invalid editorial edit";
      if (attempt === maxAttempts) {
        return resultForFailure(
          articleDoc,
          keyphrase,
          rejectionReason,
          proposal.edits.length,
          0,
          attempt,
        );
      }
      continue;
    }

    const validation = validateCandidate(
      articleDoc,
      candidate,
      keyphrase,
      options.validateProductionCandidate,
    );
    if (!validation.passed) {
      rejectionReason = validation.reasons.join("; ");
      if (attempt === maxAttempts) {
        return resultForFailure(
          articleDoc,
          keyphrase,
          `Validation failed: ${rejectionReason}`,
          proposal.edits.length,
          0,
          attempt,
        );
      }
      continue;
    }

    const candidateHtml = renderArticleDocument(candidate);
    const linksAfter = extractAllLinks(candidate);
    const candidateNumbers = extractNumericClaims(candidateHtml);
    const originalNumbers = extractNumericClaims(originalHtml);
    return {
      doc: candidate,
      result: {
        accepted: true,
        reason: proposal.recovered ? "accepted after JSON wrapper recovery" : "ok",
        inputWordCount,
        candidateWordCount: countCanonicalVisibleWords(candidate),
        proposedEdits: proposal.edits.length,
        appliedEdits: proposal.edits.length,
        keyphraseBefore,
        keyphraseAfter: countExactKeyphrase(candidateHtml, keyphrase),
        internalLinksBefore,
        internalLinksAfter: linksAfter.filter((link) => link.isInternal).length,
        externalLinksBefore,
        externalLinksAfter: linksAfter.filter((link) => !link.isInternal).length,
        newNumericClaims: candidateNumbers.filter((claim) => !originalNumbers.includes(claim)).length,
        repeatedParagraphsRemoved: Math.max(0, repeatsBefore - repeatedIdeaPairs(candidate)),
        spacingFixesApplied,
        attempts: attempt,
      },
    };
  }

  return resultForFailure(articleDoc, keyphrase, rejectionReason || "Editorial polish failed", 0, 0, maxAttempts);
}
