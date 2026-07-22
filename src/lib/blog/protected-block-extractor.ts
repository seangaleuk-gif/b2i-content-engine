// ── Protected Block Extractor ──
// Extracts CTA and FAQ blocks from article sections using bounded search.
// These functions are the single source of truth used by both the
// generate-blog route and the test suite.

/**
 * Extract the FAQ JSON-LD block from the full assembled article.
 * Searches for the `<!-- wp:html -->` block containing FAQPage schema.
 */
export function extractFaqBlock(article: string): string {
  if (!article) return "";
  const match = article.match(/<!--\s*wp:html\s*-->[\s\S]*?FAQ[\s\S]*?<!--\s*\/wp:html\s*-->/i);
  return match ? match[0] : "";
}

/**
 * Extract the CTA block from the conclusion ONLY (not from the full article).
 *
 * Searching the full article caused overmatching: the old regex
 * `<!--\s*wp:html\s*-->[\s\S]*?B2I Hub[\s\S]*?<!--\s*\/wp:html\s*-->`
 * matched from the FAQ's <!-- wp:html --> opener through to the CTA's
 * <!-- /wp:html --> closer, capturing FAQ + conclusion + CTA in one block.
 *
 * This function searches only the conclusion text. It finds the signup
 * URL's wp:html block, walks backward to the nearest CTA heading, and
 * returns the contiguous region from the CTA heading through the signup
 * button block.
 */
export function extractCtaFromConclusion(conclusion: string): string {
  if (!conclusion) return "";

  // Strategy: find the signup URL by string position, then anchor to the
  // nearest surrounding <!-- wp:html --> ... <!-- /wp:html --> block.
  // This avoids the regex overmatching issue where a lazy [\s\S]*? passes
  // through intermediate <!-- /wp:html --> closers to find the signup URL.
  const signupIdx = conclusion.indexOf("app.b2ihub.com/signup");
  if (signupIdx < 0) {
    // Fallback: search for CTA heading text
    const b2iIdx = conclusion.search(/Ready to grow|B2I Hub|Create Your B2I/i);
    if (b2iIdx >= 0) {
      return conclusion.substring(b2iIdx);
    }
    return "";
  }

  // Find the nearest <!-- wp:html --> opener before the signup URL
  const wpHtmlOpen = /<!--\s*wp:html\s*-->/gi;
  let lastOpenIdx = -1;
  let om: RegExpExecArray | null;
  while ((om = wpHtmlOpen.exec(conclusion)) !== null) {
    if (om.index < signupIdx) {
      lastOpenIdx = om.index;
    } else {
      break;
    }
  }
  if (lastOpenIdx < 0) return "";

  // Find the nearest <!-- /wp:html --> closer after the signup URL
  const wpHtmlClose = conclusion.indexOf("<!-- /wp:html -->", signupIdx);
  if (wpHtmlClose < 0) return "";
  const ctaHtmlBlockEnd = wpHtmlClose + "<!-- /wp:html -->".length;

  // Walk backwards from the wp:html opener to find the CTA heading (H2 with CTA keywords)
  const beforeCta = conclusion.substring(0, lastOpenIdx);
  const h2Re = /<!--\s*wp:heading\s+\{[^}]*\}\s*-->\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<!--\s*\/wp:heading\s*-->/gi;
  let lastH2Idx = -1;
  let lastH2Match = "";
  let h2m: RegExpExecArray | null;
  while ((h2m = h2Re.exec(beforeCta)) !== null) {
    const h2Text = h2m[0].toLowerCase();
    if (/ready|grow|b2i|start|join|sign|create|profile/i.test(h2Text)) {
      lastH2Idx = h2m.index;
      lastH2Match = h2m[0];
    }
  }

  if (lastH2Idx >= 0) {
    return lastH2Match + conclusion.substring(lastH2Idx + lastH2Match.length, ctaHtmlBlockEnd);
  }

  // No CTA-like H2 — walk back to find preceding paragraph blocks
  const paraRe = /<!--\s*wp:paragraph\s*-->[\s\S]*?<!--\s*\/wp:paragraph\s*-->/gi;
  let lastParaIdx = -1;
  let pm: RegExpExecArray | null;
  while ((pm = paraRe.exec(beforeCta)) !== null) {
    lastParaIdx = pm.index;
  }

  if (lastParaIdx >= 0) {
    return conclusion.substring(lastParaIdx, ctaHtmlBlockEnd);
  }

  return conclusion.substring(lastOpenIdx, ctaHtmlBlockEnd);
}

/**
 * Strip extracted CTA and FAQ blocks from the conclusion text.
 * Returns the cleaned conclusion with CTA/FAQ content removed.
 */
export function stripProtectedBlocksFromConclusion(
  conclusion: string,
  ctaBlock: string,
  faqBlock: string,
): string {
  let cleaned = conclusion;
  if (faqBlock && cleaned.includes(faqBlock)) {
    cleaned = cleaned.replace(faqBlock, "");
  }
  if (ctaBlock && cleaned.includes(ctaBlock)) {
    cleaned = cleaned.replace(ctaBlock, "");
  }
  return cleaned;
}

/**
 * Count CTA headings in HTML content.
 */
export function countCtaHeadings(html: string): number {
  return (html.match(/B2I Hub|Ready to grow/i) ?? []).length;
}

/**
 * Count signup URLs in HTML content.
 */
export function countSignupUrls(html: string): number {
  return (html.match(/app\.b2ihub\.com\/signup/gi) ?? []).length;
}

/**
 * Count FAQ schema blocks in HTML content.
 */
export function countFaqBlocks(html: string): number {
  return (html.match(/FAQPage/gi) ?? []).length;
}
