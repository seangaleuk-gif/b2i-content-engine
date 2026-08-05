import { describe, it, expect } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  findUnnaturalCalques,
  checkCtaParity,
  unresolvedMandatoryFindings,
} from "./editorial-review-gate";
import { emptyQualityReport } from "./shadow-cantonese-quality";

function paragraphBlock(id: string, text: string): ArticleDocument["introduction"]["blocks"][number] {
  return { id, type: "paragraph", content: [{ type: "text", text }] };
}

function makeBaseDoc(): ArticleDocument {
  return {
    metadata: { title: "香港創作者市場推廣指南", slug: "g", metaDescription: "指南。", excerpt: "指南。", targetWordCount: 1500, focusKeyphrase: "香港" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [
      { id: "s0", heading: "點樣揀創作者", headingLevel: 2, sectionType: "main", blocks: [paragraphBlock("s0-0", "內容")], status: "generated" },
    ],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    visibleFaq: [],
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

describe("editorial-review-gate: naturalness (project-19 V31)", () => {
  it("rejects the V31 unnatural nice-to-have replacement 有就最好", () => {
    const doc = makeBaseDoc();
    doc.sections[0].blocks[0] = paragraphBlock("s0-0", "香港創作者市場推廣已經由「有就最好」變成品牌接觸本地觀眾嘅核心部分。");
    const hits = findUnnaturalCalques(doc);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sourceUnitId).toBe("section.0.block.0");
    expect(hits[0].reason).toContain("nice-to-have");
  });

  it("accepts natural professional Hong Kong Cantonese without calque markers", () => {
    const doc = makeBaseDoc();
    doc.sections[0].blocks[0] = paragraphBlock("s0-0", "呢個策略對大部分團隊嚟講係個加分位，而唔係必要條件。");
    expect(findUnnaturalCalques(doc)).toEqual([]);
  });

  it("detects calques anywhere including FAQ answers", () => {
    const doc = makeBaseDoc();
    doc.visibleFaq = [{ question: "係咪有就最好？", answerHtml: "<p>答案有就最好。</p>", answerText: "答案有就最好。" }];
    const hits = findUnnaturalCalques(doc);
    expect(hits.some((h) => h.sourceUnitId === "faq.0.answer")).toBe(true);
  });
});

describe("editorial-review-gate: protected CTA parity (three claims)", () => {
  function ctaDoc(body: string): ArticleDocument {
    const doc = makeBaseDoc();
    doc.cta = { id: "cta", type: "cta", html: `<p>${body}</p>`, fingerprint: "cta" };
    return doc;
  }

  it("passes when all three claims are present", () => {
    const doc = ctaDoc("毋須經代理、毋須佣金、亦無中間人。");
    expect(checkCtaParity(doc).ok).toBe(true);
  });

  it("rejects when the no-agencies claim is missing (V31 defect)", () => {
    // V31 CTA had 無中介、無佣金 but no agencies claim.
    const doc = ctaDoc("直接連繫企業同已認證創作者，無中介、無佣金。");
    const res = checkCtaParity(doc);
    expect(res.ok).toBe(false);
    expect(res.missingClaims).toContain("no agencies");
  });

  it("rejects when any single claim is dropped", () => {
    expect(checkCtaParity(ctaDoc("毋須經代理、毋須佣金。")).missingClaims).toContain("no middlemen");
    expect(checkCtaParity(ctaDoc("毋須經代理、亦無中間人。")).missingClaims).toContain("no commissions");
  });

  it("passes when there is no protected CTA at all", () => {
    expect(checkCtaParity(makeBaseDoc()).ok).toBe(true);
  });
});

describe("editorial-review-gate: mandatory-finding resolution", () => {
  it("lists all unresolved critical/major findings regardless of selection", () => {
    const r = emptyQualityReport();
    r.findings.push({ sourceUnitId: "section.4.block.4", category: "terminology", severity: "major", messageCode: "forbidden-terminology" });
    r.findings.push({ sourceUnitId: "section.3.block.0", category: "english-leak", severity: "major", messageCode: "unexpected-english" });
    r.findings.push({ sourceUnitId: "section.1.block.9", category: "english-leak", severity: "minor", messageCode: "unexpected-english" });
    r.majorCount += 2;
    const unresolved = unresolvedMandatoryFindings(r);
    expect(unresolved.length).toBe(2);
    expect(unresolved.some((f) => f.sourceUnitId === "section.4.block.4")).toBe(true);
    expect(unresolved.some((f) => f.sourceUnitId === "section.3.block.0")).toBe(true);
  });

  it("returns none when no critical/major findings remain", () => {
    expect(unresolvedMandatoryFindings(emptyQualityReport())).toEqual([]);
  });
});
