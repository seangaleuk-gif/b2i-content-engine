import { fingerprintHtml } from "@/lib/blog/article-document";
import { parseWordpressBlockStructure } from "@/lib/blog/wordpress-block-structure";

export const CANONICAL_CTA_SIGNUP_HREF = "https://app.b2ihub.com/signup";
export const CANONICAL_CTA_HEADING = "Ready to grow your brand with Hong Kong creators?";

/** The sole application-owned English CTA template. */
export const CANONICAL_ENGLISH_CTA_HTML = `<!-- wp:html -->
<div style="background: #1E3A8A; color: #fff; padding: 32px 28px; border-radius: 12px; margin: 40px 0; text-align: center;">
  <h2 style="color: #fff; margin-top: 0; font-size: 22px;">Ready to grow your brand with Hong Kong creators?</h2>
  <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px;">B2I Hub connects businesses directly with verified creators — no agencies, no commissions, no middlemen. Create your free profile and start collaborating today.</p>
  <a href="https://app.b2ihub.com/signup" style="display: inline-block; background: #F97316; color: #fff; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;" target="_blank" rel="noopener">Create Your Free Profile →</a>
</div>
<!-- /wp:html -->`;

export const CANONICAL_ENGLISH_CTA_FINGERPRINT = fingerprintHtml(CANONICAL_ENGLISH_CTA_HTML);

export interface CanonicalCtaAnalysis {
  valid: boolean;
  issues: string[];
  canonicalBlockCount: number;
  ctaHeadingCount: number;
  exactSignupHrefCount: number;
  signupHrefOutsideCanonicalBlockCount: number;
  signupLikeHrefCount: number;
  candidateCtaBlockCount: number;
}

function normalized(html: string): string {
  return html.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function hrefs(html: string): string[] {
  const values: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) values.push(match[2]);
  return values;
}

function headingTexts(html: string): string[] {
  const values: string[] = [];
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    values.push(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }
  return values;
}

/**
 * Validate the exact application-owned English CTA and prove that the signup
 * destination does not occur outside it. This is shared by preservation,
 * pre-editorial validation and the final publication policy.
 */
export function analyzeCanonicalEnglishCta(html: string): CanonicalCtaAnalysis {
  const structure = parseWordpressBlockStructure(html);
  const issues: string[] = [];
  if (!structure.valid) issues.push(...structure.issues.map((issue) => `WordPress structure: ${issue}`));

  const wpHtmlBlocks = structure.ranges
    .filter((range) => range.type === "wp:html" && range.depth === 0)
    .map((range) => html.slice(range.start, range.end));
  const canonicalBlocks = wpHtmlBlocks.filter((block) => normalized(block) === normalized(CANONICAL_ENGLISH_CTA_HTML));
  const canonicalBlockCount = canonicalBlocks.length;
  const canonicalBlock = canonicalBlockCount === 1 ? canonicalBlocks[0] : null;

  const allHrefs = hrefs(html);
  const exactSignupHrefCount = allHrefs.filter((href) => href === CANONICAL_CTA_SIGNUP_HREF).length;
  const signupLikeHrefCount = allHrefs.filter((href) => href.includes("app.b2ihub.com/signup")).length;
  const candidateCtaBlocks = wpHtmlBlocks.filter((block) =>
    hrefs(block).some((href) => href.includes("app.b2ihub.com/signup"))
      || /\bcta(?:[-_\s]|\b)/i.test(block)
      || /Create Your Free Profile|Ready to grow your brand/i.test(block),
  );

  let ctaHeadingCount = 0;
  let signupHrefOutsideCanonicalBlockCount = exactSignupHrefCount;
  if (canonicalBlock) {
    ctaHeadingCount = headingTexts(canonicalBlock).filter((text) => text === CANONICAL_CTA_HEADING).length;
    const canonicalHrefCount = hrefs(canonicalBlock).filter((href) => href === CANONICAL_CTA_SIGNUP_HREF).length;
    signupHrefOutsideCanonicalBlockCount = exactSignupHrefCount - canonicalHrefCount;
    const withoutCanonical = html.replace(canonicalBlock, "");
    const rawOutside = (withoutCanonical.match(/https:\/\/app\.b2ihub\.com\/signup/gi) ?? []).length;
    signupHrefOutsideCanonicalBlockCount = Math.max(signupHrefOutsideCanonicalBlockCount, rawOutside);
  }

  if (canonicalBlockCount !== 1) issues.push(`canonical CTA block count=${canonicalBlockCount} (expected 1)`);
  if (ctaHeadingCount !== 1) issues.push(`canonical CTA heading count=${ctaHeadingCount} (expected 1)`);
  if (exactSignupHrefCount !== 1) issues.push(`exact signup href count=${exactSignupHrefCount} (expected 1)`);
  if (signupLikeHrefCount !== 1) issues.push(`signup-like href count=${signupLikeHrefCount} (expected 1)`);
  if (signupHrefOutsideCanonicalBlockCount !== 0) {
    issues.push(`signup destination outside canonical CTA=${signupHrefOutsideCanonicalBlockCount}`);
  }
  if (candidateCtaBlocks.length !== 1) issues.push(`CTA-like wp:html block count=${candidateCtaBlocks.length} (expected 1)`);

  return {
    valid: issues.length === 0,
    issues,
    canonicalBlockCount,
    ctaHeadingCount,
    exactSignupHrefCount,
    signupHrefOutsideCanonicalBlockCount,
    signupLikeHrefCount,
    candidateCtaBlockCount: candidateCtaBlocks.length,
  };
}
