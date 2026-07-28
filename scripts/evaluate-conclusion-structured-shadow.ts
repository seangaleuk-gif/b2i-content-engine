#!/usr/bin/env tsx
// ── Structured translation shadow evaluator CLI ──
// Usage:
//   npm run tsx scripts/evaluate-conclusion-structured-shadow.ts --dry-run
//   RUN_STRUCTURED_TRANSLATION_LIVE_EVAL=true npm run tsx scripts/evaluate-conclusion-structured-shadow.ts
//
// Safety:
//   --dry-run or RUN_STRUCTURED_TRANSLATION_LIVE_EVAL=false → safety checks only, zero AI calls
//   RUN_STRUCTURED_TRANSLATION_LIVE_EVAL=true → live AI requests

import { evaluateConclusionStructuredShadow, getConclusionFixtures, checkPayloadSafety } from "../src/lib/services/conclusion-shadow-evaluator";
import { serializeTranslationPayload } from "../src/lib/services/translation-dto";
import { protectNumbersInEditorialBlocks } from "../src/lib/services/editorial-block-protection";

function pad(s: string, n: number): string { return s.padEnd(n); }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const envLive = process.env.RUN_STRUCTURED_TRANSLATION_LIVE_EVAL === "true";

  if (!isDryRun && !envLive) {
    console.log("=".repeat(60));
    console.log("STRUCTURED TRANSLATION SHADOW EVALUATOR");
    console.log("=".repeat(60));
    console.log("");
    console.log("Dry-run mode (no AI calls):");
    console.log("  npm run tsx scripts/evaluate-conclusion-structured-shadow.ts --dry-run");
    console.log("");
    console.log("Live evaluation (requires AI credentials):");
    console.log("  RUN_STRUCTURED_TRANSLATION_LIVE_EVAL=true npm run tsx scripts/evaluate-conclusion-structured-shadow.ts");
    console.log("");
    console.log("Zero AI calls were made.");
    process.exit(0);
  }

  if (isDryRun) {
    console.log("=".repeat(60));
    console.log("DRY RUN — NO AI CALLS");
    console.log("=".repeat(60));
    console.log("");

    const fixtures = getConclusionFixtures();
    let safetyPass = 0;
    let safetyFail = 0;

    for (const f of fixtures) {
      const { blocks: protectedBlocks } = protectNumbersInEditorialBlocks(f.blocks);
      const { payload, linkMap } = serializeTranslationPayload(protectedBlocks, "conclusion");
      const payloadJson = JSON.stringify(payload);
      const safety = checkPayloadSafety(payload, payloadJson);

      if (safety.safe) {
        safetyPass++;
        console.log(`  ✅ ${pad(f.id, 35)} safe (${payload.blocks.length} block(s), ${linkMap.size} link(s))`);
      } else {
        safetyFail++;
        console.log(`  ❌ ${pad(f.id, 35)} SAFETY FAILURE: ${safety.errors.join("; ")}`);
      }
    }

    console.log("");
    console.log(`  ${fixtures.length} fixtures prepared`);
    console.log(`  ${safetyPass} payload-safety checks passed`);
    console.log(`  ${safetyFail} payload-safety failures`);
    console.log(`  Maximum potential AI requests: ${fixtures.length} initial + ${fixtures.length} repair = ${fixtures.length * 2}`);
    console.log(`  Hard limit: 16 initial / 16 repair / 32 total`);
    console.log(`  0 AI calls made (dry run).`);
    console.log("");
    process.exit(0);
  }

  // Live evaluation
  console.log("=".repeat(60));
  console.log("LIVE EVALUATION — AI CALLS WILL BE MADE");
  console.log("=".repeat(60));
  console.log("");

  const result = await evaluateConclusionStructuredShadow({ live: true });

  const { results, summary } = result;

  console.log(`  ${summary.totalFixtures} fixtures evaluated`);
  console.log(`  ${summary.totalAiRequests} AI requests made`);
  console.log(`  ${summary.initialPasses} initial passes`);
  console.log(`  ${summary.repairAttempts} repair attempts`);
  console.log(`  ${summary.repairSuccesses} repair successes`);
  console.log(`  ${summary.finalPasses} final passes`);
  console.log(`  ${summary.finalFailures} final failures`);
  console.log(`  Average character ratio: ${summary.averageCharacterRatio.toFixed(2)}`);
  console.log("");

  if (summary.finalFailures > 0) {
    console.log("Failures:");
    for (const r of results) {
      if (!r.finalPassed) {
        console.log(`  ❌ ${r.fixtureId}: ${[...r.normalizationErrors, ...r.validationErrors].join("; ")}`);
      }
    }
    console.log("");
  }

  // Write reports
  const fs = await import("fs");
  const path = await import("path");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = "tmp/structured-translation-evaluation";

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // JSON report
  const jsonPath = path.join(dir, `evaluation-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`JSON report: ${jsonPath}`);

  // Markdown report
  const mdPath = path.join(dir, `evaluation-${timestamp}.md`);
  const mdLines: string[] = [
    `# Structured Translation Shadow Evaluation`,
    `**Mode:** LIVE`,
    `**Timestamp:** ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    `| Metric | Value |`,
    `|---|---|`,
    `| Total fixtures | ${summary.totalFixtures} |`,
    `| AI requests | ${summary.totalAiRequests} |`,
    `| Initial passes | ${summary.initialPasses} |`,
    `| Repair attempts | ${summary.repairAttempts} |`,
    `| Repair successes | ${summary.repairSuccesses} |`,
    `| Final passes | ${summary.finalPasses} |`,
    `| Final failures | ${summary.finalFailures} |`,
    `| Average char ratio | ${summary.averageCharacterRatio.toFixed(2)} |`,
    ``,
    `## Fixture Details`,
    `| Fixture | Passed | Repair? | Block count | Numbers OK | Links OK | Policy OK |`,
    `|---|---|---|---|---|---|---|`,
  ];

  for (const r of results) {
    const status = r.finalPassed ? "✅" : "❌";
    const repairStatus = r.repairAttempted ? (r.repairPassed ? "✅" : "❌") : "—";
    mdLines.push(`| ${r.fixtureId} | ${status} | ${repairStatus} | ${r.blockCountPreserved ? "✅" : "❌"} | ${r.numbersPreserved ? "✅" : "❌"} | ${r.linksPreserved ? "✅" : "❌"} | ${r.conclusionPolicyPassed ? "✅" : "❌"} |`);
  }

  mdLines.push(
    ``,
    `## Translated Text (for language review)`,
    ``,
  );

  for (const r of results) {
    if (r.translatedText) {
      mdLines.push(`### ${r.fixtureId}`);
      mdLines.push(``);
      mdLines.push(r.translatedText.length > 500 ? r.translatedText.substring(0, 500) + "..." : r.translatedText);
      mdLines.push(``);
    }
  }

  if (summary.finalFailures > 0) {
    mdLines.push(``, `## Validation Errors`, ``);
    for (const r of results) {
      const allErrors = [...r.normalizationErrors, ...r.validationErrors];
      if (allErrors.length > 0) {
        mdLines.push(`### ${r.fixtureId}`);
        for (const e of allErrors) mdLines.push(`- ${e}`);
        mdLines.push(``);
      }
    }
  }

  fs.writeFileSync(mdPath, mdLines.join("\n"), "utf-8");
  console.log(`Markdown report: ${mdPath}`);
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
