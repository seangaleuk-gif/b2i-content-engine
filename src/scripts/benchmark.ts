/**
 * Phase 6 Benchmark Script
 * Directly calls the generation pipeline to produce and measure blog articles.
 * Run with: npx tsx src/scripts/benchmark.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { AiService } from "@/lib/services/deepseek";
import { buildSystemPrompt, STAGE_SYSTEM_PROMPTS } from "@/lib/services/prompt-builder";
import { cleanBodyText, countWords } from "@/lib/services/text-utils";
import { DEFAULT_PROMPTS } from "@/lib/services/default-prompts";
import { fixTitle, fixKeyphraseDensity, fixReadability } from "@/lib/services/fixers";

// ── Test dataset ──
const TOPICS = [
  { name: "AI-Powered Creator Marketing in Hong Kong", keyword: "AI creator marketing", audience: "SME owners", country: "HK", wordCount: 2000 },
  { name: "How Hong Kong Restaurants Can Use Influencer Marketing", keyword: "restaurant influencer marketing", audience: "Restaurant owners", country: "HK", wordCount: 2500 },
  { name: "Fitness Creators in Hong Kong: Monetisation Guide", keyword: "fitness creator monetisation", audience: "Fitness creators", country: "HK", wordCount: 2000 },
  { name: "Beauty Brand Collaborations: HK Creator Edition", keyword: "beauty brand collaborations HK", audience: "Beauty brands", country: "HK", wordCount: 2500 },
  { name: "Tech Startups Finding Creators in Hong Kong", keyword: "tech startup creators HK", audience: "Tech startups", country: "HK", wordCount: 2000 },
];

// Mock context (no DB needed — uses DEFAULT_PROMPTS directly)
function buildContext(topic: typeof TOPICS[0]) {
  const promptSections = Object.entries(DEFAULT_PROMPTS).map(([key, content]) => ({
    key,
    label: key,
    content,
  }));

  return {
    project: {
      name: topic.name,
      keyword: topic.keyword,
      audience: topic.audience,
      country: topic.country,
      wordCount: topic.wordCount,
      content: "",
      status: "draft",
    },
    research: [
      { category: "web", title: `${topic.keyword} trends 2026`, snippet: `Latest developments in ${topic.keyword} across Hong Kong. Businesses are seeing 40% higher engagement.`, url: "https://example.com/trends" },
      { category: "web", title: `${topic.keyword} case study`, snippet: `A Hong Kong brand achieved 3x ROI using ${topic.keyword} strategies with local creators.`, url: "https://example.com/case-study" },
      { category: "discussion", title: `Reddit: ${topic.keyword} discussion`, snippet: `Community asks: How to start with ${topic.keyword} on a small budget in Hong Kong?`, url: "https://reddit.com/r/hk" },
      { category: "faq", title: `Common questions about ${topic.keyword}`, snippet: `What platforms work best? How much budget is needed? How to find the right creators?`, url: "https://example.com/faq" },
      { category: "news", title: `News: ${topic.keyword} growth`, snippet: `Hong Kong's creator economy grew 35% in 2025, driven by ${topic.keyword} adoption.`, url: "https://example.com/news" },
    ],
    knowledge: [
      { title: "B2I Hub Platform Guide", content: "B2I Hub connects Hong Kong creators directly with businesses. No agencies, no commissions.", tags: ["platform", "hk"] },
      { title: "Hong Kong Creator Economy Report", content: "The HK creator economy is valued at $2.5B HKD with 15% annual growth.", tags: ["research", "hk"] },
    ],
    promptSections,
  };
}

// ── Flesch helpers ──
function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  let count = 0, prevVowel = false;
  for (const ch of word) {
    const v = "aeiou".includes(ch);
    if (v && !prevVowel) count++;
    prevVowel = v;
  }
  if (word.endsWith("e")) count--;
  return Math.max(1, count);
}

function fleschScore(text: string): number {
  const cleaned = cleanBodyText(text);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const sentences = cleaned.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (words.length === 0 || sentences.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
}

// ── Metrics collection ──
interface ArticleMetrics {
  topic: string;
  wordCount: number;
  readingEase: number;
  titleLength: number;
  metaLength: number;
  keyphraseCount: number;
  keyphraseInH2: boolean;
  h2Count: number;
  generationTimeMs: number;
  fixerCalls: number;
  passed: boolean;
  failures: string[];
}

// ── Run pipeline for one topic ──
async function generateArticle(topic: typeof TOPICS[0]): Promise<ArticleMetrics> {
  const startTime = Date.now();
  const context = buildContext(topic);
  const keyphrase = topic.keyword.toLowerCase();
  let fixerCalls = 0;
  const failures: string[] = [];

  const ai = new AiService();
  const chatWithRetry = ai.chatWithRetry;

  // PHASE A: Outline
  const outlineSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.outline);
  const outlineUserMsg = `## Project Details\nProject: ${topic.name}\nKeyword: ${topic.keyword}\n\nGenerate title, slug, meta, and 4-6 H2 headings. Return JSON: {"title": "...", "slug": "...", "metaDescription": "...", "h2Headings": [...]}`;
  const outlineRes = await chatWithRetry(
    [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlineUserMsg }],
    { responseFormat: { type: "json_object" }, maxTokens: 8192 }
  );
  const outline = JSON.parse(outlineRes.content);
  const h2Headings: string[] = outline.h2Headings || [];
  const generated = { title: outline.title || "Untitled", metaDescription: outline.metaDescription || "", blog: "" };

  // PHASE B: Introduction
  const introSystem = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.introduction);
  const introRes = await chatWithRetry(
    [{ role: "system", content: introSystem }, { role: "user", content: `Write a 2-3 paragraph introduction for: "${generated.title}". Return JSON: {"intro": "..."}` }],
    { responseFormat: { type: "json_object" }, maxTokens: 4096 }
  );
  const intro = JSON.parse(introRes.content).intro || "";

  // PHASE C: Sections (app-owned headings)
  const sections: string[] = [intro];
  let kpH2Index = -1;
  if (keyphrase && h2Headings.length > 0) {
    const skip = /mistake|avoid|faq|conclusion|summary|final|wrap.?up/i;
    const kpWords = keyphrase.split(/\s+/);
    for (let i = 0; i < h2Headings.length; i++) {
      const h = h2Headings[i].toLowerCase();
      if (skip.test(h)) continue;
      if (kpWords.some((w) => h.includes(w))) { kpH2Index = i; break; }
    }
    if (kpH2Index === -1) {
      for (let i = 0; i < h2Headings.length; i++) {
        if (!skip.test(h2Headings[i].toLowerCase())) { kpH2Index = i; break; }
      }
    }
    if (kpH2Index === -1) kpH2Index = 0;
    h2Headings[kpH2Index] = `${keyphrase}: ${h2Headings[kpH2Index]}`;
  }

  const sectionSystem = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.section);
  for (let i = 0; i < h2Headings.length; i++) {
    const h2Text = h2Headings[i];
    const prevH = i > 0 ? h2Headings[i - 1] : "(none)";
    const nextH = i < h2Headings.length - 1 ? h2Headings[i + 1] : "(none)";
    const secRes = await chatWithRetry(
      [{ role: "system", content: sectionSystem }, { role: "user", content: `Write body content (200-300 words) for heading: "${h2Text}". Previous: ${prevH}. Next: ${nextH}. Return JSON: {"body": "..."}` }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
    );
    const body = JSON.parse(secRes.content).body || "";
    sections.push(`<!-- wp:heading {"level":2} -->\n<h2>${h2Text}</h2>\n<!-- /wp:heading -->\n${body}`);
  }

  // PHASE D: FAQ
  const faqSystem = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.faq);
  const faqRes = await chatWithRetry(
    [{ role: "system", content: faqSystem }, { role: "user", content: `Generate 4-6 FAQ for: "${generated.title}". Return JSON: {"faqSchemaBlock": "..."}` }],
    { responseFormat: { type: "json_object" }, maxTokens: 8192 }
  );
  sections.push(JSON.parse(faqRes.content).faqSchemaBlock || "");

  // PHASE E: Conclusion
  const concSystem = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.conclusion);
  const concRes = await chatWithRetry(
    [{ role: "system", content: concSystem }, { role: "user", content: `Write a 2-paragraph conclusion for: "${generated.title}". Return JSON: {"conclusion": "..."}` }],
    { responseFormat: { type: "json_object" }, maxTokens: 4096 }
  );
  sections.push(JSON.parse(concRes.content).conclusion || "");

  // Assemble
  generated.blog = sections.join("\n\n");

  // ── Validation ──
  const blogCleaned = cleanBodyText(generated.blog);

  // Title
  let titleOk = generated.title.length >= 50 && generated.title.length <= 70;
  if (!titleOk) {
    const titleResult = await fixTitle({ generated, chatWithRetry }, { currentLength: generated.title.length, targetMin: 50, targetMax: 70, keyphrase: topic.keyword });
    fixerCalls++;
    if (titleResult) generated.title = titleResult;
    titleOk = generated.title.length >= 50 && generated.title.length <= 70;
  }

  // Density
  let kpCount = keyphrase ? blogCleaned.toLowerCase().split(keyphrase).length - 1 : 0;
  let densityOk = kpCount >= 3 && kpCount <= 5;
  if (!densityOk && keyphrase) {
    const densResult = await fixKeyphraseDensity({ generated, chatWithRetry }, { keyphrase, currentCount: kpCount, targetMin: 3, targetMax: 5 });
    fixerCalls++;
    if (densResult) {
      generated.blog = densResult;
      kpCount = keyphrase ? cleanBodyText(generated.blog).toLowerCase().split(keyphrase).length - 1 : 0;
      densityOk = kpCount >= 3 && kpCount <= 5;
    }
  }

  // Readability
  let flesh = Math.round(fleschScore(generated.blog));
  let readOk = flesh >= 60 && flesh <= 70;
  if (!readOk) {
    const readResult = await fixReadability({ generated, chatWithRetry }, { currentFlesch: flesh, targetMin: 60, targetMax: 70 });
    fixerCalls++;
    if (readResult) {
      generated.blog = readResult;
      flesh = Math.round(fleschScore(generated.blog));
      readOk = flesh >= 60 && flesh <= 70;
    }
  }

  const finalWordCount = countWords(generated.blog);
  const h2InBlog = generated.blog.match(/<h2[^>]*>/gi) || [];
  const kpInH2 = keyphrase
    ? h2InBlog.map((h) => cleanBodyText(h).toLowerCase()).some((h) => h.includes(keyphrase))
    : true;

  if (!titleOk) failures.push(`title:${generated.title.length}`);
  if (!densityOk) failures.push(`density:${kpCount}`);
  if (!readOk) failures.push(`readability:${flesh}`);
  if (!kpInH2) failures.push("h2:0");

  return {
    topic: topic.name,
    wordCount: finalWordCount,
    readingEase: flesh,
    titleLength: generated.title.length,
    metaLength: generated.metaDescription.length,
    keyphraseCount: kpCount,
    keyphraseInH2: kpInH2,
    h2Count: h2InBlog.length,
    generationTimeMs: Date.now() - startTime,
    fixerCalls,
    passed: failures.length === 0,
    failures,
  };
}

// ── Statistics ──
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    avg: Math.round(sorted.reduce((s, v) => s + v, 0) / n),
    median: n % 2 === 0 ? Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2) : sorted[Math.floor(n / 2)],
    stddev: Math.round(Math.sqrt(sorted.reduce((s, v) => s + Math.pow(v - sorted.reduce((a, b) => a + b, 0) / n, 2), 0) / n)),
  };
}

// ── Main ──
async function main() {
  console.log("=== PHASE 6 BENCHMARK ===");
  console.log(`Topics: ${TOPICS.length}`);
  console.log("");

  const results: ArticleMetrics[] = [];
  for (let i = 0; i < TOPICS.length; i++) {
    console.log(`[${i + 1}/${TOPICS.length}] Generating: ${TOPICS[i].name}`);
    try {
      const result = await generateArticle(TOPICS[i]);
      results.push(result);
      console.log(`  ✓ ${result.passed ? "PASS" : "FAIL"} | ${result.wordCount} words | Flesch: ${result.readingEase} | KP: ${result.keyphraseCount} | H2: ${result.keyphraseInH2 ? "✓" : "✗"} | ${result.generationTimeMs}ms | ${result.fixerCalls} fixers`);
    } catch (err) {
      console.log(`  ✗ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n=== RESULTS ===");
  const passed = results.filter((r) => r.passed);
  const wc = stats(results.map((r) => r.wordCount));
  const flesh = stats(results.map((r) => r.readingEase));
  const titleLen = stats(results.map((r) => r.titleLength));
  const metaLen = stats(results.map((r) => r.metaLength));
  const kpCount = stats(results.map((r) => r.keyphraseCount));
  const kpH2 = results.filter((r) => r.keyphraseInH2).length;
  const time = stats(results.map((r) => r.generationTimeMs));
  const fixerAvg = Math.round(results.reduce((s, r) => s + r.fixerCalls, 0) / results.length);

  console.log(`\nPass rate: ${passed.length}/${results.length} (${Math.round(passed.length / results.length * 100)}%)`);
  console.log(`\n| Metric | Min | Max | Avg | Median | StdDev |`);
  console.log(`|--------|-----|-----|-----|--------|--------|`);
  console.log(`| Word Count | ${wc.min} | ${wc.max} | ${wc.avg} | ${wc.median} | ${wc.stddev} |`);
  console.log(`| Flesch Ease | ${flesh.min} | ${flesh.max} | ${flesh.avg} | ${flesh.median} | ${flesh.stddev} |`);
  console.log(`| Title Length | ${titleLen.min} | ${titleLen.max} | ${titleLen.avg} | ${titleLen.median} | ${titleLen.stddev} |`);
  console.log(`| Meta Length | ${metaLen.min} | ${metaLen.max} | ${metaLen.avg} | ${metaLen.median} | ${metaLen.stddev} |`);
  console.log(`| Keyphrase Count | ${kpCount.min} | ${kpCount.max} | ${kpCount.avg} | ${kpCount.median} | ${kpCount.stddev} |`);
  console.log(`| H2 Count | — | — | ${Math.round(results.reduce((s, r) => s + r.h2Count, 0) / results.length)} | — | — |`);
  console.log(`| Generation Time (ms) | ${time.min} | ${time.max} | ${time.avg} | ${time.median} | ${time.stddev} |`);
  console.log(`| Fixer Calls | — | — | ${fixerAvg} | — | — |`);
  console.log(`\nKeyphrase in H2: ${kpH2}/${results.length} (${Math.round(kpH2 / results.length * 100)}%)`);

  if (results.some((r) => r.failures.length > 0)) {
    console.log("\n=== FAILURES ===");
    for (const r of results.filter((r) => r.failures.length > 0)) {
      console.log(`  ${r.topic}: ${r.failures.join(", ")}`);
    }
  }

  console.log("\n=== PER-ARTICLE DETAIL ===");
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} "${r.topic.substring(0, 50)}..." | ${r.wordCount}w | F:${r.readingEase} | T:${r.titleLength} | M:${r.metaLength} | KP:${r.keyphraseCount} | H2:${r.h2Count} | ${r.generationTimeMs}ms`);
  }

  console.log("\n=== DONE ===");
}

main().catch(console.error);
