// ── Editorial-polish stage ──
// Post-assembly AI editing pass that improves coherence, flow and natural
// language without damaging structure, SEO, links, FAQ, CTA or schema.
//
// Transactional: edits are applied to a cloned ArticleDocument. The candidate
// is validated exhaustively. Only if all checks pass is the original replaced.

import { type ArticleDocument, type EditorialBlock, type ArticleSection, renderArticleDocument, fingerprintHtml, parseArticleDocumentFromHtml, renderFaqSchema, parseWordPressEditorialBlocks } from "@/lib/blog/article-document";
import { countReadableWords, countSentences } from "@/lib/seo/seo-text-utils";
import { computeKeyphraseDensity } from "@/lib/content-standards";
import type { ChatMessage, ChatOptions } from "@/lib/services/deepseek";

// ── Feature flag ──

export function isEditorialPolishEnabled(): boolean {
  return process.env.ENABLE_EDITORIAL_POLISH === "true";
}

// ── Types ──

export interface PolishBlock {
  blockId: string;
  type: string;
  html: string;
}

export interface PolishEdit {
  blockId: string;
  replacementHtml: string;
  reason: string;
}

export interface PolishRequest {
  blocks: PolishBlock[];
  sectionSummaries: SectionSummary[];
  keyphrase: string;
  title: string;
  metaDescription: string;
  articleHtml: string;
}

export interface PolishResponse {
  edits: PolishEdit[];
}

export interface SectionSummary {
  index: number;
  heading: string;
  summary: string;
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
}

// ── Extract editable blocks with stable IDs ──

export function extractEditableBlocks(doc: ArticleDocument): PolishBlock[] {
  const blocks: PolishBlock[] = [];
  for (const section of doc.sections) {
    if (section.sectionType === "faq-heading") continue;
    for (let bi = 0; bi < section.blocks.length; bi++) {
      const block = section.blocks[bi];
      if (block.type === "paragraph" || block.type === "subheading") {
        const html = renderSingleBlock(block);
        blocks.push({
          blockId: `section-${section.id.split("-").pop()}-block-${bi}`,
          type: block.type,
          html,
        });
      }
    }
  }
  return blocks;
}

function renderSingleBlock(block: EditorialBlock): string {
  if (block.type !== "paragraph" && block.type !== "subheading" && block.type !== "quote") return "";
  const text = block.content.map((c) => c.type === "link" ? `<a href="${c.href}">${c.text}</a>` : c.text).join("");
  return `<!-- wp:${block.type} --><${block.type}>${text}</${block.type}><!-- /wp:${block.type} -->`;
}

// ── Build section summaries for article memory ──

export function buildSectionSummaries(doc: ArticleDocument): SectionSummary[] {
  return doc.sections
    .filter((s) => s.sectionType !== "faq-heading")
    .map((s, i) => ({
      index: i,
      heading: s.heading,
      summary: s.blocks
        .filter((b) => b.type === "paragraph")
        .map((b) => b.content.map((c) => c.text).join("").substring(0, 150))
        .join(" "),
    }));
}

// ── AI prompt builder ──

export function buildPolishPrompt(request: PolishRequest): ChatMessage[] {
  const blockListing = request.blocks
    .map((b) => `  { "blockId": "${b.blockId}", "type": "${b.type}", "html": "${escapeJson(b.html)}" }`)
    .join(",\n");

  const sectionNotes = request.sectionSummaries
    .map((s) => `Section ${s.index + 1} — "${s.heading}":\n${s.summary}`)
    .join("\n\n");

  const systemPrompt = `You are the senior editor for a Hong Kong-focused SEO article.

Improve coherence, flow and natural language while preserving EVERY URL, WordPress block, FAQ entry, CTA and SEO requirement.

RULES:
- Return ONLY structured JSON: { "edits": [ { "blockId": "...", "replacementHtml": "...", "reason": "..." } ] }
- Each edit targets one block by blockId. Do not return the full article.
- Do NOT edit H2 headings, FAQ blocks, FAQ schema, CTA, language switcher, conclusion markers, or WordPress block comments.
- Do NOT change href values or introduce new links.
- Do NOT add new facts, statistics, percentages, monetary figures, user counts or named studies.
- Remove unsupported claims rather than rewriting them more confidently.
- Preserve every URL exactly.
- Preserve the exact keyphrase "${request.keyphrase}" at least once in the first 100 words and at least once in an H2.
- Keep H2 count unchanged. Keep exact keyphrase count within reasonable bounds.
- Replace robotic phrases: "The key is", "Remember", "That's why", "That's the beauty of", "Think of it as".
- Vary sentence openings. Remove repetition. Improve transitions between sections.
- Make Hong Kong references specific and natural.
- Fix spacing around links: ensure spaces before and after anchor tags.
- Target at most 10% word-count change (up or down).
- Valid block types: paragraph, subheading.`;

  const userPrompt = `Article title: ${request.title}
Meta description: ${request.metaDescription}
Focus keyphrase: ${request.keyphrase}

SECTION SUMMARIES (for coherence across independently generated sections):
${sectionNotes}

EDITABLE BLOCKS (return only edits for these blockIds):
[
${blockListing}
]

Return ONLY the edits JSON object. No prose, no markdown fences, no HTML wrapper.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

function escapeJson(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

// ── Link extraction ──

export interface LinkRecord {
  href: string;
  anchorText: string;
  blockId: string;
  isInternal: boolean;
}

export function extractAllLinks(doc: ArticleDocument): LinkRecord[] {
  const links: LinkRecord[] = [];
  for (const section of doc.sections) {
    const sectionIdx = doc.sections.indexOf(section);
    for (let bi = 0; bi < section.blocks.length; bi++) {
      const block = section.blocks[bi];
      if (block.type === "list") {
        for (const item of block.items) {
          for (const inline of item) {
            if (inline.type === "link") {
              links.push({
                href: inline.href,
                anchorText: inline.text,
                blockId: `section-${section.id.split("-").pop()}-block-${bi}`,
                isInternal: /b2ihub\.com/i.test(inline.href),
              });
            }
          }
        }
      } else if (block.type === "table") {
        for (const headerRow of block.headers) {
          for (const inline of headerRow) {
            if (inline.type === "link") {
              links.push({
                href: inline.href,
                anchorText: inline.text,
                blockId: `section-${section.id.split("-").pop()}-block-${bi}`,
                isInternal: /b2ihub\.com/i.test(inline.href),
              });
            }
          }
        }
        for (const dataRow of block.rows) {
          for (const cell of dataRow) {
            for (const inline of cell) {
              if (inline.type === "link") {
                links.push({
                  href: inline.href,
                  anchorText: inline.text,
                  blockId: `section-${section.id.split("-").pop()}-block-${bi}`,
                  isInternal: /b2ihub\.com/i.test(inline.href),
                });
              }
            }
          }
        }
      } else if ("content" in block) {
        for (const inline of block.content) {
          if (inline.type === "link") {
            links.push({
              href: inline.href,
              anchorText: inline.text,
              blockId: `section-${section.id.split("-").pop()}-block-${bi}`,
              isInternal: /b2ihub\.com/i.test(inline.href),
            });
          }
        }
      }
    }
  }
  return links;
}

// ── Numeric claim detection ──

const NUMERIC_CLAIM_RE = /\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?[%％])|(\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:million|billion|trillion|thousand|users|customers|dollars|HKD|USD|EUR))|((?:HK\$|US\$)\s*\d[\d,.]*)\b/i;

export function extractNumericClaims(html: string): string[] {
  const claims: string[] = [];
  const m = html.match(NUMERIC_CLAIM_RE);
  if (m) claims.push(m[0]);
  return claims;
}

// ── Keyphrase counting ──

export function countExactKeyphrase(html: string, keyphrase: string): number {
  const kp = keyphrase.toLowerCase();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(kp, idx)) !== -1) {
    count++;
    idx += kp.length;
  }
  return count;
}

// ── Link-spacing normalizer (deterministic) ──

export function normalizeLinkSpacing(html: string): string {
  let result = html;
  // space before <a...> if preceded by a word character
  result = result.replace(/(\w)<a\b/gi, "$1 <a");
  // space after </a> if followed by a word character or opening tag
  result = result.replace(/(<\/a>)(\w)/gi, "$1 $2");
  // remove double spaces
  result = result.replace(/  +/g, " ");
  return result;
}

// ── Spacing normalizer for the full article HTML ──

export function normalizeArticleSpacing(html: string): string {
  let result = html;
  // spaces around anchor tags
  result = normalizeLinkSpacing(result);
  // spaces between word characters and inline HTML tags
  result = result.replace(/(\w)(<br\b)/gi, "$1 $2");
  result = result.replace(/(<\/?\w+[^>]*>)(\w)/gi, "$1 $2");
  // duplicate whitespace (within text, not between block elements)
  result = result.replace(/>\s{2,}</g, "> <");
  // normalize punctuation spacing
  result = result.replace(/\s+([.,!?;:])/g, "$1");
  result = result.replace(/([.,!?;:])\s{2,}/g, "$1 ");
  return result;
}

// ── Apply edits to a cloned document ──

export function applyEdits(doc: ArticleDocument, edits: PolishEdit[]): ArticleDocument {
  const clone = JSON.parse(JSON.stringify(doc)) as ArticleDocument;
  for (const edit of edits) {
    const match = edit.blockId.match(/section-(\d+)-block-(\d+)/);
    if (!match) continue;
    const sectionIdx = parseInt(match[1], 10);
    const blockIdx = parseInt(match[2], 10);
    if (sectionIdx >= clone.sections.length) continue;
    const section = clone.sections[sectionIdx];
    if (blockIdx >= section.blocks.length) continue;
    const block = section.blocks[blockIdx];
    // Parse the replacement HTML into block content
    const parsed = parseWordPressEditorialBlocks(edit.replacementHtml, "polish");
    if (parsed.blocks.length > 0) {
      section.blocks[blockIdx] = parsed.blocks[0];
    }
  }
  return clone;
}

// ── Candidate validation ──

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export function validateCandidate(
  original: ArticleDocument,
  candidate: ArticleDocument,
  keyphrase: string,
): ValidationResult {
  const reasons: string[] = [];

  // H2 count unchanged
  const origH2s = original.sections.filter((s) => s.sectionType !== "faq-heading").length;
  const candH2s = candidate.sections.filter((s) => s.sectionType !== "faq-heading").length;
  if (origH2s !== candH2s) reasons.push(`H2 count changed: ${origH2s} → ${candH2s}`);

  // FAQ unchanged
  if (original.visibleFaq.length !== candidate.visibleFaq.length) {
    reasons.push(`FAQ count changed: ${original.visibleFaq.length} → ${candidate.visibleFaq.length}`);
  }
  for (let i = 0; i < original.visibleFaq.length; i++) {
    if (original.visibleFaq[i]?.question !== candidate.visibleFaq[i]?.question) {
      reasons.push(`FAQ question ${i} changed`);
    }
  }

  // Conclusion markers unchanged
  if (original.conclusion?.id !== candidate.conclusion?.id) {
    reasons.push("Conclusion changed");
  }

  // CTA unchanged
  const origCtaFp = original.cta?.fingerprint;
  const candCtaFp = candidate.cta?.fingerprint;
  if (origCtaFp !== candCtaFp) reasons.push("CTA changed");

  // Language switcher unchanged
  const origLsFp = original.languageSwitcher?.fingerprint;
  const candLsFp = candidate.languageSwitcher?.fingerprint;
  if (origLsFp !== candLsFp) reasons.push("Language switcher changed");

  // Links preserved
  const origLinks = extractAllLinks(original);
  const candLinks = extractAllLinks(candidate);
  const origHrefs = new Set(origLinks.map((l) => l.href));
  const candHrefs = new Set(candLinks.map((l) => l.href));
  for (const href of origHrefs) {
    if (!candHrefs.has(href)) reasons.push(`Link removed: ${href}`);
  }
  for (const href of candHrefs) {
    if (!origHrefs.has(href)) reasons.push(`New link added: ${href}`);
  }

  // Internal/external link counts
  if (origLinks.filter((l) => l.isInternal).length !== candLinks.filter((l) => l.isInternal).length) {
    reasons.push("Internal link count changed");
  }
  if (origLinks.filter((l) => !l.isInternal).length !== candLinks.filter((l) => !l.isInternal).length) {
    reasons.push("External link count changed");
  }

  // Word count within tolerance (±10%)
  const origHtml = renderArticleDocument(original);
  const candHtml = renderArticleDocument(candidate);
  const origWc = countReadableWords(origHtml);
  const candWc = countReadableWords(candHtml);
  if (Math.abs(candWc - origWc) > origWc * 0.10) {
    reasons.push(`Word count changed by >10%: ${origWc} → ${candWc}`);
  }

  // Keyphrase in first 100 words
  const candText = candHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const first100 = candText.substring(0, 500);
  if (!first100.includes(keyphrase.toLowerCase())) {
    reasons.push("Keyphrase missing from first 100 words");
  }

  // Keyphrase in at least one H2
  const h2Texts = candHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)?.map((h) => h.replace(/<[^>]*>/g, "").toLowerCase()) || [];
  if (!h2Texts.some((t) => t.includes(keyphrase.toLowerCase()))) {
    reasons.push("Keyphrase missing from all H2s");
  }

  // Keyphrase density ≤ 3% (hard stuffing limit). Only check for articles with
  // at least 500 words — below that, density is naturally high and unreachable.
  if (candWc >= 500) {
    const candKp = countExactKeyphrase(candHtml, keyphrase);
    const kpDensity = computeKeyphraseDensity(candKp, keyphrase, candWc);
    if (kpDensity > 3) {
      reasons.push(`Keyphrase density ${kpDensity.toFixed(2)}% exceeds 3% (${candKp} occurrences in ${candWc} words)`);
    }
  }

  // No new numeric claims
  const origClaims = new Set(extractNumericClaims(origHtml));
  const candClaims = new Set(extractNumericClaims(candHtml));
  for (const c of candClaims) {
    if (!origClaims.has(c)) reasons.push(`New numeric claim: ${c}`);
  }

  // No empty sections
  for (const s of candidate.sections) {
    if (s.blocks.length === 0 && s.sectionType !== "faq-heading") {
      reasons.push(`Empty section: ${s.heading}`);
    }
  }

  // Block count per section unchanged
  for (let i = 0; i < original.sections.length; i++) {
    const orig = original.sections[i];
    const cand = candidate.sections[i];
    if (!orig || !cand) continue;
    if (orig.sectionType === "faq-heading") continue;
    if (orig.blocks.length !== cand.blocks.length) {
      // Block count can change if paragraphs are merged or split — soft warning only
      // Don't hard-fail on this
    }
  }

  // Title unchanged
  if (original.metadata.title !== candidate.metadata.title) {
    reasons.push("Title changed");
  }

  // Meta description unchanged
  if (original.metadata.metaDescription !== candidate.metadata.metaDescription) {
    reasons.push("Meta description changed");
  }

  if (reasons.length > 0) {
    return { valid: false, reasons };
  }
  return { valid: true, reasons: [] };
}

// ── Main editorial-polish function ──

export async function runEditorialPolish(
  articleDoc: ArticleDocument,
  keyphrase: string,
  aiCall: (messages: ChatMessage[], options?: ChatOptions) => Promise<{ content: string }>,
): Promise<{ doc: ArticleDocument; result: EditorialPolishResult }> {
  const inputWordCount = countReadableWords(renderArticleDocument(articleDoc));
  const keyphraseBefore = countExactKeyphrase(renderArticleDocument(articleDoc), keyphrase);
  const linksBefore = extractAllLinks(articleDoc);
  const internalLinksBefore = linksBefore.filter((l) => l.isInternal).length;
  const externalLinksBefore = linksBefore.filter((l) => !l.isInternal).length;

  const blocks = extractEditableBlocks(articleDoc);
  const sectionSummaries = buildSectionSummaries(articleDoc);
  const articleHtml = renderArticleDocument(articleDoc);

  const request: PolishRequest = {
    blocks,
    sectionSummaries,
    keyphrase,
    title: articleDoc.metadata.title,
    metaDescription: articleDoc.metadata.metaDescription,
    articleHtml,
  };

  // Call AI
  const messages = buildPolishPrompt(request);
  let aiResponse: { content: string };
  try {
    aiResponse = await aiCall(messages, { responseFormat: { type: "json_object" }, maxTokens: 8192, timeoutMs: 120_000 });
  } catch {
    return {
      doc: articleDoc,
      result: {
        accepted: false, reason: "AI call failed",
        inputWordCount, candidateWordCount: inputWordCount,
        proposedEdits: 0, appliedEdits: 0,
        keyphraseBefore, keyphraseAfter: keyphraseBefore,
        internalLinksBefore, internalLinksAfter: internalLinksBefore,
        externalLinksBefore, externalLinksAfter: externalLinksBefore,
        newNumericClaims: 0, repeatedParagraphsRemoved: 0, spacingFixesApplied: 0,
      },
    };
  }

  // Parse response
  let response: PolishResponse;
  try {
    response = JSON.parse(aiResponse.content) as PolishResponse;
  } catch {
    return {
      doc: articleDoc,
      result: {
        accepted: false, reason: "Invalid JSON response from AI",
        inputWordCount, candidateWordCount: inputWordCount,
        proposedEdits: 0, appliedEdits: 0,
        keyphraseBefore, keyphraseAfter: keyphraseBefore,
        internalLinksBefore, internalLinksAfter: internalLinksBefore,
        externalLinksBefore, externalLinksAfter: externalLinksBefore,
        newNumericClaims: 0, repeatedParagraphsRemoved: 0, spacingFixesApplied: 0,
      },
    };
  }

  if (!response.edits || !Array.isArray(response.edits)) {
    return {
      doc: articleDoc,
      result: {
        accepted: false, reason: "Response missing edits array",
        inputWordCount, candidateWordCount: inputWordCount,
        proposedEdits: 0, appliedEdits: 0,
        keyphraseBefore, keyphraseAfter: keyphraseBefore,
        internalLinksBefore, internalLinksAfter: internalLinksBefore,
        externalLinksBefore, externalLinksAfter: externalLinksBefore,
        newNumericClaims: 0, repeatedParagraphsRemoved: 0, spacingFixesApplied: 0,
      },
    };
  }

  const proposedEdits = response.edits.length;

  // Validate each edit
  const validEdits: PolishEdit[] = [];
  const seenBlockIds = new Set<string>();
  for (const edit of response.edits) {
    if (!edit.blockId || !edit.replacementHtml) continue;
    if (seenBlockIds.has(edit.blockId)) continue; // duplicate blockId
    seenBlockIds.add(edit.blockId);

    // Verify blockId exists in source
    const blockExists = blocks.some((b) => b.blockId === edit.blockId);
    if (!blockExists) continue;

    // Verify no link changes
    const origHtml = blocks.find((b) => b.blockId === edit.blockId)?.html || "";
    const origHrefs = extractHrefs(origHtml);
    const newHrefs = extractHrefs(edit.replacementHtml);
    if (!arraysEqual(origHrefs, newHrefs)) continue;

    // Verify no H2 changes
    if (edit.replacementHtml.includes("<h2")) continue;

    validEdits.push(edit);
  }

  const appliedEdits = validEdits.length;

  // Apply valid edits to cloned document
  const candidateDoc = applyEdits(articleDoc, validEdits);

  // Restore CTA from original — editorial-polish must never touch it
  candidateDoc.cta = articleDoc.cta ? { ...articleDoc.cta } : null;
  // Restore FAQ schema from original
  candidateDoc.faqSchema = articleDoc.faqSchema ? { ...articleDoc.faqSchema } : null;
  // Restore language switcher from original
  candidateDoc.languageSwitcher = articleDoc.languageSwitcher ? { ...articleDoc.languageSwitcher } : null;

  // Normalize spacing (only affects section text, not protected blocks)
  const candidateHtmlBefore = renderArticleDocument(candidateDoc);
  const candidateHtmlAfter = normalizeArticleSpacing(candidateHtmlBefore);
  const spacingChanged = candidateHtmlBefore !== candidateHtmlAfter;

  // If spacing changed, parse back
  let finalCandidate = candidateDoc;
  if (spacingChanged) {
    const parsed = parseArticleDocumentFromHtml(candidateHtmlAfter, candidateDoc);
    if (parsed.doc) finalCandidate = parsed.doc;
    // Restore protected blocks again after parse
    finalCandidate.cta = articleDoc.cta ? { ...articleDoc.cta } : null;
    finalCandidate.faqSchema = articleDoc.faqSchema ? { ...articleDoc.faqSchema } : null;
    finalCandidate.languageSwitcher = articleDoc.languageSwitcher ? { ...articleDoc.languageSwitcher } : null;
  }

  // Validate candidate
  const validation = validateCandidate(articleDoc, finalCandidate, keyphrase);

  if (!validation.valid) {
    return {
      doc: articleDoc,
      result: {
        accepted: false, reason: `Validation failed: ${validation.reasons.join("; ")}`,
        inputWordCount, candidateWordCount: countReadableWords(renderArticleDocument(finalCandidate)),
        proposedEdits, appliedEdits,
        keyphraseBefore, keyphraseAfter: countExactKeyphrase(renderArticleDocument(finalCandidate), keyphrase),
        internalLinksBefore, internalLinksAfter: extractAllLinks(finalCandidate).filter((l) => l.isInternal).length,
        externalLinksBefore, externalLinksAfter: extractAllLinks(finalCandidate).filter((l) => !l.isInternal).length,
        newNumericClaims: extractNumericClaims(renderArticleDocument(finalCandidate)).filter(
          (c) => !extractNumericClaims(renderArticleDocument(articleDoc)).includes(c),
        ).length,
        repeatedParagraphsRemoved: 0, spacingFixesApplied: spacingChanged ? 1 : 0,
      },
    };
  }

  // Success — return the polished document
  const keyphraseAfter = countExactKeyphrase(renderArticleDocument(finalCandidate), keyphrase);
  const linksAfter = extractAllLinks(finalCandidate);

  return {
    doc: finalCandidate,
    result: {
      accepted: true, reason: "ok",
      inputWordCount, candidateWordCount: countReadableWords(renderArticleDocument(finalCandidate)),
      proposedEdits, appliedEdits,
      keyphraseBefore, keyphraseAfter,
      internalLinksBefore, internalLinksAfter: linksAfter.filter((l) => l.isInternal).length,
      externalLinksBefore, externalLinksAfter: linksAfter.filter((l) => !l.isInternal).length,
      newNumericClaims: 0,
      repeatedParagraphsRemoved: 0,
      spacingFixesApplied: spacingChanged ? 1 : 0,
    },
  };
}

function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /href="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Deterministic cleanup (post-AI) ──

export function deterministicCleanup(html: string): string {
  let result = html;
  // Fix spacing around anchors
  result = normalizeLinkSpacing(result);
  // Remove duplicate whitespace
  result = result.replace(/  +/g, " ");
  // Normalize punctuation spacing
  result = result.replace(/\s+([.,!?;:])/g, "$1");
  result = result.replace(/([.,!?;:])\s{2,}/g, "$1 ");
  // Remove empty paragraphs
  result = result.replace(/<!--\s*wp:paragraph\s*-->\s*<p>\s*<\/p>\s*<!--\s*\/wp:paragraph\s*-->/gi, "");
  // WordPress block boundary validation
  result = result.replace(/<!--\s*\/wp:(\w+)\s*-->\s*<!--\s*wp:\1\s*-->/g, "");
  return result;
}
