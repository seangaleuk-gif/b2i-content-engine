#!/usr/bin/env tsx
// ── Evidence summary CLI ──
// Reads local evidence records and reports aggregate metrics.
// Makes zero AI calls.

import * as fs from "fs";
import * as path from "path";
import type { ConclusionShadowEvidenceRecord } from "../src/lib/services/conclusion-shadow-evidence";

const EVIDENCE_DIR = "tmp/structured-translation-production-evidence";

function pad(s: string, n: number): string { return s.padEnd(n); }

interface SummaryTotals {
  total: number;
  initialPass: number;
  repairedPass: number;
  finalPass: number;
  finalFailure: number;
  categoryCounts: Record<string, number>;
  hasMultipleParagraphs: number;
  hasStrong: number;
  hasEmphasis: number;
  hasLinks: number;
  hasList: number;
  hasTable: number;
  hasDate: number;
  hasCurrency: number;
  hasPercentage: number;
  hasRange: number;
  hasSuffixNumber: number;
  linkFailures: number;
  numberFailures: number;
  placeholderFailures: number;
  ctaPolicyFailures: number;
  totalSourceChars: number;
  totalTranslatedChars: number;
}

function main(): void {
  const dir = path.resolve(EVIDENCE_DIR);
  if (!fs.existsSync(dir)) {
    console.log(`Evidence directory not found: ${EVIDENCE_DIR}`);
    console.log("No records to summarize.");
    process.exit(0);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log(`No evidence records found in ${EVIDENCE_DIR}`);
    process.exit(0);
  }

  const records: ConclusionShadowEvidenceRecord[] = [];
  for (const file of files) {
    try {
      const data = fs.readFileSync(path.join(dir, file), "utf-8");
      records.push(JSON.parse(data));
    } catch {
      console.warn(`  ⚠ Failed to parse ${file}`);
    }
  }

  const totals: SummaryTotals = {
    total: records.length,
    initialPass: 0,
    repairedPass: 0,
    finalPass: 0,
    finalFailure: 0,
    categoryCounts: {},
    hasMultipleParagraphs: 0,
    hasStrong: 0,
    hasEmphasis: 0,
    hasLinks: 0,
    hasList: 0,
    hasTable: 0,
    hasDate: 0,
    hasCurrency: 0,
    hasPercentage: 0,
    hasRange: 0,
    hasSuffixNumber: 0,
    linkFailures: 0,
    numberFailures: 0,
    placeholderFailures: 0,
    ctaPolicyFailures: 0,
    totalSourceChars: 0,
    totalTranslatedChars: 0,
  };

  for (const r of records) {
    if (r.shadowPassed) {
      totals.finalPass++;
      if (r.repaired) totals.repairedPass++;
      else totals.initialPass++;
    } else {
      totals.finalFailure++;
    }

    for (const cat of r.errorCategories) {
      totals.categoryCounts[cat] = (totals.categoryCounts[cat] || 0) + 1;
    }

    if (r.hasMultipleParagraphs) totals.hasMultipleParagraphs++;
    if (r.hasStrong) totals.hasStrong++;
    if (r.hasEmphasis) totals.hasEmphasis++;
    if (r.hasLinks) totals.hasLinks++;
    if (r.hasList) totals.hasList++;
    if (r.hasTable) totals.hasTable++;
    if (r.hasDate) totals.hasDate++;
    if (r.hasCurrency) totals.hasCurrency++;
    if (r.hasPercentage) totals.hasPercentage++;
    if (r.hasRange) totals.hasRange++;
    if (r.hasSuffixNumber) totals.hasSuffixNumber++;

    if (!r.linksPreserved) totals.linkFailures++;
    if (!r.numberPreserved) totals.numberFailures++;
    if (!r.placeholderIntegrityPassed) totals.placeholderFailures++;
    if (!r.conclusionPolicyPassed) totals.ctaPolicyFailures++;

    totals.totalSourceChars += r.sourceCharacters;
    totals.totalTranslatedChars += r.translatedCharacters;
  }

  const avgRatio = totals.totalSourceChars > 0
    ? (totals.totalTranslatedChars / totals.totalSourceChars).toFixed(3)
    : "N/A";

  console.log("=".repeat(60));
  console.log("CONCLUSION SHADOW EVIDENCE SUMMARY");
  console.log("=".repeat(60));
  console.log("");
  console.log(`  ${pad("Total production-derived samples:", 42)} ${totals.total}`);
  console.log(`  ${pad("Initial passes (no repair needed):", 42)} ${totals.initialPass}`);
  console.log(`  ${pad("Repaired passes:", 42)} ${totals.repairedPass}`);
  console.log(`  ${pad("Final passes:", 42)} ${totals.finalPass}`);
  console.log(`  ${pad("Final failures:", 42)} ${totals.finalFailure}`);
  console.log(`  ${pad("Average character ratio:", 42)} ${avgRatio}`);
  console.log("");
  console.log("Failure categories:");
  if (Object.keys(totals.categoryCounts).length === 0 && totals.finalFailure === 0) {
    console.log("  (none)");
  } else {
    for (const [cat, count] of Object.entries(totals.categoryCounts)) {
      console.log(`  ${pad(cat, 40)} ${count}`);
    }
  }
  console.log("");
  console.log("Structural diversity (counts, not percentages):");
  console.log(`  ${pad("Multiple paragraphs:", 32)} ${totals.hasMultipleParagraphs}`);
  console.log(`  ${pad("Strong formatting:", 32)} ${totals.hasStrong}`);
  console.log(`  ${pad("Emphasis formatting:", 32)} ${totals.hasEmphasis}`);
  console.log(`  ${pad("Links:", 32)} ${totals.hasLinks}`);
  console.log(`  ${pad("Lists:", 32)} ${totals.hasList}`);
  console.log(`  ${pad("Tables:", 32)} ${totals.hasTable}`);
  console.log(`  ${pad("Dates:", 32)} ${totals.hasDate}`);
  console.log(`  ${pad("Currencies:", 32)} ${totals.hasCurrency}`);
  console.log(`  ${pad("Percentages:", 32)} ${totals.hasPercentage}`);
  console.log(`  ${pad("Ranges:", 32)} ${totals.hasRange}`);
  console.log(`  ${pad("Suffix numbers:", 32)} ${totals.hasSuffixNumber}`);
  console.log("");
  console.log("Preservation failures:");
  console.log(`  ${pad("Link preservation:", 32)} ${totals.linkFailures}`);
  console.log(`  ${pad("Number preservation:", 32)} ${totals.numberFailures}`);
  console.log(`  ${pad("Placeholder integrity:", 32)} ${totals.placeholderFailures}`);
  console.log(`  ${pad("CTA policy:", 32)} ${totals.ctaPolicyFailures}`);
  console.log("");
  console.log(`Zero AI calls made.`);
  console.log(`Files: ${files.length} record(s) in ${EVIDENCE_DIR}`);
}

main();
