// ── Controlled synthetic-fixture evaluator for conclusion structured translation ──
// Tests the real production structured-translation pipeline with deterministic
// synthetic conclusion blocks.  Does not switch authority or publish content.

import { type EditorialBlock, type InlineContent, validateEditorialBlocks, renderEditorialBlocksToWordPress } from "@/lib/blog/article-content";
import { protectNumbersInEditorialBlocks, restoreNumbersInEditorialBlocks, checkBlockNumbersPreserved, checkBlockLinksPreserved, type NumberProtectionState } from "./editorial-block-protection";
import { serializeTranslationPayload, normalizeTranslationPayload, reconstructEditorialBlocks, validateConclusionPolicy, type TranslationComponentPayload, type TranslationLinkMap } from "./translation-dto";
import { createProductionConclusionStructuredShadowOptions } from "./translation-ai";
import { checkPlaceholderIntegrity, checkNoPlaceholdersRemain, extractAllTextFromInlineContent } from "./editorial-block-translation";
import type { StructuredTranslationShadowOptions } from "./editorial-block-translation";

// ── Constants ──

const MAX_INITIAL_REQUESTS = 16;
const MAX_REPAIR_REQUESTS = 16;
const MAX_TOTAL_REQUESTS = 32;

// ── Fixtures ──

export interface ConclusionFixture {
  id: string;
  label: string;
  blocks: EditorialBlock[];
}

function p(content: InlineContent[]): EditorialBlock {
  return { id: `f-${Math.random().toString(36).slice(2, 8)}`, type: "paragraph", content };
}
function link(text: string, href: string): InlineContent {
  return { type: "link", text, href };
}

export function getConclusionFixtures(): ConclusionFixture[] {
  return [
    {
      id: "plain-paragraph",
      label: "One plain paragraph",
      blocks: [p([{ type: "text", text: "This is the conclusion for the article." }])],
    },
    {
      id: "multiple-paragraphs",
      label: "Multiple paragraphs",
      blocks: [
        p([{ type: "text", text: "First concluding paragraph." }]),
        p([{ type: "text", text: "Second concluding paragraph with more detail." }]),
      ],
    },
    {
      id: "strong-emphasis",
      label: "Strong and emphasis inline nodes",
      blocks: [p([
        { type: "text", text: "This is " },
        { type: "strong", text: "very important" },
        { type: "text", text: " and " },
        { type: "emphasis", text: "worth noting" },
        { type: "text", text: " for readers." },
      ])],
    },
    {
      id: "single-link",
      label: "One link with translatable label",
      blocks: [p([
        { type: "text", text: "Visit " },
        link("our official website", "https://www.example-org.com.hk/resources"),
        { type: "text", text: " for more information." },
      ])],
    },
    {
      id: "two-links",
      label: "Two links with different private URLs",
      blocks: [p([
        { type: "text", text: "Check " },
        link("our blog", "https://blog.b2ihub.com/marketing-tips"),
        { type: "text", text: " and " },
        link("creator network", "https://creators.b2ihub.com/join"),
        { type: "text", text: " for details." },
      ])],
    },
    {
      id: "percentage-currency-decimal",
      label: "Percentage, currency and decimal values",
      blocks: [p([
        { type: "text", text: "Conversion rates improved by 35% with average order value of HK$850. Only 2.5% of visitors churned." },
      ])],
    },
    {
      id: "dates-ranges-suffixes",
      label: "Date, numeric range and numeric suffix",
      blocks: [p([
        { type: "text", text: "Since 2026-01-15, the campaign has reached 50,000 Hong Kong users (up from 12,000). A 7-day trial showed 3x growth." },
      ])],
    },
    {
      id: "ordered-list",
      label: "Ordered list",
      blocks: [{
        id: "list-1", type: "list", ordered: true,
        items: [
          [{ type: "text", text: "Higher brand awareness among 25-35 demographic." }],
          [{ type: "text", text: "Improved engagement by 40% through local creators." }],
          [{ type: "text", text: "Reduced customer acquisition cost by HK$200 per lead." }],
        ],
      }],
    },
    {
      id: "table-with-mixed",
      label: "Table with headers and multiple cells",
      blocks: [{
        id: "tbl-1", type: "table",
        headers: [
          [{ type: "text", text: "Channel" }],
          [{ type: "text", text: "Reach" }],
        ],
        rows: [
          [[{ type: "text", text: "Instagram" }], [{ type: "text", text: "HK$1.2M" }]],
          [[{ type: "text", text: "Facebook" }], [{ type: "text", text: "HK$950K" }]],
        ],
      }],
    },
    {
      id: "mixed-formatting-repeated-words",
      label: "Mixed text, strong, link and repeated wording",
      blocks: [p([
        { type: "text", text: "Businesses that partner with " },
        { type: "strong", text: "local Hong Kong creators" },
        { type: "text", text: " see " },
        { type: "emphasis", text: "3x higher engagement" },
        { type: "text", text: ". Very very effective. Learn more by reading " },
        link("case studies", "https://www.example-org.com.hk/case-studies"),
        { type: "text", text: " and checking " },
        link("testimonials", "https://testimonials.b2ihub.com/latest"),
        { type: "text", text: "." },
      ])],
    },

    // ── Real-content fixtures (representative of production blog conclusions) ──

    {
      id: "real-multi-paragraph",
      label: "Real multi-paragraph conclusion",
      blocks: [
        p([
          { type: "text", text: "In conclusion, this approach provides significant value for businesses looking to grow their brand presence in Hong Kong. " },
          { type: "strong", text: "Readers should take action" },
          { type: "text", text: " on the key points discussed above to maximise their return on investment." },
        ]),
        p([
          { type: "text", text: "The benefits are clear and well-documented across multiple case studies. Companies that invest in these strategies see measurable improvements in both engagement and revenue within the first quarter." },
        ]),
      ],
    },
    {
      id: "real-internal-links",
      label: "Real conclusion with internal B2I Hub links",
      blocks: [p([
        { type: "text", text: "For more information, explore " },
        link("our complete guide to Hong Kong influencer marketing", "https://blog.b2ihub.com/influencer-marketing-guide"),
        { type: "text", text: " or read about " },
        link("top localisation strategies for Asian markets", "https://blog.b2ihub.com/localisation-strategies"),
        { type: "text", text: ". These resources cover everything from creator discovery to campaign measurement in 2026." },
      ])],
    },
    {
      id: "real-mixed-formatting-numeric",
      label: "Real conclusion with strong, emphasis and percentage",
      blocks: [p([
        { type: "text", text: "Hong Kong digital marketing in 2026 requires " },
        { type: "strong", text: "a sophisticated understanding" },
        { type: "text", text: " of local consumer behaviour, bilingual content strategies and platform-specific approaches. Brands that invest in these areas see an average of " },
        { type: "emphasis", text: "35% higher engagement" },
        { type: "text", text: " and up to " },
        { type: "strong", text: "HK$1.2 million" },
        { type: "text", text: " in additional revenue within 6 months. Only 2.5% of early adopters reported lower-than-expected results." },
      ])],
    },
    {
      id: "real-summary-list",
      label: "Real conclusion with bulleted summary",
      blocks: [{
        id: "rl-list-1", type: "list", ordered: false,
        items: [
          [{ type: "text", text: "Hong Kong brands must prioritise bilingual content to reach 90% of their target audience effectively." }],
          [{ type: "text", text: "Influencer partnerships deliver 3x ROI compared to traditional advertising channels in the local market." }],
          [{ type: "text", text: "Data-driven campaign optimisation reduces customer acquisition cost by HK$200 per lead on average." }],
          [{ type: "text", text: "Early adoption of video-first strategies positions brands ahead of competitors entering this space." }],
        ],
      }],
    },
    {
      id: "real-with-dates",
      label: "Real conclusion with date references and growth figures",
      blocks: [p([
        { type: "text", text: "Since " },
        { type: "strong", text: "January 2024" },
        { type: "text", text: ", the Hong Kong influencer marketing sector has grown by " },
        { type: "emphasis", text: "150%" },
        { type: "text", text: ", reaching over 50,000 active brand-creator partnerships by Q3 2026. This represents a 7x increase from pre-2024 levels and shows no signs of slowing down. Brands that established their presence early now command " },
        { type: "strong", text: "40% market share" },
        { type: "text", text: " in their respective niches." },
      ])],
    },
    {
      id: "real-richest",
      label: "Real conclusion with table, ordered list, links and numbers",
      blocks: [
        {
          id: "rl-tbl-1", type: "table",
          headers: [
            [{ type: "text", text: "Channel" }],
            [{ type: "text", text: "Average ROI" }],
            [{ type: "text", text: "Time to Impact" }],
          ],
          rows: [
            [[{ type: "text", text: "Instagram" }], [{ type: "text", text: "350%" }], [{ type: "text", text: "2.5 months" }]],
            [[{ type: "text", text: "YouTube" }], [{ type: "text", text: "280%" }], [{ type: "text", text: "4 months" }]],
            [[{ type: "text", text: "Facebook" }], [{ type: "text", text: "190%" }], [{ type: "text", text: "3 months" }]],
          ],
        },
        {
          id: "rl-list-2", type: "list", ordered: true,
          items: [
            [{ type: "text", text: "Define campaign objectives aligned with HK$500K budget allocation." }],
            [{ type: "text", text: "Identify 6-8 creators whose audience matches your 25-35 demographic." }],
            [{ type: "text", text: "Launch with bilingual content strategy across 3 platforms." }],
          ],
        },
        p([
          { type: "text", text: "To get started, read " },
          link("our step-by-step campaign playbook", "https://blog.b2ihub.com/campaign-playbook-2026"),
          { type: "text", text: " or " },
          link("contact our team", "https://app.b2ihub.com/contact"),
          { type: "text", text: " for a personalised strategy session covering budget of HK$50K to HK$2M." },
        ]),
      ],
    },
  ];
}

// ── Payload safety check ──

export interface PayloadSafetyResult {
  safe: boolean;
  errors: string[];
}

export function checkPayloadSafety(
  payload: TranslationComponentPayload,
  payloadJson: string,
): PayloadSafetyResult {
  const errors: string[] = [];

  if (payload.componentKind !== "conclusion") {
    errors.push(`componentKind must be "conclusion", got "${payload.componentKind}"`);
  }

  if (payloadJson.includes("block-") || /"id":"[^"]+"/.test(payloadJson)) {
    errors.push("payload contains canonical block IDs");
  }
  if (payloadJson.includes("href") || payloadJson.includes("http://") || payloadJson.includes("https://")) {
    errors.push("payload contains URLs");
  }
  if (payloadJson.includes("sourceType")) {
    errors.push("payload contains sourceType");
  }
  if (payloadJson.includes("<!--") || /wp:/.test(payloadJson)) {
    errors.push("payload contains WordPress markup");
  }
  if (/create your free|ready to grow|app\.b2ihub\.com\/signup/i.test(payloadJson)) {
    errors.push("payload contains CTA or signup content");
  }

  if (payload.blocks.length === 0) {
    errors.push("payload has no blocks");
  }

  const allText = JSON.stringify(payload);
  if (errors.length === 0) {
    if (!allText.includes("seq") || !allText.includes("type") || !allText.includes("conclusion")) {
      errors.push("payload missing required fields");
    }
  }

  return { safe: errors.length === 0, errors };
}

// ── Evaluation model ──

export interface ConclusionShadowFixtureResult {
  fixtureId: string;
  initialPassed: boolean;
  repairAttempted: boolean;
  repairPassed: boolean | null;
  finalPassed: boolean;
  normalizationErrors: string[];
  validationErrors: string[];
  blockCountPreserved: boolean;
  placeholdersPreserved: boolean;
  numbersPreserved: boolean;
  linksPreserved: boolean;
  conclusionPolicyPassed: boolean;
  sourceCharacters: number;
  translatedCharacters: number;
  characterRatio: number;
  translatedText?: string;
}

export interface ConclusionShadowSummary {
  totalFixtures: number;
  initialPasses: number;
  repairAttempts: number;
  repairSuccesses: number;
  finalPasses: number;
  finalFailures: number;
  payloadSafetyFailures: number;
  malformedJsonFailures: number;
  structuralFailures: number;
  placeholderFailures: number;
  numberPreservationFailures: number;
  linkPreservationFailures: number;
  conclusionPolicyFailures: number;
  averageCharacterRatio: number;
  totalAiRequests: number;
  liveEvaluation: boolean;
}

// ── Evaluator ──

export interface EvaluatorOptions {
  live: boolean;
  callbacks?: StructuredTranslationShadowOptions;
}

export interface EvaluatorResult {
  results: ConclusionShadowFixtureResult[];
  summary: ConclusionShadowSummary;
  reportPaths: string[];
}

export async function evaluateConclusionStructuredShadow(
  options: EvaluatorOptions,
): Promise<EvaluatorResult> {
  const fixtures = getConclusionFixtures();
  const callbacks = options.callbacks ?? createProductionConclusionStructuredShadowOptions();
  const results: ConclusionShadowFixtureResult[] = [];

  let totalAiRequests = 0;
  let malformedJsonFailures = 0;
  let structuralFailures = 0;
  let placeholderFailures = 0;
  let numberPreservationFailures = 0;
  let linkPreservationFailures = 0;
  let conclusionPolicyFailures = 0;
  let payloadSafetyFailures = 0;
  let cumulativeRatio = 0;

  for (const fixture of fixtures) {
    // Protect numbers
    const { blocks: protectedBlocks, state } = protectNumbersInEditorialBlocks(fixture.blocks);

    // Serialize DTO
    const { payload, linkMap } = serializeTranslationPayload(protectedBlocks, "conclusion");
    const payloadJson = JSON.stringify(payload);

    // Payload safety check
    const safety = checkPayloadSafety(payload, payloadJson);
    if (!safety.safe) {
      payloadSafetyFailures++;
      results.push({
        fixtureId: fixture.id,
        initialPassed: false,
        repairAttempted: false,
        repairPassed: null,
        finalPassed: false,
        normalizationErrors: safety.errors,
        validationErrors: [],
        blockCountPreserved: false,
        placeholdersPreserved: false,
        numbersPreserved: false,
        linksPreserved: false,
        conclusionPolicyPassed: false,
        sourceCharacters: payloadJson.length,
        translatedCharacters: 0,
        characterRatio: 0,
      });
      continue;
    }

    if (!options.live) {
      // Dry run: skip AI call, record as unrun
      results.push({
        fixtureId: fixture.id,
        initialPassed: false,
        repairAttempted: false,
        repairPassed: null,
        finalPassed: false,
        normalizationErrors: [],
        validationErrors: [],
        blockCountPreserved: true,
        placeholdersPreserved: false,
        numbersPreserved: false,
        linksPreserved: false,
        conclusionPolicyPassed: false,
        sourceCharacters: payloadJson.length,
        translatedCharacters: 0,
        characterRatio: 0,
        translatedText: "[dry-run — no AI call made]",
      });
      continue;
    }

    // AI initial request
    if (totalAiRequests >= MAX_TOTAL_REQUESTS) break;
    totalAiRequests++;

    let responseJson: string;
    try {
      responseJson = await callbacks.translatePayload(payloadJson, { componentKind: "conclusion", componentId: `eval-${fixture.id}` });
    } catch {
      malformedJsonFailures++;
      results.push({
        fixtureId: fixture.id,
        initialPassed: false,
        repairAttempted: false,
        repairPassed: null,
        finalPassed: false,
        normalizationErrors: ["AI call failed"],
        validationErrors: [],
        blockCountPreserved: false,
        placeholdersPreserved: false,
        numbersPreserved: false,
        linksPreserved: false,
        conclusionPolicyPassed: false,
        sourceCharacters: payloadJson.length,
        translatedCharacters: 0,
        characterRatio: 0,
      });
      continue;
    }

    // Evaluate initial response
    let evaluation = await evaluateStructuredResponse(
      responseJson, payload, protectedBlocks, state, linkMap, fixture.id,
    );

    let repairAttempted = false;
    let repairPassed: boolean | null = null;

    if (!evaluation.passed && callbacks.repairPayload && totalAiRequests < MAX_TOTAL_REQUESTS) {
      totalAiRequests++;
      repairAttempted = true;
      try {
        const combinedErrors = [...evaluation.normalizationErrors, ...evaluation.validationErrors];
        const repairResponse = await callbacks.repairPayload(payloadJson, responseJson, combinedErrors, { componentKind: "conclusion", componentId: `eval-${fixture.id}` });
        if (repairResponse) {
          evaluation = await evaluateStructuredResponse(
            repairResponse, payload, protectedBlocks, state, linkMap, fixture.id,
          );
          repairPassed = evaluation.passed;
        }
      } catch {
        repairPassed = false;
      }
    }

    // Classify failures
    const allErrors = [...evaluation.normalizationErrors, ...evaluation.validationErrors];
    const hasMalformed = allErrors.some((e) => e.includes("JSON") || e.includes("parse"));
    const hasStructural = allErrors.some((e) => e.includes("count mismatch") || e.includes("type mismatch") || e.includes("seq") || e.includes("ordered") || e.includes("item") || e.includes("header") || e.includes("row") || e.includes("cell"));
    const hasPlaceholder = allErrors.some((e) => e.includes("placeholder"));
    const hasNumbers = allErrors.some((e) => e.includes("number mismatch") || e.includes("numbers lost"));
    const hasLinks = allErrors.some((e) => e.includes("links lost"));
    const hasPolicy = allErrors.some((e) => e.includes("CTA") || e.includes("signup"));

    if (!evaluation.passed) {
      if (hasMalformed) malformedJsonFailures++;
      if (hasStructural) structuralFailures++;
      if (hasPlaceholder) placeholderFailures++;
      if (hasNumbers) numberPreservationFailures++;
      if (hasLinks) linkPreservationFailures++;
      if (hasPolicy) conclusionPolicyFailures++;
    }

    const blockCountPreserved = payload.blocks.length === evaluation.blockCount;
    const placeholdersPreserved = !hasPlaceholder;
    const numbersPreserved = !hasNumbers;
    const linksPreserved = !hasLinks;
    const conclusionPolicyPassed = !hasPolicy;

    if (evaluation.passed) {
      cumulativeRatio += evaluation.characterRatio;
    }

    const result: ConclusionShadowFixtureResult = {
      fixtureId: fixture.id,
      initialPassed: evaluation.initialPassed ?? evaluation.passed,
      repairAttempted,
      repairPassed,
      finalPassed: evaluation.passed,
      normalizationErrors: evaluation.normalizationErrors,
      validationErrors: evaluation.validationErrors,
      blockCountPreserved,
      placeholdersPreserved,
      numbersPreserved,
      linksPreserved,
      conclusionPolicyPassed,
      sourceCharacters: evaluation.sourceChars,
      translatedCharacters: evaluation.translatedChars,
      characterRatio: evaluation.characterRatio,
      translatedText: evaluation.translatedText,
    };
    results.push(result);
  }

  const passedResults = results.filter((r) => r.finalPassed);
  const finalPasses = passedResults.length;
  const finalFailures = results.length - finalPasses;
  const initialPasses = results.filter((r) => r.initialPassed).length;
  const repairAttempts = results.filter((r) => r.repairAttempted).length;
  const repairSuccesses = results.filter((r) => r.repairPassed === true).length;

  const summary: ConclusionShadowSummary = {
    totalFixtures: fixtures.length,
    initialPasses,
    repairAttempts,
    repairSuccesses,
    finalPasses,
    finalFailures,
    payloadSafetyFailures,
    malformedJsonFailures,
    structuralFailures,
    placeholderFailures,
    numberPreservationFailures,
    linkPreservationFailures,
    conclusionPolicyFailures,
    averageCharacterRatio: finalPasses > 0 ? cumulativeRatio / finalPasses : 0,
    totalAiRequests,
    liveEvaluation: options.live,
  };

  return { results, summary, reportPaths: [] };
}

// ── Internal evaluation helper ──

interface StructuredEvalResult {
  passed: boolean;
  normalizationErrors: string[];
  validationErrors: string[];
  initialPassed?: boolean;
  blockCount: number;
  sourceChars: number;
  translatedChars: number;
  characterRatio: number;
  translatedText?: string;
}

async function evaluateStructuredResponse(
  response: string,
  payload: TranslationComponentPayload,
  protectedBlocks: EditorialBlock[],
  protectionState: NumberProtectionState,
  linkMap: TranslationLinkMap,
  fixtureId: string,
): Promise<StructuredEvalResult> {
  const norm = normalizeTranslationPayload(response, payload);
  if (!norm.payload) {
    return {
      passed: false, normalizationErrors: norm.errors, validationErrors: [],
      blockCount: 0, sourceChars: payload.blocks.reduce((s, b) => s + JSON.stringify(b).length, 0),
      translatedChars: response.length, characterRatio: 0,
    };
  }

  const recon = reconstructEditorialBlocks(norm.payload, protectedBlocks, linkMap);
  if (recon.errors.length > 0) {
    return {
      passed: false, normalizationErrors: recon.errors, validationErrors: [],
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const integ = checkPlaceholderIntegrity(recon.blocks, protectionState);
  if (!integ.ok) {
    return {
      passed: false, normalizationErrors: [`placeholder integrity: ${integ.errors.join("; ")}`], validationErrors: [],
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const restored = restoreNumbersInEditorialBlocks(recon.blocks, protectionState);
  const remaining = checkNoPlaceholdersRemain(restored);
  if (remaining.length > 0) {
    return {
      passed: false, normalizationErrors: [`placeholders remain: ${remaining.join(", ")}`], validationErrors: [],
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const valErrors = validateEditorialBlocks(restored);
  if (valErrors.length > 0) {
    return {
      passed: false, normalizationErrors: [], validationErrors: valErrors,
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const ctaErr: string[] = [];
  validateConclusionPolicy(norm.payload.blocks, ctaErr);
  if (ctaErr.length > 0) {
    return {
      passed: false, normalizationErrors: [], validationErrors: ctaErr,
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const numCheck = checkBlockNumbersPreserved(protectedBlocks, recon.blocks);
  if (numCheck.lost.length > 0 || numCheck.extras.length > 0) {
    const d: string[] = [];
    if (numCheck.lost.length > 0) d.push(`lost: ${numCheck.lost.join(", ")}`);
    if (numCheck.extras.length > 0) d.push(`extra: ${numCheck.extras.join(", ")}`);
    return {
      passed: false, normalizationErrors: [], validationErrors: [`number mismatch (${d.join("; ")})`],
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const linksLost = checkBlockLinksPreserved(protectedBlocks, recon.blocks);
  if (linksLost.length > 0) {
    return {
      passed: false, normalizationErrors: [], validationErrors: [`links lost: ${linksLost.join(", ")}`],
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const readableText = extractAllTextFromInlineContent(restored);
  if (!readableText.trim()) {
    return {
      passed: false, normalizationErrors: [], validationErrors: ["no readable content"],
      blockCount: norm.payload.blocks.length, sourceChars: 0, translatedChars: response.length, characterRatio: 0,
    };
  }

  const sourceHtml = renderEditorialBlocksToWordPress(protectedBlocks);
  const translatedHtml = renderEditorialBlocksToWordPress(restored);
  const sourceChars = sourceHtml.length;
  const translatedChars = translatedHtml.length;

  return {
    passed: true, normalizationErrors: [], validationErrors: [], initialPassed: true,
    blockCount: norm.payload.blocks.length,
    sourceChars,
    translatedChars,
    characterRatio: sourceChars > 0 ? translatedChars / sourceChars : 0,
    translatedText: readableText,
  };
}
