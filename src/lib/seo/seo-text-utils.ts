// ── Canonical text extraction — single source of truth for SEO auditor and normalizer ──

/** Extract readable text from HTML by stripping wp:html blocks, scripts, styles,
 *  WordPress block comments, HTML tags, URLs, and code fences. */
export function extractReadableText(html: string): string {
  return html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Count readable words in HTML body content */
export function countReadableWords(html: string): number {
  const readable = extractReadableText(html);
  return readable ? readable.split(/\s+/).length : 0;
}

/** Extract visible H2 heading texts from HTML */
export function extractH2Texts(html: string): string[] {
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const texts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(html)) !== null) {
    texts.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return texts;
}

/** Extract visible paragraph texts from HTML (body paragraphs only, excludes wp:html / script / comments) */
export function extractParagraphTexts(html: string): string[] {
  const cleaned = html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const texts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = paraRegex.exec(cleaned)) !== null) {
    texts.push(m[1].replace(/<[^>]+>/g, "").trim());
  }
  return texts.filter((t) => t.length > 0);
}

/** Count exact case-insensitive occurrences of a phrase in text */
export function countExactPhrase(text: string, phrase: string): number {
  if (!phrase) return 0;
  const lower = text.toLowerCase();
  const target = phrase.toLowerCase().trim();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(target, pos)) !== -1) {
    count++;
    pos += target.length;
  }
  return count;
}

/** Calculate keyphrase density as percentage */
export function calculateKeyphraseDensity(text: string, phrase: string): number {
  const wordCount = countReadableWords(text);
  if (wordCount === 0) return 0;
  const kpCount = countExactPhrase(text, phrase);
  return (kpCount / wordCount) * 100;
}

/** Count syllables in a word */
export function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  let count = 0;
  let prevVowel = false;
  for (const ch of word) {
    const isVowel = "aeiou".includes(ch);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  if (word.endsWith("e")) count--;
  return Math.max(1, count);
}

/** Calculate Flesch Reading Ease score from readable text */
export function calculateFleschReadingEase(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (words.length === 0 || sentences.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
}

/** Character-by-character sentence detector — strips inline HTML and checks if
 *  the next content character starts with an uppercase letter (true sentence end).
 *  Avoids false positives from abbreviations, decimals, URLs, file extensions. */
const NO_SPLIT_BEFORE = /\b(?:Mr|Ms|Mrs|Dr|Prof|Sr|Jr|St|vs|etc|approx|dept|est|govt|inc|ltd|co|corp|ave|blvd|rd|st|sq|dept|univ|inst|assn|tel|ext|no|vol|pg|pp|ed|par|chap|sec|fig|ref|e\.g|i\.e|viz|al)\.$/i;

/** Return UTF-16 offsets immediately after real sentence-ending punctuation. */
export function findSentenceBoundaryOffsets(text: string): number[] {
  const boundaries: number[] = [];
  let sentenceStart = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!/[.!?！？。]/.test(char)) continue;
    const current = text.slice(sentenceStart, i + 1);
    if (char === "." && NO_SPLIT_BEFORE.test(current)) continue;
    // Closing quotation marks/brackets belong to the sentence that ends at
    // this punctuation. Returning a boundary before them can strand a closing
    // quote as its own sentence and lets downstream paragraph splitters or
    // sentence removers separate a valid quotation pair.
    let boundaryEnd = i + 1;
    while (/["\u201D\u2019)\]}]/.test(text[boundaryEnd] ?? "")) boundaryEnd++;
    const restContent = text.slice(boundaryEnd).trimStart();
    if (restContent.length > 0 && /^[A-Z\u4e00-\u9fff("'「\u201C]/.test(restContent)) {
      boundaries.push(boundaryEnd);
      sentenceStart = boundaryEnd;
      i = boundaryEnd - 1;
    }
  }
  return boundaries;
}

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const boundary of findSentenceBoundaryOffsets(text)) {
    const sentence = text.slice(start, boundary).trim();
    if (sentence) sentences.push(sentence);
    start = boundary;
  }
  const finalSentence = text.slice(start).trim();
  if (finalSentence) sentences.push(finalSentence);
  return sentences;
}

/** Count sentences in a paragraph text. Uses the same character-by-character
 *  detector as splitLongParagraphs for pipeline consistency. */
export function countSentences(paragraphText: string): number {
  return splitSentences(paragraphText).length;
}

/** Analyse which paragraphs exceed a sentence limit and return their excerpts with counts.
 *  Useful for debugging paragraph-length SEO issues. */
export function analyseLongParagraphs(html: string, maxSentences: number): Array<{ index: number; excerpt: string; sentences: number }> {
  const texts = extractParagraphTexts(html);
  const result: Array<{ index: number; excerpt: string; sentences: number }> = [];
  for (let i = 0; i < texts.length; i++) {
    const s = countSentences(texts[i]);
    if (s > maxSentences) {
      result.push({ index: i, excerpt: texts[i].substring(0, 120), sentences: s });
    }
  }
  return result;
}

/** Check if text contains the exact focus keyphrase as a contiguous substring (case-insensitive) */
export function containsExactPhrase(text: string, keyphrase: string): boolean {
  return text.toLowerCase().includes(keyphrase.toLowerCase().trim());
}

/** Check if two phrases are close variants (singular/plural, minor punctuation differences) */
export function closeVariant(phrase: string, heading: string): boolean {
  const p = phrase.toLowerCase().replace(/s\b/g, "").replace(/[^a-z0-9\s]/g, "").trim();
  const h = heading.toLowerCase().replace(/s\b/g, "").replace(/[^a-z0-9\s]/g, "").trim();
  if (!p || !h) return false;
  return h.includes(p) || p.includes(h);
}

/** Normalize whitespace in HTML for comparison (ignores formatting differences only) */
export function normalizeHtmlWhitespace(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

// ── Shared content structure helpers ──

/** Extract the first N readable words from an article, excluding WordPress blocks,
 *  HTML tags, JSON-LD, language switcher content, and HTML entities. */
export function getFirstNReadableWords(html: string, n: number): string {
  const readable = extractReadableText(html);
  return readable.split(/\s+/).slice(0, n).join(" ");
}

/** Count CTA heading occurrences by matching actual <h2> or <h3> elements
 *  containing CTA text, including headings inside wp:html blocks (where the
 *  official CTA template places them). Does NOT count WordPress comments,
 *  button text, or paragraph text containing the same phrase. */
export function countCtaHeadingTags(html: string): number {
  const headingHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Primary: count CTA headings inside wp:html blocks (the canonical CTA location).
  // Headings in regular editorial sections may accidentally match the text pattern
  // and produce false positives.
  const wpHtmlBlocks = headingHtml.match(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi) ?? [];
  let ctaCount = 0;
  for (const block of wpHtmlBlocks) {
    const h2s = block.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi) ?? [];
    const h3s = block.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi) ?? [];
    ctaCount += [...h2s, ...h3s].filter((heading) =>
      /B2I Hub|Ready to grow|grow your brand|Create Your|Sign Up/i.test(
        heading.replace(/<[^>]+>/g, " ")
      )
    ).length;
  }

  // Fallback: if no wp:html blocks contain CTA headings, scan all headings.
  // This handles simplified test fixtures and non-standard CTA rendering.
  if (ctaCount === 0) {
    const allH2s = headingHtml.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi) ?? [];
    const allH3s = headingHtml.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi) ?? [];
    ctaCount = [...allH2s, ...allH3s].filter((heading) =>
      /B2I Hub|Ready to grow|grow your brand|Create Your|Sign Up/i.test(
        heading.replace(/<[^>]+>/g, " ")
      )
    ).length;
  }

  return ctaCount;
}

/** Detect the language switcher block by its stable class or data attribute. */
export function hasLanguageSwitcher(html: string): boolean {
  return /b2i-language-switcher/i.test(html);
}

/** Canonical editorial external-link URL extraction.
 *  Excludes: internal links, CTA signup, script/JSON-LD blocks,
 *  language-switcher links, and relative URLs. */
export function extractEditorialExternalLinkUrls(
  html: string,
  internalDomains: string[] = ["b2ihub.com", "app.b2ihub.com"],
): string[] {
  // Strip script blocks (containing JSON-LD/FAQ schema URLs) before counting
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(stripped)) !== null) {
    const href = m[1];
    if (href.startsWith("/") || href.startsWith("#")) continue;
    if (internalDomains.some((d) => href.includes(d))) continue;
    if (!href.startsWith("http")) continue;
    seen.add(href.replace(/\/$/, ""));
  }
  return [...seen];
}

/** Count editorial external links in article HTML. */
export function countEditorialExternalLinks(
  html: string,
  internalDomains: string[] = ["b2ihub.com", "app.b2ihub.com"],
): number {
  return extractEditorialExternalLinkUrls(html, internalDomains).length;
}
