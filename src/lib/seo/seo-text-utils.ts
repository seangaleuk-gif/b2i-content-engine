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

/** Count sentences in a paragraph text */
export function countSentences(paragraphText: string): number {
  return paragraphText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
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

  const h2s =
    headingHtml.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi) ?? [];

  const h3s =
    headingHtml.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi) ?? [];

  return [...h2s, ...h3s].filter((heading) =>
    /B2I Hub|Ready to grow|grow your brand|Create Your|Sign Up/i.test(
      heading.replace(/<[^>]+>/g, " ")
    )
  ).length;
}

/** Detect the language switcher block by its stable class or data attribute. */
export function hasLanguageSwitcher(html: string): boolean {
  return /b2i-language-switcher/i.test(html);
}

/** Count editorial outbound links, excluding internal B2I links, CTA signup,
 *  language switcher links, same-domain links, and relative URLs. */
/** Count editorial external links in article HTML.
 *  Excludes: internal links, CTA signup, script/JSON-LD blocks, language-switcher links. */
export function countEditorialExternalLinks(html: string, internalDomains: string[] = ["b2ihub.com", "app.b2ihub.com"]): number {
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
  return seen.size;
}
