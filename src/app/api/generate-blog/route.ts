import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/services/auth";
import {
  projectRepository,
  researchRepository,
  knowledgeRepository,
  promptSectionRepository,
  blogVersionRepository,
  aiLogRepository,
} from "@/lib/repositories";
import { buildBlogPrompt, buildSystemPrompt, STAGE_SYSTEM_PROMPTS } from "@/lib/services/prompt-builder";
import { createDeepSeekClient } from "@/lib/services/deepseek";
import { fixTitle, fixKeyphraseDensity, fixReadability } from "@/lib/services/fixers";
import { cleanBodyText, countWords, robustJsonParse, repairMetaDescription } from "@/lib/services/text-utils";
import { SEO_TITLE_MIN, SEO_TITLE_MAX, META_MIN, META_MAX, KEYPHRASE_MIN, KEYPHRASE_MAX, FLESCH_MIN, FLESCH_MAX, DEFAULT_WORD_COUNT, WORD_ALLOCATION, keyphraseTarget } from "@/lib/services/generation-constants";

interface GeneratedBlog {
  title: string;
  slug: string;
  metaDescription: string;
  excerpt: string;
  blog: string;
  faq: { question: string; answer: string }[];
  internalLinks: string[];
  externalLinks: string[];
  categories: string[];
  tags: string[];
  readingTime: string;
  summary: string;
}

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const userId = await getCurrentUserId();
    const body = await request.json();
    const projectId = body.projectId;

    if (!projectId) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 }
      );
    }

    const project = await projectRepository.findByIdAndUser(
      Number(projectId),
      userId
    );

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // ===== LOG STEP 1: DATABASE VALUES =====
    console.log("[generate-blog:STEP1] Project from DB:");
    console.log(`  name: "${project.name}"`);
    console.log(`  keyword: "${project.keyword}"`);
    console.log(`  audience: "${project.audience}"`);
    console.log(`  country: "${project.country}"`);
    console.log(`  word_count (raw): ${(project as Record<string, unknown>).word_count} (type: ${typeof (project as Record<string, unknown>).word_count})`);
    console.log(`  status: "${project.status}"`);
    console.log(`  content length: ${(project.content ?? "").length} chars`);

    const research = await researchRepository.findByProject(Number(projectId));
    const knowledge = await knowledgeRepository.findByUser(userId);

    console.log(`[generate-blog:STEP1] Research items: ${research.length}`);
    console.log(`[generate-blog:STEP1] Knowledge items: ${knowledge.length}`);

    await promptSectionRepository.seedDefaults(userId);
    const promptSections = await promptSectionRepository.findByUser(userId);

    console.log(`[generate-blog:STEP1] Prompt sections: ${promptSections.length}`);
    const coreSections = ["brand_voice", "seo_rules", "formatting_rules", "hong_kong_context", "blog_structure", "cta", "publish_checklist"];
    for (const s of promptSections) {
      const key = (s as Record<string, unknown>).section_key as string;
      const content = (s.content ?? "") as string;
      const isCore = coreSections.includes(key);
      const prefix = isCore ? "✓" : " ";
      console.log(`  ${prefix} ${key}: ${content.length} chars — "${content.substring(0, 100).replace(/\n/g, ' ')}..."`);
    }

    const context = {
      project: {
        name: project.name,
        keyword: project.keyword,
        audience: project.audience,
        country: project.country,
        wordCount: Number((project as Record<string, unknown>).word_count ?? 0),
        content: project.content ?? "",
        status: project.status,
      },
      research: research.map((r) => ({
        category: r.category,
        title: r.title,
        snippet: r.snippet,
        url: r.url,
      })),
      knowledge: knowledge.map((k) => ({
        title: k.title,
        content: k.content,
        tags: k.tags,
      })),
      promptSections: promptSections.map((s) => ({
        key: (s as Record<string, unknown>).section_key as string ?? "",
        label: (s as Record<string, unknown>).section_key as string ?? "",
        content: s.content,
      })),
    };

    // ===== LOG STEP 2: PROMPT ASSEMBLY =====
    const { systemPrompt, userMessage } = buildBlogPrompt(context);

    const hasWordCount = userMessage.includes("Target Word Count");
    const hasWordCountSystem = systemPrompt.includes("Target Word Count");
    console.log(`[generate-blog:STEP2] System prompt: ${systemPrompt.length} chars`);
    console.log(`[generate-blog:STEP2] User message: ${userMessage.length} chars`);
    console.log(`[generate-blog:STEP2] Total prompt: ${systemPrompt.length + userMessage.length} chars`);
    console.log(`[generate-blog:STEP2] Contains word count in user message: ${hasWordCount}`);
    console.log(`[generate-blog:STEP2] Contains word count in system prompt: ${hasWordCountSystem}`);
    console.log(`[generate-blog:STEP2] User message starts with: "${userMessage.substring(0, 200)}..."`);

    // ===== LOG STEP 3: DEEPSEEK REQUEST =====
    console.log(`[generate-blog:STEP3] DeepSeek call params: { responseFormat: "json_object", maxTokens: 16384 }`);
    console.log(`[generate-blog:STEP3] Full prompt (system+user): ${systemPrompt.length + userMessage.length} chars`);

    // ===== FULL PROMPT DUMP =====
    console.log("=== SYSTEM PROMPT (first 2000 chars) ===");
    console.log(systemPrompt.substring(0, 2000));
    console.log("=== USER MESSAGE (FULL) ===");
    console.log(userMessage);
    console.log("=== USER MESSAGE END ===");

    // Research check
    const researchInjected = context.research && context.research.length > 0;
    console.log(`=== Research injected into prompt: ${researchInjected ? "YES" : "NO"} ===`);
    if (researchInjected) {
      console.log(`=== Research count: ${context.research.length} items ===`);
      const top = context.research.slice(0, 3);
      top.forEach((r, i) => {
        console.log(`  [${i + 1}] title: "${r.title}"`);
        console.log(`           snippet: "${r.snippet.substring(0, 120)}..."`);
        console.log(`           url: "${r.url}"`);
      });
    }

    console.log(`=== TOTALS: system=${systemPrompt.length} user=${userMessage.length} combined=${systemPrompt.length + userMessage.length} ===`);
    // ============================

    const { chatWithRetry } = createDeepSeekClient();
    const targetWordCount = context.project.wordCount;

    // ── PHASE A: Generate outline (title + H2 headings) ──
    console.log("[generate-blog:OUTLINE] Generating outline...");
    const outlineSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.outline);
    const outlinePrompt = userMessage + "\n\n=== STEP 1 ===\nReturn ONLY an outline. Generate the title and 4-6 H2 section headings. Do NOT write full content yet. Return as JSON: {\"title\": \"...\", \"slug\": \"...\", \"metaDescription\": \"...\", \"h2Headings\": [\"Heading 1\", \"Heading 2\", ...]}.";
    const outlineRes = await chatWithRetry(
      [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
    );
    let outline: any;
    try {
      outline = robustJsonParse(outlineRes.content);
    } catch {
      console.error("[generate-blog:OUTLINE] JSON parse failed, retrying once...");
      const retryRes = await chatWithRetry(
        [{ role: "system", content: outlineSystemPrompt }, { role: "user", content: outlinePrompt + "\n\nCRITICAL: You MUST output valid JSON only. No markdown, no extra text." }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );
      try {
        outline = robustJsonParse(retryRes.content);
      } catch {
        return NextResponse.json({ error: "Failed to parse outline JSON after retry" }, { status: 500 });
      }
    }
    const h2Headings: string[] = outline?.h2Headings ?? [];
    if (h2Headings.length === 0) {
      return NextResponse.json({ error: "Outline generation failed: no H2 headings returned" }, { status: 500 });
    }

    // Repair meta description in code
    const rawMeta = outline.metaDescription || "";
    const repairedMeta = repairMetaDescription(rawMeta, META_MIN, META_MAX);
    if (repairedMeta !== rawMeta) {
      console.log(`[generate-blog:OUTLINE] Meta repaired: ${rawMeta.length} → ${repairedMeta.length} chars`);
    }

    // Calculate dynamic word targets
    const effectiveWordCount = (context.project.wordCount || DEFAULT_WORD_COUNT);
    const introTarget = Math.round(effectiveWordCount * WORD_ALLOCATION.INTRO);
    const conclusionTarget = Math.round(effectiveWordCount * WORD_ALLOCATION.CONCLUSION);
    const faqTarget = Math.round(effectiveWordCount * WORD_ALLOCATION.FAQ);
    const h2TotalTarget = effectiveWordCount - introTarget - conclusionTarget - faqTarget;
    const wordsPerSection = Math.round(h2TotalTarget / h2Headings.length);
    const exactKeyphraseTarget = keyphraseTarget(effectiveWordCount);
    console.log(`[generate-blog:TARGETS] total=${effectiveWordCount} intro=${introTarget} conclusion=${conclusionTarget} faq=${faqTarget} perSection=${wordsPerSection} keyphraseTarget=${exactKeyphraseTarget}`);

    const generated: GeneratedBlog = {
      title: outline.title || "Untitled",
      slug: outline.slug || "",
      metaDescription: repairedMeta,
      blog: "",
      faq: [],
      internalLinks: [],
      externalLinks: [],
      categories: [],
      tags: [],
      readingTime: "",
      summary: "",
      excerpt: outline.excerpt || "",
    };

    // ── PHASE B: Generate introduction ──
    console.log("[generate-blog:INTRO] Generating introduction...");
    const introSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.introduction);
    const introPrompt = `Write the introduction (${introTarget} words) for this blog. Use WordPress block format. Return as JSON: {"intro": "..."}.\n\nTitle: ${generated.title}\nMeta: ${generated.metaDescription}\nKeyword: ${context.project.keyword}\n\n${userMessage.substring(0, 1000)}`;
    const introRes = await chatWithRetry(
      [{ role: "system", content: introSystemPrompt }, { role: "user", content: introPrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 4096 }
    );
    const intro = (robustJsonParse(introRes.content) as Record<string, string>).intro || "";
    console.log(`[generate-blog:INTRO] ${countWords(intro)} words`);

    // ── PHASE C: Generate each H2 section ──
    // Application owns heading text. AI writes body content only.
    const keyphrase = (context.project.keyword ?? "").toLowerCase();

    // Select the best H2 for keyphrase and modify heading text in code
    let keyphraseH2Index = -1;
    if (keyphrase && h2Headings.length > 0) {
      const skipPatterns = /mistake|avoid|faq|conclusion|summary|final|wrap.?up/i;
      const kpWords = keyphrase.split(/\s+/);

      // First: find heading that semantically matches keyphrase
      for (let i = 0; i < h2Headings.length; i++) {
        const h = h2Headings[i].toLowerCase();
        if (skipPatterns.test(h)) continue;
        if (kpWords.some((w) => h.includes(w))) { keyphraseH2Index = i; break; }
      }

      // Fallback: first non-structural heading
      if (keyphraseH2Index === -1) {
        for (let i = 0; i < h2Headings.length; i++) {
          if (!skipPatterns.test(h2Headings[i].toLowerCase())) { keyphraseH2Index = i; break; }
        }
      }

      // Ultimate fallback: first heading
      if (keyphraseH2Index === -1) keyphraseH2Index = 0;

      // Modify heading text in code — application owns the heading
      const original = h2Headings[keyphraseH2Index];
      h2Headings[keyphraseH2Index] = `${keyphrase}: ${original}`;
      console.log(`[generate-blog:H2-KEYPHRASE] Selected H2 #${keyphraseH2Index + 1}: "${original}" → "${h2Headings[keyphraseH2Index]}"`);
    }

    const sectionSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.section);
    const sections: string[] = [intro];

    for (let i = 0; i < h2Headings.length; i++) {
      const h2Text = h2Headings[i];
      const isKeyphraseH2 = i === keyphraseH2Index;

      console.log(`[generate-blog:SECTION] ${i + 1}/${h2Headings.length}: "${h2Text}"${isKeyphraseH2 ? " (keyphrase H2)" : ""}`);

      const prevHeading = i > 0 ? h2Headings[i - 1] : "(none)";
      const nextHeading = i < h2Headings.length - 1 ? h2Headings[i + 1] : "(none)";

      const sectionPrompt = `Write the body content for this section. Target exactly ${wordsPerSection} words. Use WordPress block format (<!-- wp:paragraph -->, <!-- wp:list -->). Include exactly ${exactKeyphraseTarget} occurrences of the keyphrase "${keyphrase}" across the full article body — this section should contribute naturally. Return as JSON: {\"body\": \"...\"}.\n\nBlog title: ${generated.title}\nThis section heading: ${h2Text}\nPrevious heading: ${prevHeading}\nNext heading: ${nextHeading}\nPrevious section (for context): ${sections.slice(-1)[0]?.substring(0, 500) ?? ""}`;

      const sectionRes = await chatWithRetry(
        [{ role: "system", content: sectionSystemPrompt }, { role: "user", content: sectionPrompt }],
        { responseFormat: { type: "json_object" }, maxTokens: 8192 }
      );

      const sectionData = robustJsonParse(sectionRes.content) as Record<string, string>;
      const body = sectionData.body || "";

      // Application assembles heading block + AI body
      const headingBlock = `<!-- wp:heading {"level":2} -->\n<h2>${h2Text}</h2>\n<!-- /wp:heading -->`;
      sections.push(`${headingBlock}\n${body}`);
      console.log(`[generate-blog:SECTION] ${i + 1}: ${countWords(body)} words`);
    }

    // ── PHASE D: Generate FAQ ──
    console.log("[generate-blog:FAQ] Generating FAQ...");
    const faqSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.faq);
    const faqPrompt = `Generate 4-6 FAQ questions and answers for this blog. Use <!-- wp:html --> blocks. Return as JSON: {\"faq\": [{\"question\": \"...\", \"answer\": \"...\"}], \"faqSchemaBlock\": \"...\"}.\n\nBlog title: ${generated.title}\nContent summary: ${sections.join("\n").substring(0, 1000)}`;
    const faqRes = await chatWithRetry(
      [{ role: "system", content: faqSystemPrompt }, { role: "user", content: faqPrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 8192 }
    );
    const faqData = robustJsonParse(faqRes.content) as Record<string, unknown>;
    generated.faq = (faqData.faq as Array<{ question: string; answer: string }>) || [];
    sections.push((faqData.faqSchemaBlock as string) || "");

    // ── PHASE E: Generate conclusion ──
    console.log("[generate-blog:CONCLUSION] Generating conclusion...");
    const conclusionSystemPrompt = buildSystemPrompt(context, STAGE_SYSTEM_PROMPTS.conclusion);
    const conclusionPrompt = `Write the conclusion (${conclusionTarget} words) for this blog. Include a CTA to create a B2I Hub profile. Return as JSON: {\"conclusion\": \"...\"}.\n\nTitle: ${generated.title}`;
    const conclusionRes = await chatWithRetry(
      [{ role: "system", content: conclusionSystemPrompt }, { role: "user", content: conclusionPrompt }],
      { responseFormat: { type: "json_object" }, maxTokens: 4096 }
    );
    const conclusion = (robustJsonParse(conclusionRes.content) as Record<string, string>).conclusion || "";
    sections.push(conclusion);
    console.log(`[generate-blog:CONCLUSION] ${countWords(conclusion)} words`);

    // ── PHASE F: Assemble ──
    generated.blog = sections.join("\n\n");
    const finalWordCount = countWords(generated.blog);
    const faqCount = generated.faq?.length ?? 0;
    console.log(`[generate-blog:ASSEMBLE] Total: ${finalWordCount} words, ${h2Headings.length} sections, ${faqCount} FAQ items, keyphrase in H2: ${keyphraseH2Index >= 0}`);

    // ===== POST-GENERATION VALIDATION: Targeted fixers (code counts, AI edits) =====
    const countSyllables = (word: string): number => {
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
    };

    const fleschScore = (rawText: string): number => {
      const text = cleanBodyText(rawText);
      const words = text.split(/\s+/).filter(Boolean);
      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      if (words.length === 0 || sentences.length === 0) return 0;
      const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
      return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
    };

    // Metrics helpers — code counts, never asks AI
    const getTitleLen = () => (generated.title ?? "").length;
    const getKeyphraseCount = () => keyphrase ? cleanBodyText(generated.blog).toLowerCase().split(keyphrase).length - 1 : 0;
    const isKeyphraseInH2 = () => {
      if (!keyphrase) return true;
      const h2s = generated.blog.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) ?? [];
      return h2s.map((h) => cleanBodyText(h).toLowerCase()).join("\n").includes(keyphrase);
    };
    const getFlesch = () => Math.round(fleschScore(generated.blog));

    // === PHASE 1: Validate + fix with re-validation after every fix ===
    const fixerCtx = {
      generated,
      chatWithRetry,
    };

    const runAllChecks = (): string[] => {
      const errors: string[] = [];
      const tl = getTitleLen();
      if (tl < SEO_TITLE_MIN || tl > SEO_TITLE_MAX) errors.push(`title:${tl}`);
      if (keyphrase) {
        const kc = getKeyphraseCount();
        if (kc < KEYPHRASE_MIN || kc > KEYPHRASE_MAX) errors.push(`density:${kc}`);
        if (!isKeyphraseInH2()) errors.push(`h2:0`);
      }
      const fs = getFlesch();
      if (fs < FLESCH_MIN || fs > FLESCH_MAX) errors.push(`readability:${fs}`);
      return errors;
    };

    const fixerOrder = [
      { name: "title", check: (e: string) => e.startsWith("title:"), fix: () => fixTitle(fixerCtx, { currentLength: getTitleLen(), targetMin: SEO_TITLE_MIN, targetMax: SEO_TITLE_MAX, keyphrase }), apply: (r: string | null) => { if (r) generated.title = r; } },
      { name: "density", check: (e: string) => e.startsWith("density:"), fix: () => fixKeyphraseDensity(fixerCtx, { keyphrase, currentCount: getKeyphraseCount(), targetMin: KEYPHRASE_MIN, targetMax: KEYPHRASE_MAX }), apply: (r: string | null) => { if (r) generated.blog = r; } },
      { name: "readability", check: (e: string) => e.startsWith("readability:"), fix: () => fixReadability(fixerCtx, { currentFlesch: getFlesch(), targetMin: FLESCH_MIN, targetMax: FLESCH_MAX }), apply: (r: string | null) => { if (r) generated.blog = r; } },
    ];

    let allErrors = runAllChecks();
    console.log(`[VALIDATE] Initial — ${allErrors.length} error(s): ${allErrors.join(", ")}`);

    for (const step of fixerOrder) {
      const hasError = allErrors.some(step.check);
      if (!hasError) continue;

      let fixed = false;
      for (let attempt = 0; attempt < 3 && !fixed; attempt++) {
        const otherErrors = allErrors.filter((e) => !step.check(e)).join(", ") || "none";
        console.log(`[VALIDATE:${step.name}] Attempt ${attempt + 1}/3 (other errors: ${otherErrors})`);

        const result = await step.fix();
        step.apply(result);

        allErrors = runAllChecks();
        fixed = !allErrors.some(step.check);

        if (fixed) {
          console.log(`[VALIDATE:${step.name}] Fixed on attempt ${attempt + 1}. Remaining: ${allErrors.join(", ") || "none"}`);
        } else {
          const val = allErrors.find(step.check) ?? "";
          console.log(`[VALIDATE:${step.name}] Still failing after attempt ${attempt + 1}: ${val}`);
        }
      }

      allErrors = runAllChecks();
      if (allErrors.some(step.check)) {
        console.log(`[VALIDATE:${step.name}] Failed after 3 attempts`);
        const label = { title: "title", density: "keyphrase density", readability: "readability" }[step.name] ?? step.name;
        const readabilityError = step.name === "readability"
          ? `Readability score: ${getFlesch()}. Cannot reach 60-70 without changing meaning. Manual editing required.`
          : `Blog validation failed: ${label} could not be fixed after 3 attempts. Please regenerate.`;
        return NextResponse.json(
          { error: readabilityError, failures: allErrors },
          { status: 422 }
        );
      }
    }

    // PHASE 2: Final validation
    allErrors = runAllChecks();
    console.log(`[VALIDATE] Final — ${allErrors.join(", ") || "all clear"}`);
    if (allErrors.length > 0) {
      return NextResponse.json(
        { error: "Blog validation failed after targeted fixes.", failures: allErrors },
        { status: 422 }
      );
    }
    console.log("[generate-blog:VALIDATE] All checks passed");

    const generationTimeMs = Date.now() - startTime;

    const nextVersion = await blogVersionRepository.getNextVersionNumber(Number(projectId));
    console.log(`[generate-blog:VERSION] Next version: ${nextVersion}`);

    const { seedDefaultLinks: seedLinks } = await import("@/lib/services/default-links");
    await seedLinks(userId);

    const { injectLinks } = await import("@/lib/services/link-injector");
    const injectionResult = await injectLinks(generated.blog, userId);
    console.log(`[generate-blog:LINKS] Injected ${injectionResult.linksInjected} links`);

    if (injectionResult.linksInjected > 0) {
      generated.blog = injectionResult.modifiedContent;
    }

    await blogVersionRepository.create({
      projectId: Number(projectId),
      userId,
      versionNumber: nextVersion,
      title: generated.title,
      slug: generated.slug,
      metaDescription: generated.metaDescription,
      excerpt: generated.excerpt,
      blog: generated.blog,
      faq: generated.faq,
      internalLinks: generated.internalLinks,
      externalLinks: generated.externalLinks,
      categories: generated.categories,
      tags: generated.tags,
      readingTime: generated.readingTime,
      wordCount: finalWordCount,
      summary: generated.summary,
      model: "section-by-section",
      generationTimeMs: Date.now() - startTime,
      tokenUsage: { totalTokens: 0 },
      status: "draft",
    });

    await projectRepository.update(Number(projectId), {
      content: generated.blog,
    });

    await aiLogRepository.create({
      userId,
      model: "section-by-section",
      endpoint: "/api/generate-blog",
      status: "success",
      projectId: Number(projectId),
      promptSize: systemPrompt.length + userMessage.length,
      completionSize: generated.blog.length,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      generationTimeMs: Date.now() - startTime,
    });

    return NextResponse.json(
      {
        success: true,
        version: nextVersion,
        title: generated.title,
        slug: generated.slug,
        metaDescription: generated.metaDescription,
        excerpt: generated.excerpt,
        blog: generated.blog,
        faq: generated.faq,
        internalLinks: generated.internalLinks,
        externalLinks: generated.externalLinks,
        categories: generated.categories,
        tags: generated.tags,
        readingTime: generated.readingTime,
        wordCount: finalWordCount,
        summary: generated.summary,
        model: "section-by-section",
        generationTimeMs: Date.now() - startTime,
        tokenUsage: { totalTokens: 0 },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[generate-blog:POST]", error);

    if (error instanceof Error && error.message === "Not authenticated") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      {
        error: "Failed to generate blog",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
