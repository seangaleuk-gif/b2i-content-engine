import { describe, expect, it } from "vitest";
import type { ArticleDocument } from "@/lib/blog/article-document";
import {
  isSourceBoilerplate,
  stripSourceBoilerplate,
  countBoilerplateInDocument,
} from "@/lib/blog/source-boilerplate";
import { buildEvidenceLedger } from "@/lib/blog/factual-risk-scanner";

// ── A. Privacy-advice list false positive ──

const PRODUCTION_PRIVACY_ADVICE =
  "Ask for permission before you track or personalise — and make it easy to say no. " +
  "Use first-party data from your own channels, like email sign-ups and purchase history. " +
  "Offer a clear cookie consent option before any tracking starts.";

function privacyAdviceDoc(): ArticleDocument {
  return {
    metadata: { title: "T", slug: "t", metaDescription: "D", excerpt: "E", targetWordCount: 1500, focusKeyphrase: "data privacy" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{
      id: "section-2",
      heading: "Data Privacy and Trust",
      headingLevel: 2,
      sectionType: "main",
      status: "generated",
      blocks: [{
        id: "section-2-wp-6",
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "Ask for permission before you track or personalise — and make it easy to say no." }],
          [{ type: "text", text: "Use first-party data from your own channels, like email sign-ups and purchase history." }],
          [{ type: "text", text: "Offer a clear cookie consent option before any tracking starts." }],
        ],
      }],
    }],
    visibleFaq: [],
    conclusion: { id: "conclusion", blocks: [], status: "generated" },
    cta: null,
    faqSchema: null,
    insertedLinks: [],
  };
}

// ── B. Event-page promotional leak ──

const PRODUCTION_EVENT_COPY =
  "Every session is curated to reflect the latest industry trends and shifts — and trust is the thread that runs through it.";

describe("A. legitimate privacy-advice content is NOT source boilerplate", () => {
  it("the production privacy-advice list is not flagged", () => {
    expect(isSourceBoilerplate(PRODUCTION_PRIVACY_ADVICE)).toBe(false);
    const findings = countBoilerplateInDocument(privacyAdviceDoc());
    expect(findings).toEqual([]);
  });

  it("editorial advice variants are not flagged", () => {
    for (const text of [
      "Use first-party data from your own channels, like email sign-ups and purchase history.",
      "Link to a clear privacy policy from every signup form.",
      "Show a short privacy notice before collecting any personal data.",
      "Publish clear terms of service so customers know their rights.",
      "Offer a cookie consent option before any tracking starts.",
    ]) {
      expect(isSourceBoilerplate(text), text).toBe(false);
    }
  });

  it("genuine publisher self-referential boilerplate is still flagged", () => {
    for (const text of [
      "Please review our privacy policy before continuing.",
      "This website uses cookies to improve your experience.",
      "We use cookies for analytics and personalisation.",
      "Read this site's cookie preferences to manage tracking.",
      "Your use of this site is governed by the terms of service of this site.",
    ]) {
      expect(isSourceBoilerplate(text), text).toBe(true);
    }
  });

  it("the existing copyright/disclaimer/ownership classes are unchanged", () => {
    for (const text of [
      "All rights reserved.",
      "All rights belong to their respective owners.",
      "No part of this article may be reproduced without written permission.",
      "The views, information, or opinions expressed are solely those of the author.",
      "This is not financial advice.",
    ]) {
      expect(isSourceBoilerplate(text), text).toBe(true);
    }
  });

  it("a valid marketing-tips list is not flagged", () => {
    const doc: ArticleDocument = {
      ...privacyAdviceDoc(),
      sections: [{
        id: "section-0",
        heading: "Building a Weekly Routine",
        headingLevel: 2,
        sectionType: "main",
        status: "generated",
        blocks: [{
          id: "b0",
          type: "list",
          ordered: false,
          items: [
            [{ type: "text", text: "Post three times per week at a steady time." }],
            [{ type: "text", text: "Answer real customer questions in your replies." }],
            [{ type: "text", text: "Review which conversations drive profile visits." }],
          ],
        }],
      }],
    };
    expect(countBoilerplateInDocument(doc)).toEqual([]);
  });
});

describe("B. event-promotional copy is source boilerplate and never becomes evidence", () => {
  it("the production event sentence is flagged as boilerplate", () => {
    expect(isSourceBoilerplate(PRODUCTION_EVENT_COPY)).toBe(true);
    expect(isSourceBoilerplate("Each session is designed around a single practical theme.")).toBe(true);
    expect(isSourceBoilerplate("All events are subject to change without notice.")).toBe(true);
  });

  it("stripSourceBoilerplate removes the event copy and keeps useful sentences", () => {
    const stripped = stripSourceBoilerplate(
      `${PRODUCTION_EVENT_COPY} Attendance at the conference grew 40% year over year.`,
    );
    expect(stripped).not.toContain("curated");
    expect(stripped).toContain("grew 40%");
  });

  it("buildEvidenceLedger never emits the event-promotional sentence as evidence", () => {
    const ledger = buildEvidenceLedger([
      {
        title: "Marketing Event Hong Kong",
        snippet: `Every session is curated to reflect the latest industry trends and shifts — and trust is the thread that runs through it. About 40% of attendees now plan budgets for creator partnerships.`,
        url: "https://example.com/event",
      },
    ]);
    expect(ledger.some((entry) => entry.approvedText.includes("curated"))).toBe(false);
    expect(ledger.some((entry) => entry.approvedText.includes("40%"))).toBe(true);
  });

  it("useful event/industry evidence is preserved", () => {
    for (const text of [
      "Speakers reported that event attendance grew 40% year over year.",
      "The conference drew marketing teams from across Hong Kong.",
      "Survey respondents said industry events shape their purchasing decisions.",
    ]) {
      expect(isSourceBoilerplate(text), text).toBe(false);
    }
  });
});
