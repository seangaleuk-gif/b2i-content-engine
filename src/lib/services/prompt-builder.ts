import { FACTUALITY_INSTRUCTION } from "./generation-constants";
import {
  englishTitleRange,
  englishMetaRange,
  dynamicH2Range,
  dynamicFaqRange,
  computeKeyphraseTargets,
  getKeyphraseContentWordCount,
  internalLinkRange,
  paragraphSentenceLimit,
} from "@/lib/content-standards";

const DEFAULT_WORD_COUNT = 2500;

export interface PromptSection {
  key: string;
  label: string;
  content: string;
}

export interface BlogContext {
  project: {
    name: string;
    keyword: string;
    audience: string;
    country: string;
    wordCount: number;
    content: string;
    status: string;
  };
  research: {
    category: string;
    title: string;
    snippet: string;
    url: string;
  }[];
  knowledge: {
    title: string;
    content: string;
    tags: string[];
  }[];
  promptSections: PromptSection[];
}

function findSection(sections: PromptSection[], key: string): string {
  const section = sections.find((s) => s.key === key);
  return section?.content?.trim() ?? "";
}

function formatProjectDetails(project: BlogContext["project"]): string {
  const lines: string[] = [
    `Project Name: ${project.name}`,
    `Target Keyword: ${project.keyword}`,
    `Target Audience: ${project.audience}`,
    `Target Country: ${project.country}`,
    `Target Word Count: ${project.wordCount}`,
    `Status: ${project.status}`,
  ];

  return lines.join("\n");
}

function formatResearch(research: BlogContext["research"]): string {
  if (!research.length) return "";

  const lines: string[] = [];

  const grouped = new Map<string, BlogContext["research"]>();
  for (const item of research) {
    const group = grouped.get(item.category) ?? [];
    group.push(item);
    grouped.set(item.category, group);
  }

  for (const [category, items] of grouped) {
    lines.push(`## ${category.toUpperCase()}`);
    for (const item of items) {
      lines.push(`- **${item.title}**`);
      lines.push(`  ${item.snippet}`);
      if (item.url) {
        lines.push(`  Source: ${item.url}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function filterRelevantKnowledge(
  knowledge: BlogContext["knowledge"],
  keyword: string
): BlogContext["knowledge"] {
  if (!knowledge.length) return [];
  if (!keyword) return knowledge.slice(0, 5);

  const lowerKeyword = keyword.toLowerCase();
  const keywordParts = lowerKeyword.split(/\s+/).filter((p) => p.length > 2);

  const scored = knowledge.map((item) => {
    let score = 0;
    const titleLower = item.title.toLowerCase();
    const contentLower = item.content.toLowerCase();

    if (titleLower.includes(lowerKeyword)) score += 10;
    if (contentLower.includes(lowerKeyword)) score += 5;

    for (const tag of item.tags) {
      if (tag.toLowerCase().includes(lowerKeyword)) score += 3;
    }

    for (const part of keywordParts) {
      if (titleLower.includes(part)) score += 2;
      if (contentLower.includes(part)) score += 1;
    }

    return { item, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.item);
}

function formatKnowledge(knowledge: BlogContext["knowledge"], keyword: string): string {
  const relevant = filterRelevantKnowledge(knowledge, keyword);
  if (!relevant.length) return "";

  const lines: string[] = [];
  for (const item of relevant) {
    lines.push(`### ${item.title}`);
    lines.push(item.content);
    if (item.tags.length) {
      lines.push(`Tags: ${item.tags.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export const STAGE_SYSTEM_PROMPTS: Record<string, string[]> = {
  outline:      ["brand_voice", "seo_rules", "formatting_rules", "hong_kong_context", "blog_structure"],
  introduction: ["brand_voice", "seo_rules", "formatting_rules", "hong_kong_context"],
  section:      ["brand_voice", "seo_rules", "formatting_rules", "hong_kong_context", "blog_structure"],
  faq:          ["brand_voice", "seo_rules", "formatting_rules"],
  conclusion:   ["brand_voice", "formatting_rules", "cta"],
};

export function buildSystemPrompt(context: BlogContext, modules?: string[]): string {
  const sections = context.promptSections;
  const parts: string[] = [];
  const isFull = modules === undefined;
  const include = modules ? new Set(modules) : null;

  // Factuality — always included for every stage
  parts.push(FACTUALITY_INSTRUCTION);

  // CRITICAL FORMAT — always included for every stage
  parts.push(`CRITICAL FORMAT REQUIREMENT: The blog content in your JSON response MUST use WordPress block format. Every heading must be <!-- wp:heading {"level":2} --> or <!-- wp:heading {"level":3} -->, every paragraph <!-- wp:paragraph -->, every list <!-- wp:list -->, every quote <!-- wp:quote -->, every table <!-- wp:table -->. Custom HTML (language switcher, CTA, FAQ schema) uses <!-- wp:html -->. NEVER use Markdown (##, **, backtick, [], etc.) or bare HTML tags. This is NON-NEGOTIABLE. If you output Markdown, the response is invalid.`);

  // Brand Voice
  if (isFull || include?.has("brand_voice")) {
    parts.push(`## Brand Voice\n\n${findSection(sections, "brand_voice")}`);
  }

  // Hong Kong Context
  if (isFull || include?.has("hong_kong_context")) {
    parts.push(`## Regional Context\n\n${findSection(sections, "hong_kong_context")}`);
  }

  // Internal Linking — full-context only (not for individual sections)
  if (isFull) {
    const linkR = internalLinkRange();
    parts.push(`## Internal Linking Instructions

You are an expert at naturally integrating internal links. Follow these rules:

1. **Never force links.** Only link when it genuinely adds value to the reader.
2. **Link where relevant.** Place links in sections where the linked content is a natural next step.
3. **Use contextual anchor text.** The link text should flow naturally in the sentence. Never use generic anchors like "click here" or "read more."
4. **Use ${linkR.min}–${linkR.max} UNIQUE internal links. Do NOT repeat the same link more than once.** Language switcher, CTA, and schema links are excluded from this count.
5. **Prioritize quality over quantity.** If the topic doesn't naturally match a link, skip it.
    - /blog/creator-led-marketing-hong-kong — use when discussing creator partnerships or scaling creator relationships
    - /blog/content-that-converts — use when discussing content quality, ROI, or conversion
    - /blog/how-to-land-your-first-brand-deal-in-hong-kong-pitch-scripts-7-day-plan — use when discussing outreach, pitching, or first brand deals
    - /blog/how-much-can-hong-kong-influencers-really-earn-rates-packages-the-money-side — use when discussing pricing, earnings, or influencer income
    - /blog/become-brand-ready-hong-kong — use when discussing brand preparation or working with creators
    - /blog/where-hong-kong-micro-influencers-find-paid-brand-deals-platforms-outreach — use when discussing monetization, sponsorships, or finding brand deals
    - /blog/how-to-close-better-deals-negotiation-media-kits-b2i-hub-verification — use when discussing contracts, media kits, negotiation, or B2I Hub verification

6. **Never force a link.** If no section naturally fits a resource, skip it. Quality over quantity.`);
  }

  // SEO Rules
  if (isFull || include?.has("seo_rules")) {
    parts.push(`## SEO Rules\n\n${findSection(sections, "seo_rules")}`);
  }

  // Formatting Rules
  if (isFull || include?.has("formatting_rules")) {
    parts.push(`## Formatting Rules\n\n${findSection(sections, "formatting_rules")}`);
  }

  // Blog Structure
  if (isFull || include?.has("blog_structure")) {
    parts.push(`## Blog Structure\n\n${findSection(sections, "blog_structure")}`);
  }

  // CTA
  if (isFull || include?.has("cta")) {
    parts.push(`## CTA Block (Required)\n\n${findSection(sections, "cta")}`);
  }

  // Publish Checklist — full-context only
  if (isFull) {
    parts.push(`## Pre-Publish Checklist\n\n${findSection(sections, "publish_checklist")}`);
  }

  // Social Rules — full-context only
  if (isFull) {
    parts.push(`## Social Media Rules\n\n${findSection(sections, "social_rules")}`);
  }

  // Image Rules — full-context only
  if (isFull) {
    parts.push(`## Image Rules\n\n${findSection(sections, "image_rules")}`);
  }

  // Translation Rules — full-context only
  if (isFull) {
    parts.push(`## Translation Rules\n\n${findSection(sections, "translation_rules")}`);
  }

  // MANDATORY OUTPUT — full-context only (these are global article requirements)
  if (isFull) {
    const h2R = dynamicH2Range(context.project.wordCount || DEFAULT_WORD_COUNT);
    const faqR = dynamicFaqRange(context.project.wordCount || DEFAULT_WORD_COUNT);
    const linkR = internalLinkRange();
    const metaR = englishMetaRange();
    parts.push(`## MANDATORY OUTPUT REQUIREMENTS

The following elements are NON-NEGOTIABLE and MUST be present in every generated blog post. Failure to include any of them means the output is rejected.

1. **CTA Block**: You MUST include the EXACT HTML from the CTA Block section above. The CTA must say "B2I Hub" — never use placeholders like "[Contact our team]" or "[Sign up]". Paste the CTA HTML verbatim between the last H2 section and the FAQ.

2. **H2 Heading Count**: You MUST include ${h2R.min}–${h2R.max} H2-level sections (not counting FAQ or conclusion H2s). Do not exceed ${h2R.max} editorial H2s.

3. **FAQ Section**: You MUST include a visible FAQ section with ${faqR.min}–${faqR.max} question-answer pairs, plus a matching FAQPage JSON-LD schema.

4. **Internal Links**: You MUST include ${linkR.min}–${linkR.max} unique internal content links. Do NOT repeat the same link. Only link where it genuinely adds value.

5. **Language Switcher**: You MUST include the language switcher HTML block as the FIRST content element, linking the EN and ZH versions (append -zh to the Chinese slug).

6. **WordPress Block Format**: Every content element MUST use WordPress block format (<!-- wp:paragraph -->, <!-- wp:heading -->, <!-- wp:list -->, <!-- wp:html -->). No bare Markdown.

7. **Categories and Tags**: Always assign "Creator Economy" and "Resources" as categories. Include 5-8 relevant lowercase tags.

8. **Meta Description Length**: metaDescription MUST be ${metaR.min}–${metaR.max} characters. This is a hard requirement.
`);
  }

  return parts.join("\n\n---\n\n");
}

function buildUserMessage(context: BlogContext): string {
  const sections = context.promptSections;
  const parts: string[] = [];

  const projectDetails = formatProjectDetails(context.project);
  parts.push(`## Project Details\n\n${projectDetails}`);

  const targetWords = context.project.wordCount > 0 ? context.project.wordCount : DEFAULT_WORD_COUNT;
  const { min: titleMin, max: titleMax } = englishTitleRange();
  const { min: metaMin, max: metaMax } = englishMetaRange();
  const h2Range = dynamicH2Range(targetWords);
  const faqRange = dynamicFaqRange(targetWords);
  const { min: linkMin, max: linkMax } = internalLinkRange();
  const maxSentences = paragraphSentenceLimit();
  const kpTargets = computeKeyphraseTargets(targetWords, context.project.keyword);
  const kpContentWords = getKeyphraseContentWordCount(context.project.keyword);

  parts.push(`## NON-NEGOTIABLE HARD REQUIREMENTS

The following 4 requirements are NOT NEGOTIABLE. The blog is INVALID if any of them is not met. DO NOT SKIP any of these.

1. **H2 heading count**: Create exactly ${h2Range.min}–${h2Range.max} H2-level sections, each containing 150–300 words of body content. Do NOT create more than ${h2Range.max} H2s.

2. **FAQ section**: Include a visible FAQ section at the end with ${faqRange.min}–${faqRange.max} question-answer pairs. Each FAQ must have a question (ending with ?) and a 2–3 sentence answer. Follow the FAQ section with the conclusion and then the CTA block.

3. **Focus keyphrase count**: Use the exact keyphrase naturally approximately ${kpTargets.preferred} times throughout the body (range ${kpTargets.min}–${kpTargets.max}). Do not force repetitions — natural placement is more important.

4. **Focus keyphrase in H2**: The focus keyphrase MUST appear in at least one H2 heading. This is a hard requirement — the blog is INVALID if it doesn't. DO NOT SKIP THIS.

5. **Internal links**: Include ${linkMin}–${linkMax} unique internal content links. Only link where genuinely relevant. Do not repeat the same link.

6. **SEO title length**: SEO title MUST be ${titleMin}–${titleMax} characters. Count characters. This is a hard requirement.

7. **SEO meta description**: metaDescription MUST be ${metaMin}–${metaMax} characters. This is a hard requirement.

8. **Paragraphs**: Keep every paragraph to a maximum of ${maxSentences} sentences. Split long paragraphs.`);

  const research = formatResearch(context.research);
  if (research) parts.push(`## Research Sources\n\n${research}`);

  const knowledge = formatKnowledge(context.knowledge, context.project.keyword);
  if (knowledge) parts.push(`## Knowledge Base\n\n${knowledge}`);

  const translationRules = findSection(sections, "translation_rules");
  parts.push(`## Translation Rules\n\n${translationRules}`);

  parts.push(`## Instructions

CRITICAL — MANDATORY LENGTH REQUIREMENT: You MUST write at minimum ${targetWords} words of body content. "Body content" means readable text only — headings, paragraphs, list items, and table cells. Do NOT count: HTML markup, WordPress block comments, JSON-LD schema code, Custom HTML blocks, or the internal/external links section. Count only the text a human would read. The application will assign exact word counts per section — plan your outline accordingly. If the BODY TEXT word count is under ${targetWords}, you have failed.

Write a complete, publication-ready blog post based on the project details, research, and knowledge base above.

**PRE-OUTPUT VALIDATION** — Before generating the JSON, verify ALL of these:
- [ ] H2 count is ${h2Range.min}–${h2Range.max} → if outside this range, adjust
- [ ] FAQ has ${faqRange.min}–${faqRange.max} Q&A pairs → if outside, adjust
- [ ] Focus keyphrase appears in at least one H2 heading → if NOT, rewrite an H2 to include it
- [ ] Focus keyphrase appears ${kpTargets.preferred} times in body (range ${kpTargets.min}–${kpTargets.max}) → if outside, adjust
- [ ] SEO title is ${titleMin}–${titleMax} characters → if not, adjust
- [ ] Internal links: ${linkMin}–${linkMax} unique → if outside, adjust
- [ ] Every paragraph has ≤ ${maxSentences} sentences → if any exceeds, split it

**Output format**: You MUST respond with a valid JSON object with the following structure:

\`\`\`json
{
  "title": "SEO-optimized blog title",
  "slug": "url-friendly-slug",
  "metaDescription": "Compelling meta description — MUST be ${metaMin}-${metaMax} characters",
  "excerpt": "A 2-3 sentence excerpt for previews",
  "blog": "Full blog content in WordPress block format ONLY. Every element MUST use WordPress blocks. NO Markdown (no ## headings, no **bold**, no inline code backticks, no - bullet lists, no bare HTML). Use: <!-- wp:heading --> for headings, <!-- wp:paragraph --> for paragraphs, <!-- wp:list --> for lists, <!-- wp:table --> for tables, <!-- wp:quote --> for blockquotes, <!-- wp:html --> for language switcher / CTA / FAQ schema. Keep paragraphs short (max 3 sentences per paragraph block).",
  "faq": [{ "question": "...", "answer": "..." }],
  "internalLinks": ["/relevant-page-1", "/relevant-page-2"],
  "externalLinks": ["https://authoritative-source.com"],
  "categories": ["category-1"],
  "tags": ["tag-1", "tag-2"],
  "readingTime": "X min read",
  "summary": "A brief summary of the blog post"
}
\`\`\`

Do not include any text outside the JSON object. The response must be parseable with JSON.parse().`);

  return parts.join("\n\n---\n\n");
}

export function buildBlogPrompt(context: BlogContext): {
  systemPrompt: string;
  userMessage: string;
} {
  return {
    systemPrompt: buildSystemPrompt(context),
    userMessage: buildUserMessage(context),
  };
}
