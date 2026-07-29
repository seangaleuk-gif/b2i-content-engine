#!/usr/bin/env tsx
// ── Run a real production generation without publishing ──
// Requires: DEEPSEEK_API_KEY, SUPABASE_SERVICE_ROLE_KEY env vars

import { runBlogGeneration } from "../src/lib/services/blog-generation-service";
import { createClient } from "@supabase/supabase-js";
import { countReadableWords } from "../src/lib/seo/seo-text-utils";
import { analyzeFinalArticle, buildPolicy } from "../src/lib/blog/final-article-policy";

const RUN_NUMBER = process.argv[2] ? parseInt(process.argv[2], 10) : 1;

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Use existing project 16
  const projectId = 16;
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();

  if (!project) {
    console.error(`Project ${projectId} not found`);
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(`RUN ${RUN_NUMBER}: Generating article for project ${projectId}`);
  console.log(`  Title: Threads Marketing Hong Kong: A Practical Guide for SMEs`);
  console.log(`  Target: 2500 words`);
  console.log("=".repeat(70));

  const userId = project.user_id;
  const maxObservedConcurrency = (globalThis as any).__maxObservedConcurrency;

  let result: any;
  try {
    result = await runBlogGeneration(userId, projectId);
  } catch (err: any) {
    console.error(`\n❌ RUN ${RUN_NUMBER} FAILED:`, err.message);
    process.exit(1);
  }

  const blog = result.generated?.blog || result.pipelineState?.blog || "";
  const finalTitle = result.generated?.title || "";
  const finalMeta = result.generated?.metaDescription || "";
  const keyphrase = "Threads marketing Hong Kong";
  const wordMin = result.wordMin ?? 2125;
  const wordMax = result.wordMax ?? 2875;

  // Metrics — using same function as route's post-save validation
  const wc = countReadableWords(blog);
  const metrics = analyzeFinalArticle(blog, keyphrase, finalTitle, finalMeta);
  const policy = buildPolicy(2500, wordMin, wordMax, keyphrase);

  // Route-equivalent post-save validation (same checks with same helpers)
  if (wc < wordMin || wc > wordMax) {
    console.error(`[POST-SAVE] FAILED: word count ${wc} outside ${wordMin}-${wordMax}`);
    process.exit(1);
  }
  if (metrics.longParagraphCount > 0) {
    console.error(`[POST-SAVE] FAILED: ${metrics.longParagraphCount} long paragraphs`);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log(`RUN ${RUN_NUMBER} RESULTS:`);
  console.log("=".repeat(70));
  console.log(`  Word count: ${metrics.readableWordCount}`);
  console.log(`  Allowed range: 2125–2875`);
  console.log(`  H2 count: ${metrics.h2Count}`);
  console.log(`  FAQ entries: ${metrics.faqEntryCount}`);
  console.log(`  Long paragraphs: ${metrics.longParagraphCount}`);
  console.log(`  Signup URLs: ${metrics.signupUrlCount}`);
  console.log(`  CTA headings: ${metrics.ctaHeadingCount}`);
  console.log(`  FAQ blocks: ${metrics.faqBlockCount}`);
  console.log(`  FAQ schema: ${metrics.faqJsonLdCount}`);
  console.log(`  FAQ parity valid: ${metrics.faqParityValid}`);
  console.log(`  Language switcher: ${metrics.hasLanguageSwitcher}`);
  console.log(`  Nested paragraphs: ${metrics.nestedParagraphCount}`);
  console.log(`  Malformed headings: ${metrics.malformedHeadingCount}`);
  console.log(`  WP block mismatch: ${metrics.wpBlockCountMismatch}`);
  console.log(`  Has conclusion: ${metrics.hasConclusionContent}`);
  console.log(`  Has placeholder: ${metrics.hasPlaceholderContent}`);
  console.log(`  Duplicate FAQ schema: ${metrics.duplicateFaqSchemaCount}`);
  console.log(`  Duplicate CTA blocks: ${metrics.duplicateCtaBlockCount}`);
  console.log(`  KP stuffing: ${metrics.keyphraseDensity.toFixed(2)}%`);
  console.log(`  Internal links (unique): ${metrics.uniqueInternalLinkCount}`);
  console.log(`  External source links: ${metrics.externalSourceLinkCount}`);
  console.log(`  Stage outputs: ${result.pipelineState?.stageOutputs?.length || 0}`);
  console.log(`  Max concurrency: ${(globalThis as any).__maxObservedConcurrency || "N/A"}`);
  console.log("");

  // Validate
  const passed = wc >= wordMin && wc <= wordMax
    && metrics.h2Count >= 6 && metrics.h2Count <= 7
    && metrics.longParagraphCount === 0
    && metrics.signupUrlCount === 1
    && metrics.ctaHeadingCount >= 1
    && metrics.faqBlockCount >= 1
    && metrics.faqJsonLdCount >= 1
    && metrics.faqParityValid
    && metrics.hasLanguageSwitcher
    && metrics.nestedParagraphCount === 0
    && metrics.malformedHeadingCount === 0
    && !metrics.wpBlockCountMismatch
    && metrics.hasConclusionContent
    && !metrics.hasPlaceholderContent
    && metrics.duplicateFaqSchemaCount === 0
    && metrics.duplicateCtaBlockCount === 0
    && metrics.keyphraseDensity <= 3
    && metrics.uniqueInternalLinkCount <= 4
    && metrics.externalSourceLinkCount >= 0;

  if (passed) {
    console.log(`✅ RUN ${RUN_NUMBER} PASSED`);
  } else {
    console.log(`❌ RUN ${RUN_NUMBER} FAILED validation`);
    if (wc < 2125 || wc > 2875) console.log(`  - Word count ${wc} outside 2125-2875`);
    if (metrics.h2Count < 6 || metrics.h2Count > 7) console.log(`  - H2 count ${metrics.h2Count} not 6-7`);
    if (metrics.longParagraphCount > 0) console.log(`  - ${metrics.longParagraphCount} long paragraphs`);
    if (metrics.signupUrlCount !== 1) console.log(`  - signup URLs: ${metrics.signupUrlCount}`);
    if (metrics.ctaHeadingCount < 1) console.log(`  - CTA headings: ${metrics.ctaHeadingCount}`);
    if (metrics.faqBlockCount < 1) console.log(`  - FAQ blocks: ${metrics.faqBlockCount}`);
    if (metrics.faqJsonLdCount < 1) console.log(`  - FAQ schema: ${metrics.faqJsonLdCount}`);
    if (!metrics.faqParityValid) console.log(`  - FAQ parity invalid`);
    if (!metrics.hasLanguageSwitcher) console.log(`  - No language switcher`);
    if (metrics.nestedParagraphCount > 0) console.log(`  - Nested paragraphs: ${metrics.nestedParagraphCount}`);
    if (metrics.malformedHeadingCount > 0) console.log(`  - Malformed headings: ${metrics.malformedHeadingCount}`);
    if (metrics.wpBlockCountMismatch) console.log(`  - WP block mismatch`);
    if (!metrics.hasConclusionContent) console.log(`  - No conclusion`);
    if (metrics.hasPlaceholderContent) console.log(`  - Has placeholder content`);
    if (metrics.duplicateFaqSchemaCount > 0) console.log(`  - Duplicate FAQ schemas`);
    if (metrics.duplicateCtaBlockCount > 0) console.log(`  - Duplicate CTA blocks`);
    if (metrics.keyphraseDensity > 3) console.log(`  - KP stuffing: ${metrics.keyphraseDensity.toFixed(2)}%`);
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(`NO ARTICLE WAS PUBLISHED.`);
  console.log("HTML conclusion translation remains authoritative.");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error(`\n❌ RUN ${RUN_NUMBER} FAILED:`, err.message);
  process.exit(1);
});
