import { SEO_TITLE_MIN, SEO_TITLE_MAX, FLESCH_MIN, FLESCH_MAX, DEFAULT_WORD_COUNT, keyphraseTarget, keyphraseRangeForWordCount } from "./generation-constants";

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
    parts.push(`## Internal Linking Instructions

You are an expert at naturally integrating internal links. Follow these rules:

1. **Never force links.** Only link when it genuinely adds value to the reader.
2. **Link where relevant.** Place links in sections where the linked content is a natural next step.
3. **Use contextual anchor text.** The link text should flow naturally in the sentence. Never use generic anchors like "click here" or "read more."
4. **Use 3-5 UNIQUE internal links. Do NOT repeat the same link more than once. If you have only 2 unique links, add a third.** Language switcher, CTA, and schema links are excluded from this count.
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
    parts.push(`## MANDATORY OUTPUT REQUIREMENTS

The following elements are NON-NEGOTIABLE and MUST be present in every generated blog post. Failure to include any of them means the output is rejected.

1. **CTA Block**: You MUST include the EXACT HTML from the CTA Block section above. The CTA must say "B2I Hub" — never use placeholders like "[Contact our team]" or "[Sign up]". Paste the CTA HTML verbatim between the last H2 section and the FAQ.

2. **Internal Links**: You MUST include 3-5 UNIQUE internal content links. Do NOT repeat the same link more than once. If you have only 2 unique links, add a third. Aim for 4, never exceed 5. Only link where it genuinely adds value to the reader.

3. **FAQ Schema JSON-LD**: You MUST include a \`<script type="application/ld+json">\` block containing FAQPage schema with 4-6 question/answer pairs. This must be valid JSON-LD.

4. **Language Switcher**: You MUST include the language switcher HTML block as the FIRST content element, linking the EN and ZH versions (append -zh to the Chinese slug).

5. **WordPress Block Format**: Every content element MUST use WordPress block format (<!-- wp:paragraph -->, <!-- wp:heading -->, <!-- wp:list -->, <!-- wp:html -->). No bare Markdown in the final blog output.

6. **Categories and Tags**: Always assign "Creator Economy" and "Resources" as categories. Include 5-8 relevant lowercase tags.

7. **Meta Description Length**: metaDescription MUST be 155-200 characters. Count every character. If under 155, expand. If over 200, shorten. Do NOT finalize until it's exactly in this range. This is a hard requirement — not a suggestion.
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
  const kpRange = keyphraseRangeForWordCount(targetWords);
  const kpTarget = keyphraseTarget(targetWords);

  parts.push(`## NON-NEGOTIABLE HARD REQUIREMENTS

The following 4 requirements are NOT NEGOTIABLE. The blog is INVALID if any of them is not met. DO NOT SKIP any of these.

1. **Focus keyphrase count**: Use the exact keyphrase naturally approximately ${kpTarget} times throughout the body. The acceptable range is ${kpRange.min}–${kpRange.max}. Do not force repetitions — natural placement is more important than hitting an exact number.

2. **Focus keyphrase in H2**: The focus keyphrase MUST appear in at least one H2 heading. This is a hard requirement — the blog is INVALID if it doesn't. DO NOT SKIP THIS.

3. **Reading ease**: Write at Flesch Reading Ease ${FLESCH_MIN}-${FLESCH_MAX}. Use simple words, short sentences. Avoid jargon. This is a hard requirement — the blog is INVALID if the score is below ${FLESCH_MIN}. DO NOT SKIP THIS.

4. **SEO title length**: SEO title MUST be ${SEO_TITLE_MIN}-${SEO_TITLE_MAX} characters. Count characters. This is a hard requirement — the blog is INVALID if it's outside this range.`);

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
- [ ] Focus keyphrase appears in at least one H2 heading → if NOT, rewrite an H2 to include it
- [ ] Flesch Reading Ease is ${FLESCH_MIN}-${FLESCH_MAX} → if below ${FLESCH_MIN}, simplify sentences and use shorter words
- [ ] Focus keyphrase appears ${kpTarget} times in body → if fewer, add more mentions naturally
- [ ] SEO title is ${SEO_TITLE_MIN}-${SEO_TITLE_MAX} characters → if not, adjust

**Output format**: You MUST respond with a valid JSON object with the following structure:

\`\`\`json
{
  "title": "SEO-optimized blog title",
  "slug": "url-friendly-slug",
  "metaDescription": "Compelling meta description — MUST be 155-200 characters",
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
