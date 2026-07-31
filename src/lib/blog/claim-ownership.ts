// ── Claim Ownership Ledger ──
// Assigns every approved research claim to exactly one editorial section.
// Introduction, FAQ and conclusion are synthesis-only and never own precise claims.

import {
  buildEvidenceLedger,
  removeUnsupportedSentences,
  scanFactualRisks,
  type EvidenceLedgerEntry,
  type ScannedClaim,
} from "@/lib/blog/factual-risk-scanner";
import {
  type ArticleComponent,
  type ArticleDocument,
  type ArticleSection,
  renderComponentHtml,
  parseWordPressEditorialBlocks,
} from "@/lib/blog/article-document";

export interface ClaimOwnershipEntry extends EvidenceLedgerEntry {
  ownerSectionId: string;
  ownerSectionIndex: number;
  ownerHeading: string;
}

export interface ClaimOwnershipLedger {
  entries: ClaimOwnershipEntry[];
  sectionIds: string[];
}

export interface ClaimOwnershipRepairResult {
  removedSentences: number;
  removedDuplicateOccurrences: number;
  removedOutOfOwnerOccurrences: number;
  orphanedTransitionsRemoved: number;
  changedComponentIds: string[];
  unresolved: Array<{ componentId: string; evidenceId: string; sentenceText: string }>;
}

const TOKEN_STOP_WORDS = new Set([
  "about", "after", "and", "are", "avoid", "best", "build", "building", "for", "from",
  "guide", "how", "hong", "into", "kong", "marketing", "more", "need", "practical", "strategy",
  "that", "the", "their", "this", "threads", "tips", "using", "what", "when", "where", "why", "with",
]);

function tokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token)),
  )];
}

function includesAny(text: string, candidates: string[]): boolean {
  return candidates.some((candidate) => text.includes(candidate));
}

function semanticScore(heading: string, evidence: EvidenceLedgerEntry): number {
  const headingTokens = tokens(heading);
  const evidenceTokens = new Set(tokens(`${evidence.title} ${evidence.approvedText}`));
  let score = headingTokens.reduce((total, token) => total + (evidenceTokens.has(token) ? 12 : 0), 0);
  const h = heading.toLowerCase();
  const e = `${evidence.title} ${evidence.approvedText} ${evidence.concepts.join(" ")}`.toLowerCase();

  const groups: Array<{ heading: string[]; evidence: string[]; weight: number }> = [
    { heading: ["audience", "user", "demographic", "who uses", "adoption"], evidence: ["user", "audience", "monthly-active-users", "survey-sample", "platform-use", "demographic"], weight: 18 },
    { heading: ["growth", "market", "awareness", "opportunity", "landscape"], evidence: ["growth", "awareness", "increased", "doubled", "market"], weight: 18 },
    { heading: ["organic", "content", "conversation", "community", "engagement"], evidence: ["algorithm-distribution", "brand-follow", "conversation", "engagement-rate", "interaction"], weight: 16 },
    { heading: ["advert", "paid", "ads", "campaign"], evidence: ["ads-manager", "ad-targeting", "advertising", "cpm", "placement"], weight: 24 },
    { heading: ["measure", "metric", "result", "roi", "performance", "success"], evidence: ["engagement-rate", "cpm", "performance", "benchmark", "result"], weight: 20 },
    { heading: ["post", "timing", "frequency", "schedule", "cadence"], evidence: ["posting-cadence", "posting-time", "frequency", "schedule"], weight: 22 },
  ];
  for (const group of groups) {
    if (includesAny(h, group.heading) && includesAny(e, group.evidence)) score += group.weight;
  }
  return score;
}

/**
 * Deterministically assign every approved evidence sentence to one main section.
 * Ties are resolved by the least-loaded section, then outline order.
 */
export function buildClaimOwnershipLedger(
  sections: Array<Pick<ArticleSection, "id" | "heading" | "sectionType">>,
  research?: Array<{ title?: string; snippet?: string; url?: string }>,
): ClaimOwnershipLedger {
  const mainSections = sections.filter((section) => section.sectionType === "main" || section.sectionType === "mistakes");
  if (mainSections.length === 0) return { entries: [], sectionIds: [] };

  const loads = new Array(mainSections.length).fill(0);
  const entries = buildEvidenceLedger(research).map((evidence): ClaimOwnershipEntry => {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < mainSections.length; index++) {
      const score = semanticScore(mainSections[index].heading, evidence) - loads[index] * 2;
      if (score > bestScore || (score === bestScore && loads[index] < loads[bestIndex])) {
        bestScore = score;
        bestIndex = index;
      }
    }
    loads[bestIndex]++;
    const owner = mainSections[bestIndex];
    return {
      ...evidence,
      ownerSectionId: owner.id,
      ownerSectionIndex: bestIndex,
      ownerHeading: owner.heading,
    };
  });

  return { entries, sectionIds: mainSections.map((section) => section.id) };
}

export function evidenceForSection(
  ledger: ClaimOwnershipLedger,
  sectionId: string,
): ClaimOwnershipEntry[] {
  return ledger.entries.filter((entry) => entry.ownerSectionId === sectionId);
}

export function formatOwnedEvidencePacket(
  ledger: ClaimOwnershipLedger,
  sectionId: string,
): string {
  const entries = evidenceForSection(ledger, sectionId);
  if (entries.length === 0) {
    return "No precise research claim is assigned to this section. Do not use statistics, dates, currencies, quotations, performance benchmarks, posting frequencies or platform-availability claims.";
  }
  return entries.map((entry) => [
    `${entry.evidenceId} — owner: ${entry.ownerHeading}`,
    `Approved claim: ${entry.approvedText}`,
    entry.url ? `Source URL: ${entry.url}` : "Source URL: unavailable",
  ].join("\n")).join("\n\n");
}

function componentSequence(doc: ArticleDocument): Array<{ componentId: string; component: ArticleComponent | ArticleSection }> {
  return [
    { componentId: doc.introduction.id, component: doc.introduction },
    ...doc.sections
      .filter((section) => section.sectionType !== "faq-heading" && section.sectionType !== "conclusion-heading")
      .map((section) => ({ componentId: section.id, component: section })),
    { componentId: doc.conclusion.id, component: doc.conclusion },
  ];
}

function blockTextWordCount(html: string): number {
  const parsed = parseWordPressEditorialBlocks(html, "claim-ownership-score");
  if (parsed.errors.length > 0 || parsed.blocks.length !== 1) return 0;
  const block = parsed.blocks[0];
  const text = block.type === "list"
    ? block.items.flat().map((node) => node.text).join(" ")
    : block.type === "table"
      ? [...block.headers, ...block.rows.flat()].flat().map((node) => node.text).join(" ")
      : block.content.map((node) => node.text).join("");
  return text.split(/\s+/).filter(Boolean).length;
}

interface ClaimOccurrence {
  componentId: string;
  component: ArticleComponent | ArticleSection;
  blockIndex: number;
  blockHtml: string;
  claim: ScannedClaim;
  order: number;
}

function occurrenceScore(occurrence: ClaimOccurrence): number {
  const claim = occurrence.claim;
  let score = 0;
  if (claim.evidenceUrl && occurrence.blockHtml.includes(claim.evidenceUrl)) score += 100;
  if (/according to|research (?:from|by)|data (?:from|shows)|study (?:from|by)/i.test(claim.sentenceText ?? "")) score += 30;
  score += Math.min(25, blockTextWordCount(occurrence.blockHtml));
  return score;
}

function collectOccurrences(
  doc: ArticleDocument,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): ClaimOccurrence[] {
  const occurrences: ClaimOccurrence[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const { componentId, component } of componentSequence(doc)) {
    for (let blockIndex = 0; blockIndex < component.blocks.length; blockIndex++) {
      const blockHtml = renderComponentHtml({ id: `${componentId}-claim-block`, blocks: [component.blocks[blockIndex]], status: component.status });
      const scan = scanFactualRisks(blockHtml, keyphrase, research);
      for (const claim of scan.claims) {
        if (!claim.supported || !claim.evidenceId) continue;
        // The factual scanner can emit several categories for one sentence
        // (for example percentage + date + numerical growth). Ownership is
        // sentence-level, so count that sentence only once per evidence item.
        const sentenceKey = (claim.sentenceText ?? claim.text).replace(/\s+/g, " ").trim().toLowerCase();
        const occurrenceKey = `${componentId}:${blockIndex}:${claim.evidenceId}:${sentenceKey}`;
        if (seen.has(occurrenceKey)) continue;
        seen.add(occurrenceKey);
        occurrences.push({ componentId, component, blockIndex, blockHtml, claim, order: order++ });
      }
    }
  }
  return occurrences;
}

/**
 * Remove supported precise claims outside their owner section and duplicate
 * occurrences inside the owner. The strongest owned occurrence survives.
 */
export function enforceClaimOwnership(
  doc: ArticleDocument,
  ledger: ClaimOwnershipLedger,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): ClaimOwnershipRepairResult {
  const result: ClaimOwnershipRepairResult = {
    removedSentences: 0,
    removedDuplicateOccurrences: 0,
    removedOutOfOwnerOccurrences: 0,
    orphanedTransitionsRemoved: 0,
    changedComponentIds: [],
    unresolved: [],
  };
  const changedComponentIds = new Set<string>();
  const ownerByEvidenceId = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry.ownerSectionId]));
  const occurrences = collectOccurrences(doc, keyphrase, research);
  const grouped = new Map<string, ClaimOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = grouped.get(occurrence.claim.evidenceId!) ?? [];
    list.push(occurrence);
    grouped.set(occurrence.claim.evidenceId!, list);
  }

  const removals = new Map<string, ScannedClaim[]>();
  for (const [evidenceId, group] of grouped) {
    const ownerId = ownerByEvidenceId.get(evidenceId);
    if (!ownerId) continue;
    const owned = group.filter((occurrence) => occurrence.componentId === ownerId);
    const survivor = owned.sort((left, right) => occurrenceScore(right) - occurrenceScore(left) || left.order - right.order)[0];
    for (const occurrence of group) {
      if (occurrence === survivor) continue;
      const key = `${occurrence.componentId}:${occurrence.blockIndex}`;
      const list = removals.get(key) ?? [];
      list.push(occurrence.claim);
      removals.set(key, list);
      if (occurrence.componentId === ownerId) result.removedDuplicateOccurrences++;
      else result.removedOutOfOwnerOccurrences++;
    }
  }

  // Process blocks in reverse index order per component so removals remain stable.
  for (const { componentId, component } of componentSequence(doc)) {
    const indexes = [...removals.keys()]
      .filter((key) => key.startsWith(`${componentId}:`))
      .map((key) => Number(key.substring(componentId.length + 1)))
      .sort((a, b) => b - a);
    for (const blockIndex of indexes) {
      const claims = removals.get(`${componentId}:${blockIndex}`) ?? [];
      const originalBlock = component.blocks[blockIndex];
      if (!originalBlock) continue;
      const blockHtml = renderComponentHtml({ id: `${componentId}-repair`, blocks: [originalBlock], status: component.status });
      const repaired = removeUnsupportedSentences(blockHtml, claims);
      const parsed = repaired.html.trim()
        ? parseWordPressEditorialBlocks(repaired.html, `${componentId}-claim-ownership-repair`)
        : { blocks: [], errors: [], warnings: [] };
      if (parsed.errors.length > 0 || (repaired.html.trim() && parsed.blocks.length === 0)) {
        for (const claim of claims) {
          result.unresolved.push({ componentId, evidenceId: claim.evidenceId ?? "unknown", sentenceText: claim.sentenceText ?? claim.text });
        }
        continue;
      }
      component.blocks.splice(blockIndex, 1, ...parsed.blocks);
      if (repaired.sentencesRemoved === 0) {
        for (const claim of claims) {
          result.unresolved.push({ componentId, evidenceId: claim.evidenceId ?? "unknown", sentenceText: claim.sentenceText ?? claim.text });
        }
      } else {
        result.removedSentences += repaired.sentencesRemoved;
        result.orphanedTransitionsRemoved += repaired.orphanedTransitionsRemoved;
        changedComponentIds.add(componentId);
        component.status = "normalized";
      }
    }
  }

  result.changedComponentIds = [...changedComponentIds];

  return result;
}

export interface ClaimOwnershipViolation {
  componentId: string;
  evidenceId: string;
  ownerSectionId: string;
  reason: "outside-owner" | "duplicate-owned-occurrence";
}

export function validateClaimOwnership(
  doc: ArticleDocument,
  ledger: ClaimOwnershipLedger,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): ClaimOwnershipViolation[] {
  const ownerByEvidenceId = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry.ownerSectionId]));
  const violations: ClaimOwnershipViolation[] = [];
  const ownedCounts = new Map<string, number>();
  for (const occurrence of collectOccurrences(doc, keyphrase, research)) {
    const evidenceId = occurrence.claim.evidenceId!;
    const ownerSectionId = ownerByEvidenceId.get(evidenceId);
    if (!ownerSectionId) continue;
    if (occurrence.componentId !== ownerSectionId) {
      violations.push({ componentId: occurrence.componentId, evidenceId, ownerSectionId, reason: "outside-owner" });
      continue;
    }
    const count = (ownedCounts.get(evidenceId) ?? 0) + 1;
    ownedCounts.set(evidenceId, count);
    if (count > 1) {
      violations.push({ componentId: occurrence.componentId, evidenceId, ownerSectionId, reason: "duplicate-owned-occurrence" });
    }
  }
  // Visible FAQ entries are synthesis-only and therefore can never own a
  // supported precise claim, even though they are not editorial block components.
  doc.visibleFaq.forEach((entry, index) => {
    const html = `${entry.question} ${entry.answerHtml || entry.answerText}`;
    const seen = new Set<string>();
    for (const claim of scanFactualRisks(html, keyphrase, research).claims) {
      if (!claim.supported || !claim.evidenceId || seen.has(claim.evidenceId)) continue;
      seen.add(claim.evidenceId);
      const ownerSectionId = ownerByEvidenceId.get(claim.evidenceId);
      if (ownerSectionId) {
        violations.push({
          componentId: `faq-${index}`,
          evidenceId: claim.evidenceId,
          ownerSectionId,
          reason: "outside-owner",
        });
      }
    }
  });
  return violations;
}
