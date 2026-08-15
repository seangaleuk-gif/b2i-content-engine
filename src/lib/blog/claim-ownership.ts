// ── Claim Ownership Ledger ──
// Assigns every approved research claim to exactly one editorial section.
// Introduction, FAQ and conclusion are synthesis-only and never own precise claims.
//
// Enforcement and validation share ONE authoritative scanner
// (collectOwnershipOccurrences), ONE text-normalisation path (scanFactualRisks),
// ONE location model (componentKind/componentId/blockIndex/blockId/sectionId) and
// ONE canonical source (ArticleDocument). A violation detected by the final gate
// is therefore always detected by the enforcement stage, and a repair applied by
// the enforcement stage is always visible to the final gate.

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
  renderArticleDocument,
  renderFaqSchema,
  fingerprintHtml,
  parseArticleDocumentFromHtml,
  parseWordPressEditorialBlocks,
  parseCompleteEditorialRegion,
  decodeHtmlEntities,
} from "@/lib/blog/article-document";
import { essentialGroundingCarrierSentenceTexts } from "@/lib/blog/content-relevance";

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
  removedFaqSentences: number;
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

/** Shared location model: every claim occurrence is addressable the same way
 *  by enforcement and by validation, including synthesis-only FAQ entries. */
export type ClaimLocationComponentKind = "introduction" | "section" | "conclusion" | "faq";

export interface ClaimOccurrence {
  componentKind: ClaimLocationComponentKind;
  componentId: string;
  /** The owning-section id (null for intro/conclusion/FAQ). */
  sectionId: string | null;
  blockIndex: number;
  blockId: string;
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

/**
 * A bare 4-digit year in a `date_claim` that is the article's own topic year
 * (present in the focus keyphrase, title or meta description) is topic
 * context, not a precise factual claim owned by a section. For a topic-year
 * article ("Hong Kong Marketing Trends 2026") the year legitimately appears in
 * every section and in synthesis-only FAQ questions; treating it as an
 * ownership-tracked claim would strip the year from non-owner sections and
 * block the article on FAQ questions that merely name the topic.
 */
export function isTopicContextYearClaim(
  claim: ScannedClaim,
  topicContext: { keyphrase: string; title?: string; metaDescription?: string; headings?: string[] },
): boolean {
  if (claim.category !== "date_claim") return false;
  const year = claim.text.trim();
  if (!/^(?:19|20)\d{2}$/.test(year)) return false;
  const haystack = [
    topicContext.keyphrase,
    topicContext.title ?? "",
    topicContext.metaDescription ?? "",
    ...(topicContext.headings ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(year.toLowerCase());
}

/**
 * THE single authoritative ownership scanner. It scans the introduction, every
 * editorial section, the conclusion AND the visible FAQ — the same locations
 * the final validation gate checks — using the same scanFactualRisks
 * normalisation and the same location model.
 */
export function collectOwnershipOccurrences(
  doc: ArticleDocument,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): ClaimOccurrence[] {
  const occurrences: ClaimOccurrence[] = [];
  const seen = new Set<string>();
  let order = 0;
  const topicContext = {
    keyphrase,
    title: doc.metadata.title,
    metaDescription: doc.metadata.metaDescription,
    headings: doc.sections.map((section) => section.heading),
  };
  for (const { componentId, component } of componentSequence(doc)) {
    const kind: ClaimLocationComponentKind = componentId === doc.introduction.id
      ? "introduction"
      : componentId === doc.conclusion.id
        ? "conclusion"
        : "section";
    for (let blockIndex = 0; blockIndex < component.blocks.length; blockIndex++) {
      const block = component.blocks[blockIndex];
      const blockHtml = renderComponentHtml({ id: `${componentId}-claim-block`, blocks: [block], status: component.status });
      const scan = scanFactualRisks(blockHtml, keyphrase, research);
      for (const claim of scan.claims) {
        if (!claim.supported || !claim.evidenceId) continue;
        if (isTopicContextYearClaim(claim, topicContext)) continue;
        // The factual scanner can emit several categories for one sentence
        // (for example percentage + date + numerical growth). Ownership is
        // sentence-level, so count that sentence only once per evidence item.
        const sentenceKey = (claim.sentenceText ?? claim.text).replace(/\s+/g, " ").trim().toLowerCase();
        const occurrenceKey = `${componentId}:${blockIndex}:${claim.evidenceId}:${sentenceKey}`;
        if (seen.has(occurrenceKey)) continue;
        seen.add(occurrenceKey);
        occurrences.push({
          componentKind: kind,
          componentId,
          sectionId: kind === "section" ? componentId : null,
          blockIndex,
          blockId: block.id ?? `${componentId}-block-${blockIndex}`,
          blockHtml,
          claim,
          order: order++,
        });
      }
    }
  }
  // Synthesis-only visible FAQ: never an owner, but scanned by the same
  // scanner so enforcement can correct it and validation can flag it.
  const faqSectionId = doc.sections.find((section) => section.sectionType === "faq-heading")?.id ?? null;
  doc.visibleFaq.forEach((entry, index) => {
    const componentId = `faq-${index}`;
    const html = `${entry.question} ${entry.answerHtml || entry.answerText}`;
    const seenInEntry = new Set<string>();
    for (const claim of scanFactualRisks(html, keyphrase, research).claims) {
      if (!claim.supported || !claim.evidenceId || seenInEntry.has(claim.evidenceId)) continue;
      if (isTopicContextYearClaim(claim, topicContext)) continue;
      seenInEntry.add(claim.evidenceId);
      occurrences.push({
        componentKind: "faq",
        componentId,
        sectionId: faqSectionId,
        blockIndex: index,
        blockId: componentId,
        blockHtml: html,
        claim,
        order: order++,
      });
    }
  });
  return occurrences;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Remove every supported precise sentence from a synthesis-only FAQ answer so
 * the FAQ can never repeat evidence owned by a body section. This is the
 * deterministic correction at the FAQ-owning stage: it edits the canonical
 * visibleFaq entries and leaves the rendered FAQ/schema markup to be
 * re-derived by the renderer — it never patches protected HTML directly.
 */
export interface FaqTopicContext {
  keyphrase: string;
  title?: string;
  metaDescription?: string;
  headings?: string[];
}

export function cleanFaqOwnershipViolations(
  entries: ArticleDocument["visibleFaq"],
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
  topicContext?: FaqTopicContext,
): {
  entries: ArticleDocument["visibleFaq"];
  removedSentences: number;
  unresolved: Array<{ componentId: string; evidenceId: string; sentenceText: string }>;
} {
  const unresolved: Array<{ componentId: string; evidenceId: string; sentenceText: string }> = [];
  let totalRemoved = 0;
  const sanitized = entries.map((entry, index) => {
    const paragraphHtml =
      `<!-- wp:paragraph --><p>${escapeHtmlText(entry.answerText)}</p><!-- /wp:paragraph -->`;
    const claims = scanFactualRisks(paragraphHtml, keyphrase, research).claims
      .filter(
        (claim) =>
          claim.supported
          && claim.evidenceId
          && !isTopicContextYearClaim(claim, topicContext ?? { keyphrase }),
      );
    if (claims.length === 0) return entry;

    const cleanup = removeUnsupportedSentences(paragraphHtml, claims);
    totalRemoved += cleanup.sentencesRemoved;
    const cleanedText = decodeHtmlEntities(
      cleanup.html
        .replace(/<!--\s*wp:paragraph\s*-->[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<!--\s*\/wp:paragraph\s*-->/i, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    );

    for (const claim of claims) {
      if (cleanup.sentencesRemoved === 0) {
        unresolved.push({ componentId: `faq-${index}`, evidenceId: claim.evidenceId ?? "unknown", sentenceText: claim.sentenceText ?? claim.text });
      }
    }

    const answerText = cleanedText
      || "Use the practical guidance in the relevant section and adapt it to your audience and goals.";
    return {
      ...entry,
      answerText,
      answerHtml: `<p>${escapeHtmlText(answerText)}</p>`,
    };
  });
  return { entries: sanitized, removedSentences: totalRemoved, unresolved };
}

/**
 * Remove supported precise claims outside their owner section and duplicate
 * occurrences inside the owner. The strongest owned occurrence survives.
 *
 * The scanner used here (collectOwnershipOccurrences) is the same authoritative
 * scanner used by validateClaimOwnership and therefore by the final gate.
 * Introduction, conclusion and FAQ are synthesis-only: any supported claim they
 * carry is removed at their owning boundary (editable components for prose,
 * canonical visibleFaq entries for the FAQ) — never by patching protected HTML.
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
    removedFaqSentences: 0,
    orphanedTransitionsRemoved: 0,
    changedComponentIds: [],
    unresolved: [],
  };
  const changedComponentIds = new Set<string>();
  const ownerByEvidenceId = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry.ownerSectionId]));
  const occurrences = collectOwnershipOccurrences(doc, keyphrase, research);
  const grouped = new Map<string, ClaimOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = grouped.get(occurrence.claim.evidenceId!) ?? [];
    list.push(occurrence);
    grouped.set(occurrence.claim.evidenceId!, list);
  }

  // Editorial removals keyed by `${componentId}:${blockIndex}` with the
  // sentences that must be preserved (the canonical owned occurrences).
  const removals = new Map<string, ScannedClaim[]>();
  const preserveByKey = new Map<string, string[]>();
  // FAQ removals keyed by the canonical `faq-<index>` component id.
  const faqRemovals = new Map<string, ScannedClaim[]>();
  for (const [evidenceId, group] of grouped) {
    const ownerId = ownerByEvidenceId.get(evidenceId);
    if (!ownerId) continue;
    const owned = group.filter((occurrence) => occurrence.componentId === ownerId);
    const survivor = owned.sort((left, right) => occurrenceScore(right) - occurrenceScore(left) || left.order - right.order)[0];
    for (const occurrence of group) {
      if (occurrence === survivor) continue;
      if (occurrence.componentKind === "faq") {
        const list = faqRemovals.get(occurrence.componentId) ?? [];
        list.push(occurrence.claim);
        faqRemovals.set(occurrence.componentId, list);
        result.removedOutOfOwnerOccurrences++;
        continue;
      }
      const key = `${occurrence.componentId}:${occurrence.blockIndex}`;
      const list = removals.get(key) ?? [];
      list.push(occurrence.claim);
      removals.set(key, list);
      if (occurrence.componentId === ownerId) result.removedDuplicateOccurrences++;
      else result.removedOutOfOwnerOccurrences++;
    }
    if (survivor) {
      const survivorSentence = (survivor.claim.sentenceText ?? survivor.claim.text)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const preserveKey = `${survivor.componentId}:${survivor.blockIndex}`;
      const preserve = preserveByKey.get(preserveKey) ?? [];
      if (!preserve.some((sentence) => sentence.toLowerCase() === survivorSentence)) {
        preserve.push(survivor.claim.sentenceText ?? survivor.claim.text);
        preserveByKey.set(preserveKey, preserve);
      }
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
      // Section topic grounding is a hard invariant: an ownership removal must
      // never delete the section's LAST sentence carrying a heading content
      // word. When a single paragraph is the section's only grounding carrier,
      // its sentences are preserved (in addition to the canonical owned
      // occurrence), so the producer removes the out-of-owner claim and keeps
      // the section grounded.
      const groundingCarriers = essentialGroundingCarrierSentenceTexts(
        component as unknown as ArticleSection,
      );
      const repaired = removeUnsupportedSentences(blockHtml, claims, {
        preserveSentenceTexts: [
          ...(preserveByKey.get(`${componentId}:${blockIndex}`) ?? []),
          ...groundingCarriers,
        ],
      });
      const parsed = repaired.html.trim()
        ? parseCompleteEditorialRegion(repaired.html, `${componentId}-claim-ownership-repair`)
        : { blocks: [], errors: [] };
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

  // Synthesis-only FAQ correction at the FAQ-owning boundary. The visible FAQ
  // entries are the canonical source; the FAQPage schema is re-derived from the
  // corrected entries so the visible FAQ and the schema never diverge.
  if (faqRemovals.size > 0) {
    const cleanup = cleanFaqOwnershipViolations(doc.visibleFaq, keyphrase, research, {
      keyphrase,
      title: doc.metadata.title,
      metaDescription: doc.metadata.metaDescription,
    });
    doc.visibleFaq = cleanup.entries;
    if (cleanup.removedSentences > 0) result.removedFaqSentences += cleanup.removedSentences;
    result.unresolved.push(...cleanup.unresolved);
    if (doc.visibleFaq.length > 0) {
      const schemaHtml = renderFaqSchema(doc.visibleFaq);
      doc.faqSchema = {
        id: "faq-schema",
        type: "faq-schema",
        html: schemaHtml,
        fingerprint: fingerprintHtml(schemaHtml),
      };
    }
  }

  result.changedComponentIds = [...changedComponentIds];

  return result;
}

export interface ClaimOwnershipViolation {
  componentKind: ClaimLocationComponentKind;
  componentId: string;
  sectionId: string | null;
  blockIndex: number;
  blockId: string;
  evidenceId: string;
  ownerSectionId: string;
  ownerHeading: string;
  reason: "outside-owner" | "duplicate-owned-occurrence";
  snippet: string;
}

/**
 * The authoritative ownership validation used by the enforcement stage, the
 * editorial comparative validator and the final article gate. It scans the
 * exact same locations (intro, sections, conclusion, FAQ) with the exact same
 * scanner and location model as enforcement.
 */
export function validateClaimOwnership(
  doc: ArticleDocument,
  ledger: ClaimOwnershipLedger,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): ClaimOwnershipViolation[] {
  const ownerByEvidenceId = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry.ownerSectionId]));
  const ownerHeadingById = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry.ownerHeading]));
  const violations: ClaimOwnershipViolation[] = [];
  const ownedCounts = new Map<string, number>();
  for (const occurrence of collectOwnershipOccurrences(doc, keyphrase, research)) {
    const evidenceId = occurrence.claim.evidenceId!;
    const ownerSectionId = ownerByEvidenceId.get(evidenceId);
    if (!ownerSectionId) continue;
    const snippet = (occurrence.claim.sentenceText ?? occurrence.claim.text)
      .replace(/\s+/g, " ")
      .trim();
    const base = {
      componentKind: occurrence.componentKind,
      componentId: occurrence.componentId,
      sectionId: occurrence.sectionId,
      blockIndex: occurrence.blockIndex,
      blockId: occurrence.blockId,
      evidenceId,
      ownerSectionId,
      ownerHeading: ownerHeadingById.get(evidenceId) ?? "",
      snippet: snippet.slice(0, 160),
    };
    if (occurrence.componentId !== ownerSectionId) {
      violations.push({ ...base, reason: "outside-owner" });
      continue;
    }
    const count = (ownedCounts.get(evidenceId) ?? 0) + 1;
    ownedCounts.set(evidenceId, count);
    if (count > 1) {
      violations.push({ ...base, reason: "duplicate-owned-occurrence" });
    }
  }
  return violations;
}

/**
 * Enforce, then verify from the RENDERED canonical state. After the
 * deterministic repair it re-renders the canonical ArticleDocument, parses the
 * rendered HTML back into the canonical document (the exact state the final
 * gate reads) and rescans ownership. If violations remain it performs one
 * bounded targeted second pass. Any violation still present is returned —
 * callers must fail, never continue silently.
 */
export function enforceOwnershipAndVerify(
  doc: ArticleDocument,
  ledger: ClaimOwnershipLedger,
  keyphrase: string,
  research: Array<{ title?: string; snippet?: string; url?: string }>,
): {
  doc: ArticleDocument;
  repair: ClaimOwnershipRepairResult;
  secondPassRepair: ClaimOwnershipRepairResult | null;
  violations: ClaimOwnershipViolation[];
} {
  const repair = enforceClaimOwnership(doc, ledger, keyphrase, research);

  const html = renderArticleDocument(doc);
  const parsed = parseArticleDocumentFromHtml(html, doc);
  const canonical = parsed.doc ?? doc;
  let violations = validateClaimOwnership(canonical, ledger, keyphrase, research);
  let secondPassRepair: ClaimOwnershipRepairResult | null = null;
  if (violations.length > 0) {
    secondPassRepair = enforceClaimOwnership(canonical, ledger, keyphrase, research);
    violations = validateClaimOwnership(canonical, ledger, keyphrase, research);
  }
  return { doc: canonical, repair, secondPassRepair, violations };
}

/**
 * One-line, fully attributed record for every remaining violation. Used by the
 * enforcement stage before it fails, so an operator can identify the exact
 * claim, its source, the canonical owner, the actual location, the
 * section/block id, a snippet and the ownership reason.
 */
export function formatOwnershipViolationDetails(
  violations: ClaimOwnershipViolation[],
  ledger: ClaimOwnershipLedger,
): string[] {
  const entryByEvidenceId = new Map(ledger.entries.map((entry) => [entry.evidenceId, entry]));
  return violations.map((violation) => {
    const evidence = entryByEvidenceId.get(violation.evidenceId);
    return [
      `claim=${violation.evidenceId}`,
      `evidenceId=${violation.evidenceId}`,
      `sourceId=${violation.evidenceId}`,
      `sourceUrl=${evidence?.url ?? "unknown"}`,
      `canonicalOwner=${violation.ownerSectionId}`,
      `ownerHeading="${violation.ownerHeading}"`,
      `actualLocation=${violation.componentKind}:${violation.componentId}`,
      `blockId=${violation.blockId}`,
      `sectionOrBlockId=${violation.sectionId ?? violation.blockId}`,
      `snippet="${violation.snippet}"`,
      `reason=${violation.reason}`,
    ].join(" ");
  });
}
