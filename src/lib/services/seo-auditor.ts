import { cleanBodyText, countWords, splitSentences } from "./text-utils";
import { SEO_TITLE_MIN, SEO_TITLE_MAX, META_MIN, META_MAX, KEYPHRASE_MIN, KEYPHRASE_MAX, FLESCH_MIN, FLESCH_MAX } from "./generation-constants";

export interface AuditCheck {
  label: string;
  description: string;
  status: "pass" | "fail" | "warning";
  score: number;
  fix: string;
  category: string;
}

export interface AuditResult {
  overallScore: number;
  checks: AuditCheck[];
  summary: { passed: number; warnings: number; failed: number };
}

interface AuditInput {
  title: string;
  metaDescription: string;
  slug: string;
  keyword: string;
  blog: string;
  externalLinks?: string[];
}

function extractHeadings(html: string): { level: number; text: string }[] {
  const headings: { level: number; text: string }[] = [];
  const regex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    headings.push({ level: parseInt(match[1]), text: cleanBodyText(match[2]) });
  }
  return headings;
}

function countParagraphedSentences(html: string): { paraIndex: number; sentences: number }[] {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "");
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const results: { paraIndex: number; sentences: number }[] = [];
  let match;
  let idx = 0;
  while ((match = paraRegex.exec(cleaned)) !== null) {
    const text = cleanBodyText(match[1]);
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10).length;
    results.push({ paraIndex: idx++, sentences });
  }
  return results;
}

function fleshReadingEase(rawText: string): number {
  const text = cleanBodyText(rawText);
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = splitSentences(text);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  if (words.length === 0 || sentences.length === 0) return 0;
  return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
}

function countSyllables(word: string): number {
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

export function runAudit(input: AuditInput): AuditResult {
  const { title, metaDescription, keyword, blog, externalLinks: storedExternalLinks } = input;
  const checks: AuditCheck[] = [];
  const bodyText = cleanBodyText(blog);
  const bodyWords = countWords(blog);
  const keywordLower = keyword.toLowerCase().trim();
  const headings = extractHeadings(blog);
  const paragraphCounts = countParagraphedSentences(blog);
  const bodySentences = splitSentences(blog);

  // 1. SEO title length
  const titleLen = title.length;
  if (titleLen >= SEO_TITLE_MIN && titleLen <= SEO_TITLE_MAX) {
    checks.push({ label: "SEO Title Length", description: `Title is ${titleLen} characters (target: ${SEO_TITLE_MIN}-${SEO_TITLE_MAX}).`, status: "pass", score: 100, fix: "", category: "Meta" });
  } else if (titleLen > 0 && titleLen < SEO_TITLE_MIN) {
    checks.push({ label: "SEO Title Length", description: `Title is ${titleLen} characters — too short.`, status: "warning", score: 50, fix: `Add ${SEO_TITLE_MIN - titleLen} more characters to the title. Include the focus keyphrase near the beginning.`, category: "Meta" });
  } else if (titleLen > SEO_TITLE_MAX) {
    checks.push({ label: "SEO Title Length", description: `Title is ${titleLen} characters — too long.`, status: "warning", score: 50, fix: `Trim ${titleLen - SEO_TITLE_MAX} characters. Google truncates titles longer than ${SEO_TITLE_MAX} characters.`, category: "Meta" });
  } else {
    checks.push({ label: "SEO Title Length", description: "No title found.", status: "fail", score: 0, fix: `Set an SEO title between ${SEO_TITLE_MIN}-${SEO_TITLE_MAX} characters with the focus keyphrase.`, category: "Meta" });
  }

  // 2. Meta description length
  const metaLen = metaDescription.length;
  if (metaLen >= META_MIN && metaLen <= META_MAX) {
    checks.push({ label: "Meta Description Length", description: `Meta description is ${metaLen} characters (target: ${META_MIN}-${META_MAX}).`, status: "pass", score: 100, fix: "", category: "Meta" });
  } else if (metaLen > 0 && metaLen < META_MIN) {
    checks.push({ label: "Meta Description Length", description: `Meta description is ${metaLen} characters — too short.`, status: "warning", score: 40, fix: `Expand to ${META_MIN}-${META_MAX} characters. Include the focus keyphrase and a compelling CTA.`, category: "Meta" });
  } else if (metaLen > META_MAX) {
    checks.push({ label: "Meta Description Length", description: `Meta description is ${metaLen} characters — too long.`, status: "warning", score: 50, fix: `Trim to under ${META_MAX} characters. Google truncates meta descriptions above ~160 on desktop and ~${META_MAX} on mobile.`, category: "Meta" });
  } else {
    checks.push({ label: "Meta Description Length", description: "No meta description found.", status: "fail", score: 0, fix: `Add a meta description between ${META_MIN}-${META_MAX} characters with the focus keyphrase.`, category: "Meta" });
  }

  // 3. Focus keyphrase in H1
  if (keywordLower) {
    const h1 = headings.find((h) => h.level === 1);
    if (h1 && h1.text.toLowerCase().includes(keywordLower)) {
      checks.push({ label: "Focus Keyphrase in H1", description: `"${keyword}" found in H1 heading.`, status: "pass", score: 100, fix: "", category: "Keywords" });
    } else {
      checks.push({ label: "Focus Keyphrase in H1", description: `"${keyword}" not found in any H1 heading.`, status: "fail", score: 0, fix: `Include "${keyword}" in the H1 title of the post.`, category: "Keywords" });
    }
  } else {
    checks.push({ label: "Focus Keyphrase in H1", description: "No focus keyphrase set for this project.", status: "warning", score: 0, fix: "Set a focus keyphrase in the project settings.", category: "Keywords" });
  }

  // 4. Keyphrase in first 100 words
  if (keywordLower) {
    const first100 = bodyText.split(/\s+/).slice(0, 100).join(" ").toLowerCase();
    if (first100.includes(keywordLower)) {
      checks.push({ label: "Keyphrase in First 100 Words", description: `"${keyword}" appears in the first 100 words.`, status: "pass", score: 100, fix: "", category: "Keywords" });
    } else {
      checks.push({ label: "Keyphrase in First 100 Words", description: `"${keyword}" not found in the first 100 words.`, status: "fail", score: 0, fix: `Include "${keyword}" naturally within the first paragraph.`, category: "Keywords" });
    }
  } else {
    checks.push({ label: "Keyphrase in First 100 Words", description: "No focus keyphrase set.", status: "warning", score: 0, fix: "Set a focus keyphrase.", category: "Keywords" });
  }

  // 5. Keyphrase in at least one H2
  if (keywordLower) {
    const h2s = headings.filter((h) => h.level === 2);
    const hasInH2 = h2s.some((h) => h.text.toLowerCase().includes(keywordLower));
    if (hasInH2) {
      checks.push({ label: "Keyphrase in H2", description: `"${keyword}" found in at least one H2.`, status: "pass", score: 100, fix: "", category: "Keywords" });
    } else if (h2s.length > 0) {
      checks.push({ label: "Keyphrase in H2", description: `"${keyword}" not found in any H2 heading.`, status: "warning", score: 60, fix: `Include "${keyword}" in at least one H2 section heading.`, category: "Keywords" });
    } else {
      checks.push({ label: "Keyphrase in H2", description: "No H2 headings found in the content.", status: "warning", score: 60, fix: "Add H2 headings to structure your content.", category: "Keywords" });
    }
  } else {
    checks.push({ label: "Keyphrase in H2", description: "No focus keyphrase set.", status: "warning", score: 0, fix: "Set a focus keyphrase.", category: "Keywords" });
  }

  // 6. Keyphrase density
  if (keywordLower && bodyWords > 0) {
    const regex = new RegExp(keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const occurrences = (bodyText.match(regex) || []).length;
    const density = (occurrences / bodyWords) * 100;
    if (density >= 0.5 && density <= 2) {
      checks.push({ label: "Keyphrase Density", description: `Keyphrase density is ${density.toFixed(1)}% (target: 0.5-2%). Found ${occurrences} times in ${bodyWords} words.`, status: "pass", score: 100, fix: "", category: "Keywords" });
    } else if (density < 0.5) {
      checks.push({ label: "Keyphrase Density", description: `Keyphrase density is ${density.toFixed(1)}% (too low). Found only ${occurrences} times.`, status: "warning", score: 50, fix: `Use "${keyword}" more often — aim for every 200-300 words.`, category: "Keywords" });
    } else {
      checks.push({ label: "Keyphrase Density", description: `Keyphrase density is ${density.toFixed(1)}% (too high — possible keyword stuffing). Found ${occurrences} times.`, status: "fail", score: 30, fix: `Reduce usage of "${keyword}" — it appears too frequently. Natural usage is every 200-300 words.`, category: "Keywords" });
    }
  } else {
    checks.push({ label: "Keyphrase Density", description: "Cannot calculate — no keyword or content.", status: "warning", score: 0, fix: "Set a focus keyphrase and add content.", category: "Keywords" });
  }

  // 7. Internal links count — count from raw blog, only exclude script blocks
  if (process.env.DEBUG_SEO === "true") {
    console.log("========================================");
    console.log("[SEO-DEBUG] RAW BLOG (first 5000 chars):");
    console.log(blog.substring(0, 5000));
    console.log("----------------------------------------");
    console.log("[SEO-DEBUG] BLOG LENGTH:", blog.length, "chars");
    console.log("[SEO-DEBUG] Contains /blog/:", blog.includes("/blog/"));
    console.log("[SEO-DEBUG] Contains /zh/:", blog.includes("/zh/"));
    console.log("[SEO-DEBUG] Contains <a :", blog.includes("<a "));
    console.log("[SEO-DEBUG] Contains href= :", blog.includes("href="));
    console.log("[SEO-DEBUG] Contains backslash-quote:", blog.includes('\\"'));
    console.log("[SEO-DEBUG] Contains double-quote:", blog.includes('"'));
    console.log("----------------------------------------");
  }

  const normalizedBlog = blog
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/\\"/g, '"')
    .replace(/""/g, '"')
    .replace(/'/g, '"');

  if (process.env.DEBUG_SEO === "true") {
    console.log("[SEO-DEBUG] NORMALIZED BLOG (first 2000 chars):");
    console.log(normalizedBlog.substring(0, 2000));
    console.log("----------------------------------------");
  }

  // Step 1: All <a> tags found
  const allLinkTags = normalizedBlog.match(/<a\b[^>]*>/gi) || [];

  if (process.env.DEBUG_SEO === "true") {
    console.log(`[SEO-DEBUG] STEP 1 - All <a> tags found: ${allLinkTags.length}`);
    allLinkTags.forEach((tag, i) => {
      console.log(`  [${i + 1}] ${tag.substring(0, 200)}`);
    });
    console.log("----------------------------------------");
  }

  // Step 2: Extract href from each tag
  const extractedHrefs: string[] = [];
  const extractedHrefPositions: number[] = [];
  const linkTagMatches = normalizedBlog.matchAll(/<a\b[^>]*>/gi);
  for (const match of linkTagMatches) {
    const tag = match[0];
    const hrefMatch = tag.match(/href="([^"]*)"/i) || tag.match(/href='([^']*)'/i);
    if (hrefMatch) {
      extractedHrefs.push(hrefMatch[1]);
      extractedHrefPositions.push(match.index);
    }
  }

  if (process.env.DEBUG_SEO === "true") {
    console.log(`[SEO-DEBUG] STEP 2 - Extracted hrefs: ${extractedHrefs.length}`);
    extractedHrefs.forEach((href, i) => {
      console.log(`  [${i + 1}] ${href} (pos: ${extractedHrefPositions[i]})`);
    });
    console.log("----------------------------------------");
  }

  // Step 2b: Mark wp:html block ranges to exclude language switcher, CTA, schema links
  const wpHtmlRanges: [number, number][] = [];
  const wpHtmlRegex = /<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi;
  let wpMatch: RegExpExecArray | null;
  while ((wpMatch = wpHtmlRegex.exec(normalizedBlog)) !== null) {
    wpHtmlRanges.push([wpMatch.index, wpMatch.index + wpMatch[0].length]);
  }

  // Also exclude <script> blocks (FAQ schema)
  const scriptRegex = /<script[\s\S]*?<\/script>/gi;
  while ((wpMatch = scriptRegex.exec(normalizedBlog)) !== null) {
    wpHtmlRanges.push([wpMatch.index, wpMatch.index + wpMatch[0].length]);
  }

  if (process.env.DEBUG_SEO === "true") {
    console.log(`[SEO-DEBUG] STEP 2b - wp:html blocks found: ${wpHtmlRanges.length}`);
    wpHtmlRanges.forEach(([s, e], i) => {
      console.log(`  Block ${i + 1}: [${s}-${e}] "${normalizedBlog.substring(s, Math.min(e, s + 80))}..."`);
    });
  }

  // Step 3: Classify — exclude links inside wp:html/script blocks, deduplicate by href
  const uniqueInternalLinks = new Set<string>();
  const uniqueExternalLinks = new Set<string>();
  let langSwitcherLinks = 0;

  for (let i = 0; i < extractedHrefs.length; i++) {
    const href = extractedHrefs[i];
    const pos = extractedHrefPositions[i];

    // Check if position falls inside any wp:html or script block
    const isInBlock = wpHtmlRanges.some(([start, end]) => pos >= start && pos < end);
    if (isInBlock) {
      if (href.startsWith("/blog/") || href.startsWith("/zh/")) {
        langSwitcherLinks++;
      }
      continue;
    }

    if (href.startsWith("/blog/")) {
      uniqueInternalLinks.add(href);
    } else if (href.startsWith("http")) {
      uniqueExternalLinks.add(href);
    }
  }

  // Also count external links stored in blog_versions.external_links array
  if (storedExternalLinks) {
    for (const link of storedExternalLinks) {
      if (link.startsWith("http")) {
        uniqueExternalLinks.add(link);
      }
    }
  }

  const internalLinks = uniqueInternalLinks.size;
  const externalLinks = uniqueExternalLinks.size;

  if (process.env.DEBUG_SEO === "true") {
    console.log(`[SEO-DEBUG] STEP 3 - Classified:`);
    console.log(`  Internal (/blog/): ${internalLinks}`);
    console.log(`  Language switcher (/zh/): ${langSwitcherLinks} (excluded from count)`);
    console.log(`  External (http): ${externalLinks}`);
    console.log("========================================");
  }
  if (internalLinks >= 3 && internalLinks <= 5) {
    checks.push({ label: "Internal Links", description: `${internalLinks} unique internal links found (target: 3-5).`, status: "pass", score: 100, fix: "", category: "Links" });
  } else if (internalLinks < 3) {
    checks.push({ label: "Internal Links", description: `Only ${internalLinks} unique internal links found.`, status: "warning", score: internalLinks > 0 ? 50 : 0, fix: `Add ${3 - internalLinks} more internal links to relevant B2I Hub blog posts. Target 3-5 unique internal links.`, category: "Links" });
  } else {
    checks.push({ label: "Internal Links", description: `${internalLinks} unique internal links — above target.`, status: "warning", score: 70, fix: "Keep internal links to 3-5 unique links per article.", category: "Links" });
  }

  // 8. External links count
  if (externalLinks >= 2) {
    checks.push({ label: "External Links", description: `${externalLinks} external links found (target: 2-5).`, status: "pass", score: 100, fix: "", category: "Links" });
  } else {
    checks.push({ label: "External Links", description: `Only ${externalLinks} external links found.`, status: "warning", score: externalLinks > 0 ? 50 : 0, fix: "Add 2-3 links to high-authority external sources (statistics, studies, official documentation).", category: "Links" });
  }

  // 9. Paragraph length
  const longParagraphs = paragraphCounts.filter((p) => p.sentences > 4);
  if (longParagraphs.length === 0) {
    checks.push({ label: "Paragraph Length", description: "All paragraphs are 4 sentences or fewer.", status: "pass", score: 100, fix: "", category: "Readability" });
  } else {
    checks.push({ label: "Paragraph Length", description: `${longParagraphs.length} paragraph(s) exceed 4 sentences.`, status: "warning", score: Math.max(20, 100 - longParagraphs.length * 20), fix: "Break long paragraphs into smaller ones. Aim for 2-3 sentences per paragraph for online readability.", category: "Readability" });
  }

  // 10. Image alt text
  const images = blog.match(/<img[^>]*>/gi) || [];
  const imagesWithAlt = images.filter((img) => /alt=["'][^"']+["']/i.test(img));
  if (images.length === 0) {
    checks.push({ label: "Image Alt Text", description: "No images found in content.", status: "warning", score: 60, fix: "Add relevant images with descriptive alt text to improve accessibility and SEO.", category: "Accessibility" });
  } else if (imagesWithAlt.length === images.length) {
    checks.push({ label: "Image Alt Text", description: `All ${images.length} image(s) have alt text.`, status: "pass", score: 100, fix: "", category: "Accessibility" });
  } else {
    const missing = images.length - imagesWithAlt.length;
    checks.push({ label: "Image Alt Text", description: `${missing} of ${images.length} image(s) missing alt text.`, status: "fail", score: 0, fix: `Add descriptive alt text to the ${missing} image(s) that are missing it.`, category: "Accessibility" });
  }

  // 11. FAQ schema presence
  if (/<script\s[^>]*type="application\/ld\+json"[^>]*>/i.test(blog) && /FAQPage/i.test(blog)) {
    checks.push({ label: "FAQ Schema", description: "FAQPage JSON-LD schema found in content.", status: "pass", score: 100, fix: "", category: "Structured Data" });
  } else if (/<script\s[^>]*type="application\/ld\+json"[^>]*>/i.test(blog)) {
    checks.push({ label: "FAQ Schema", description: "JSON-LD found but no FAQPage schema detected.", status: "warning", score: 50, fix: "Add FAQPage structured data with 4-6 question/answer pairs.", category: "Structured Data" });
  } else {
    checks.push({ label: "FAQ Schema", description: "No JSON-LD structured data found.", status: "fail", score: 0, fix: "Add FAQPage schema JSON-LD block with 4-6 questions and answers.", category: "Structured Data" });
  }

  // 12. Reading level (Flesch-Kincaid)
  const readingEase = fleshReadingEase(bodyText);
  if (readingEase >= FLESCH_MIN && readingEase <= FLESCH_MAX) {
    checks.push({ label: "Reading Level", description: `Flesch Reading Ease score is ${Math.round(readingEase)} (target: ${FLESCH_MIN}-${FLESCH_MAX} / Grade 8-10).`, status: "pass", score: 100, fix: "", category: "Readability" });
  } else if (readingEase < FLESCH_MIN) {
    checks.push({ label: "Reading Level", description: `Flesch Reading Ease score is ${Math.round(readingEase)} — too complex (target: ${FLESCH_MIN}-${FLESCH_MAX}).`, status: "warning", score: 50, fix: "Simplify sentences. Use shorter words and shorter sentences. Avoid jargon.", category: "Readability" });
  } else {
    checks.push({ label: "Reading Level", description: `Flesch Reading Ease score is ${Math.round(readingEase)} — very easy to read (target: ${FLESCH_MIN}-${FLESCH_MAX}).`, status: "pass", score: 100, fix: "", category: "Readability" });
  }

  const overallScore = Math.round(checks.reduce((sum, c) => sum + c.score, 0) / checks.length);

  return {
    overallScore,
    checks,
    summary: {
      passed: checks.filter((c) => c.status === "pass").length,
      warnings: checks.filter((c) => c.status === "warning").length,
      failed: checks.filter((c) => c.status === "fail").length,
    },
  };
}
