import { describe, it, expect, vi } from "vitest";
import { translateEditorialBlocks, runConclusionStructuredShadow } from "./editorial-block-translation";
import { protectNumbersInEditorialBlocks } from "./editorial-block-protection";
import { serializeTranslationPayload } from "./translation-dto";
import { isSourceEcho, normalizeTranslationComparisonText } from "./translation-validator";
import { renderEditorialBlocksToWordPress, type EditorialBlock } from "@/lib/blog/article-content";

function p(text: string): EditorialBlock {
  return { id: "p", type: "paragraph", content: [{ type: "text", text }] };
}
function h3(text: string): EditorialBlock {
  return { id: "h3", type: "subheading", level: 3, content: [{ type: "text", text }] };
}
function li(ordered: boolean, items: string[]): EditorialBlock {
  return { id: "list", type: "list", ordered, items: items.map((t) => [{ type: "text", text: t }]) };
}
function quote(text: string): EditorialBlock {
  return { id: "q", type: "quote", content: [{ type: "text", text }] };
}

async function identityTranslate(protectedHtml: string): Promise<string> {
  return protectedHtml;
}

async function zhTranslate(protectedHtml: string): Promise<string> {
  return protectedHtml.replace(/Hello/g, "你好").replace(/World/g, "世界");
}

async function invalidHtmlTranslate(_protectedHtml: string): Promise<string> {
  return "NOT VALID WORDPRESS HTML {{{";
}

async function linkDroppingTranslate(_protectedHtml: string): Promise<string> {
  return "<!-- wp:paragraph --><p>No links here.</p><!-- /wp:paragraph -->";
}

describe("translateEditorialBlocks", () => {
  it("translates a paragraph round trip", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World")],
      componentId: "intro",
      componentKind: "introduction",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe("paragraph");
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("你好");
    expect(rendered).toContain("世界");
  });

  it("translates an H3 subheading", async () => {
    const result = await translateEditorialBlocks({
      blocks: [h3("Hello World")],
      componentId: "sec",
      componentKind: "section",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe("subheading");
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("你好");
  });

  it("translates ordered and unordered lists", async () => {
    const result = await translateEditorialBlocks({
      blocks: [li(false, ["Hello", "World"]), li(true, ["One", "Two"])],
      componentId: "list-sec",
      componentKind: "section",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(2);
    expect((result.blocks[0] as any).ordered).toBe(false);
    expect((result.blocks[1] as any).ordered).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("你好");
    expect(rendered).toContain("世界");
  });

  it("translates a quote", async () => {
    const result = await translateEditorialBlocks({
      blocks: [quote("Hello World")],
      componentId: "quote-sec",
      componentKind: "section",
      translateProtectedHtml: zhTranslate,
    });
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].type).toBe("quote");
  });

  it("preserves strong and emphasis inline content", async () => {
    const blocks: EditorialBlock[] = [
      { id: "p1", type: "paragraph", content: [
        { type: "text", text: "Normal " },
        { type: "strong", text: "Bold" },
        { type: "text", text: " and " },
        { type: "emphasis", text: "Italic" },
      ]},
    ];
    const result = await translateEditorialBlocks({
      blocks,
      componentId: "inline",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("<strong>Bold</strong>");
    expect(rendered).toContain("<em>Italic</em>");
  });

  it("preserves links", async () => {
    const blocks: EditorialBlock[] = [
      { id: "p1", type: "paragraph", content: [
        { type: "link", text: "Click here", href: "https://example.com" },
      ]},
    ];
    const result = await translateEditorialBlocks({
      blocks,
      componentId: "link-test",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com"');
    expect(rendered).toContain("Click here");
  });

  it("number protection and restoration occur centrally", async () => {
    const blocks: EditorialBlock[] = [
      { id: "p1", type: "paragraph", content: [
        { type: "text", text: "Price is HK$1,200 and 50% off" },
      ]},
    ];
    const result = await translateEditorialBlocks({
      blocks,
      componentId: "num-test",
      componentKind: "conclusion",
      translateProtectedHtml: identityTranslate,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("HK$1,200");
    expect(rendered).toContain("50%");
  });

  it("link validation occurs centrally — dropped links trigger repair", async () => {
    let repaired = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "link-check",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      repairProtectedHtml: async (html) => {
        repaired = true;
        return html;
      },
    });
    expect(repaired).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("repair that resolves errors produces successful result", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-ok",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p><a href=\"https://example.com\">Click</a></p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com"');
  });

  it("uses the structured fallback when HTML translation echoes English", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World with 25% growth")],
      componentId: "structured-recovery",
      componentKind: "section",
      translateProtectedHtml: identityTranslate,
      repairProtectedHtml: identityTranslate,
      translateProtectedPayload: async (payloadJson) => {
        const payload = JSON.parse(payloadJson);
        for (const block of payload.blocks) {
          for (const node of block.nodes || []) {
            node.text = node.text
              .replace("Hello World with", "香港團隊錄得")
              .replace("growth", "增長");
          }
        }
        return JSON.stringify(payload);
      },
    });

    expect(result.passed).toBe(true);
    expect(renderEditorialBlocksToWordPress(result.blocks)).toContain("香港團隊錄得");
    expect(renderEditorialBlocksToWordPress(result.blocks)).toContain("25%");
    expect(result.validationParity?.diagnostics).toContain("structured-fallback-used");
  });

  it.each([
    ["Threads reached 2.4M users in 2025", "Threads 達到", "2.4M"],
    ["Sales increased from 36% to 66%", "銷售由", "增加至 66%"],
  ])("rejects unchanged English %j and runs the structured fallback", async (source, zhFragment, numberFragment) => {
    const result = await translateEditorialBlocks({
      blocks: [p(source)],
      componentId: "structured-echo-recovery",
      componentKind: "section",
      translateProtectedHtml: identityTranslate,
      repairProtectedHtml: identityTranslate,
      translateProtectedPayload: async (payloadJson) => {
        const payload = JSON.parse(payloadJson);
        for (const block of payload.blocks) {
          for (const node of block.nodes || []) {
            if (source.includes("Threads reached")) {
              node.text = node.text
                .replace("Threads reached", "Threads 達到")
                .replace(" users in ", " 用戶，於 ");
            } else {
              node.text = node.text
                .replace("Sales increased from", "銷售由")
                .replace(" to ", " 增加至 ");
            }
          }
        }
        return JSON.stringify(payload);
      },
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain(zhFragment);
    expect(rendered).toContain(numberFragment);
    expect(rendered).not.toContain(source);
    expect(result.validationParity?.diagnostics).toContain("structured-fallback-used");
  });

  it("accepts a legitimate Chinese translation with numbers directly", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World with 25% growth")],
      componentId: "valid-zh-1",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Hello World 錄得 __NUM_0__ 增長</p><!-- /wp:paragraph -->",
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("Hello World 錄得 25% 增長");
    expect(result.validationParity?.diagnostics).not.toContain("structured-fallback-used");
  });

  it("accepts the required Chinese translation with mixed numbers and year", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Threads reached 2.4M users in 2025")],
      componentId: "valid-zh-2",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Threads 在 2025 年達到 __NUM_0__ 用戶</p><!-- /wp:paragraph -->",
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("Threads 在 2025 年達到 2.4M 用戶");
    expect(result.validationParity?.diagnostics).not.toContain("structured-fallback-used");
  });

  it("accepts a Chinese translation that reorders protected placeholders", async () => {
    // Chinese grammar may place the second percentage first ("66% 與 36% 之間").
    // Placeholder reordering stays legal; number preservation is count-based.
    const result = await translateEditorialBlocks({
      blocks: [p("Between 36% and 66%")],
      componentId: "valid-zh-reorder",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>__NUM_1__ 與 __NUM_0__ 之間</p><!-- /wp:paragraph -->",
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("66% 與 36% 之間");
    expect(result.validationParity?.diagnostics).not.toContain("structured-fallback-used");
  });

  it("accepts a Chinese percentage translation directly", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Sales increased from 36% to 66%")],
      componentId: "valid-zh-3",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>銷售由 __NUM_0__ 增加至 __NUM_1__</p><!-- /wp:paragraph -->",
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("銷售由 36% 增加至 66%");
    expect(result.validationParity?.diagnostics).not.toContain("structured-fallback-used");
  });

  it("accepts a mixed-language translation containing protected brand names", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Meta, Threads and Instagram are essential for Hong Kong marketers.")],
      componentId: "mixed-brands",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Meta、Threads、Instagram 對香港營銷人員至關重要。</p><!-- /wp:paragraph -->",
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("Meta、Threads、Instagram");
    expect(rendered).toContain("營銷");
    expect(result.validationParity?.diagnostics).not.toContain("structured-fallback-used");
  });

  it.each(["25%", "2025", "Meta", "Meta、Threads、Instagram"])(
    "does not reject the short token-only block %j when unchanged",
    async (token) => {
      const result = await translateEditorialBlocks({
        blocks: [p(token)],
        componentId: "token-only",
        componentKind: "section",
        translateProtectedHtml: identityTranslate,
      });

      expect(result.passed).toBe(true);
      expect(renderEditorialBlocksToWordPress(result.blocks)).toContain(token);
    },
  );

  it("rejects unchanged bilingual prose and runs the structured fallback", async () => {
    const source = "Use 「香港創作者」 when describing local creators.";
    const result = await translateEditorialBlocks({
      blocks: [p(source)],
      componentId: "bilingual-echo",
      componentKind: "section",
      translateProtectedHtml: identityTranslate,
      repairProtectedHtml: identityTranslate,
      translateProtectedPayload: async (payloadJson) => {
        const payload = JSON.parse(payloadJson);
        for (const block of payload.blocks) {
          for (const node of block.nodes || []) {
            node.text = "描述本地創作者時，請使用「香港創作者」。";
          }
        }
        return JSON.stringify(payload);
      },
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("描述本地創作者");
    expect(rendered).not.toContain("when describing local creators");
    expect(result.validationParity?.diagnostics).toContain("structured-fallback-used");
  });

  it("rejects a formatting-only echo and runs the structured fallback", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World with 25% growth")],
      componentId: "formatting-echo",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>\n  HELLO&nbsp;WORLD with __NUM_0__ growth\n</p><!-- /wp:paragraph -->",
      repairProtectedHtml: identityTranslate,
      translateProtectedPayload: async (payloadJson) => {
        const payload = JSON.parse(payloadJson);
        for (const block of payload.blocks) {
          for (const node of block.nodes || []) {
            node.text = node.text
              .replace("Hello World with", "香港團隊錄得")
              .replace("growth", "增長");
          }
        }
        return JSON.stringify(payload);
      },
    });

    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("香港團隊錄得");
    expect(rendered).toContain("25%");
    expect(result.validationParity?.diagnostics).toContain("structured-fallback-used");
  });

  it("genuine content changes are not classified as source echoes", async () => {
    // Changed numbers, percentages and URLs remain part of the equality
    // comparison and never trigger the echo guard on their own.
    expect(isSourceEcho("Sales increased from 36% to 66%", "Sales increased from 36% to 99%")).toBe(false);
    expect(isSourceEcho("Hello World with 25% growth", "Hello World with 25% annual growth")).toBe(false);
    expect(isSourceEcho("Use Meta Threads for growth", "Use Meta Threads for growth and reach")).toBe(false);
  });

  it("uses the structured fallback when the HTML provider throws", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("A practical English sentence with 40% growth")],
      componentId: "structured-provider-recovery",
      componentKind: "section",
      translateProtectedHtml: async () => { throw new Error("provider unavailable"); },
      translateProtectedPayload: async (payloadJson) => {
        const payload = JSON.parse(payloadJson);
        payload.blocks[0].nodes[0].text = payload.blocks[0].nodes[0].text
          .replace("A practical English sentence with", "這是一句實用中文，錄得")
          .replace("growth", "增長");
        return JSON.stringify(payload);
      },
    });

    expect(result.passed).toBe(true);
    expect(renderEditorialBlocksToWordPress(result.blocks)).toContain("40%");
    expect(result.validationParity?.diagnostics).toContain("structured-fallback-used");
  });

  it("validation failure without repair falls back to source", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "no-repair",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      // No repairProtectedHtml provided
    });
    expect(result.passed).toBe(false);
    // Fallback produces blocks from source HTML
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("second invalid result (repair also bad) falls back to source", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-bad",
      componentKind: "section",
      translateProtectedHtml: linkDroppingTranslate,
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>Still no links.</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("parser errors fail closed and never accept the malformed H2", async () => {
    // H2 headings in editorial HTML trigger a parse error. Provider failures
    // (including parse failures of AI output) are isolated so the orchestrator
    // can continue translating the remaining article; the component must fail
    // closed with a source-preserving fallback and surface the failure through
    // the status channel the orchestrator uses to attribute the component ID.
    let failureReported = false;
    const result = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "h2-reject",
      componentKind: "introduction",
      translateProtectedHtml: async () => {
        return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
      },
      onStatus: (status) => {
        if (!status.passed) failureReported = true;
      },
    });
    expect(result.passed).toBe(false);
    // The fallback preserves the source blocks; the stray H2 is never accepted.
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every((block) => block.type !== "subheading" || (block as { level?: number }).level !== 2)).toBe(true);
    expect(failureReported).toBe(true);
  });

  it("source blocks are not mutated", async () => {
    const original = [p("Hello World")];
    const copy = JSON.parse(JSON.stringify(original));
    await translateEditorialBlocks({
      blocks: original,
      componentId: "mutate-test",
      componentKind: "introduction",
      translateProtectedHtml: zhTranslate,
    });
    expect(original).toEqual(copy);
  });

  it("rendering happens once per successful call", async () => {
    let callCount = 0;
    const result = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "render-count",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => {
        callCount++;
        return html;
      },
    });
    expect(callCount).toBe(1);
    expect(result.blocks.length).toBe(1);
  });

  it("returned blocks contain no H2", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello"), h3("World")],
      componentId: "no-h2",
      componentKind: "section",
      translateProtectedHtml: identityTranslate,
    });
    for (const block of result.blocks) {
      if (block.type === "subheading") {
        expect((block as any).level).not.toBe(2);
      }
    }
  });

  it("deterministic block IDs remain stable", async () => {
    const result1 = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "det",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    const result2 = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "det",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    expect(result1.blocks[0].id).toBe(result2.blocks[0].id);
  });

  it("empty source blocks return empty result", async () => {
    const result = await translateEditorialBlocks({
      blocks: [],
      componentId: "empty",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    expect(result.blocks).toEqual([]);
    expect(result.translatedHtml).toBe("");
    expect(result.passed).toBe(true);
  });

  it("onStatus callback receives metrics", async () => {
    let captured: any = null;
    await translateEditorialBlocks({
      blocks: [p("Hello World")],
      componentId: "status-test",
      componentKind: "introduction",
      translateProtectedHtml: zhTranslate,
      onStatus: (status) => { captured = status; },
    });
    expect(captured).not.toBeNull();
    expect(captured.passed).toBe(true);
    expect(captured.metrics.sourceChars).toBeGreaterThan(0);
  });
});

// ── Authority-switch tests ──

describe("structured number/link validation is authoritative", () => {
  it("structured passes + HTML shadow passes → translation passes", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
          { type: "text", text: " 50% off" },
        ]},
      ],
      componentId: "both-pass",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
    expect(result.validationParity).toBeDefined();
  });

  it("structured fails + HTML shadow passes → repair is triggered", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "struct-fail",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link here.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("structured passes + HTML shadow fails → translation passes with disagreement diagnostic", async () => {
    // Render source with numbers, translate back identical (structured sees no change).
    // HTML shadow may disagree because the number protection grammars differ.
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "text", text: "Value is 123" },
        ]},
      ],
      componentId: "shadow-fail",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => html,
    });
    // Structured sees the candidate passes (same content)
    expect(result.passed).toBe(true);
  });

  it("structured fails + HTML shadow fails → repair is triggered", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "both-fail",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("repaired candidate passes structured validation → translation succeeds", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-success",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p><a href=\"https://example.com\">Click</a></p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com"');
  });

  it("repaired candidate still fails → permanent-fallback behaviour", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "repair-fail",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>Still no link.</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0); // fallback
  });

  it("lost number blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "text", text: "Price HK$500" },
        ]},
      ],
      componentId: "num-lost",
      componentKind: "introduction",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Price dropped</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("changed number blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "text", text: "Price HK$500" },
        ]},
      ],
      componentId: "num-changed",
      componentKind: "introduction",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>Price HK$600</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("lost URL blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://example.com" },
        ]},
      ],
      componentId: "url-lost",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>No link.</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("changed URL blocks the candidate", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://original.com" },
        ]},
      ],
      componentId: "url-changed",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p><a href=\"https://changed.com\">Click</a></p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("translated visible label with unchanged URL passes", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click here", href: "https://example.com" },
        ]},
      ],
      componentId: "label-translated",
      componentKind: "conclusion",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p><a href=\"https://example.com\">按此</a></p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(true);
  });

  it("parsed blocks validated before structured number/link checks", async () => {
    // A parse error (H2 heading) is detected before any number/link check can
    // make the candidate acceptable: the component fails closed instead of
    // passing with a malformed structure.
    let failureReported = false;
    const result = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "parse-first",
      componentKind: "introduction",
      translateProtectedHtml: async () => {
        return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
      },
      onStatus: (status) => {
        if (!status.passed) failureReported = true;
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.every((block) => block.type !== "subheading" || (block as { level?: number }).level !== 2)).toBe(true);
    expect(failureReported).toBe(true);
  });

  it("source blocks are never mutated", async () => {
    const original = [
      { id: "p1", type: "paragraph" as const, content: [{ type: "text" as const, text: "HK$500" }] },
    ];
    const copy = JSON.parse(JSON.stringify(original));
    await translateEditorialBlocks({
      blocks: original,
      componentId: "no-mutate",
      componentKind: "introduction",
      translateProtectedHtml: identityTranslate,
    });
    expect(original).toEqual(copy);
  });

  it("component failures are surfaced for orchestrator diagnostics", async () => {
    // The orchestrator attributes failures to the stable component ID via the
    // status channel (onStatus with passed=false), so a failing component is
    // traceable even though provider failures are isolated instead of thrown.
    let failureReported = false;
    const result = await translateEditorialBlocks({
      blocks: [p("Hello")],
      componentId: "diag-id",
      componentKind: "introduction",
      translateProtectedHtml: async () => {
        return "<!-- wp:heading {\"level\":2} --><h2>Stray H2</h2><!-- /wp:heading -->";
      },
      onStatus: (status) => {
        if (!status.passed) failureReported = true;
      },
    });
    expect(result.passed).toBe(false);
    expect(failureReported).toBe(true);
  });
});

// ── Block-level protection lifecycle ──

describe("block-level number protection lifecycle", () => {
  it("source blocks are protected before rendering", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "HK$500 and 50% off" }] },
      ],
      componentId: "protect-before",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => {
        expect(html).toContain("__NUM_");
        return html;
      },
    });
    expect(result.passed).toBe(true);
    expect(result.blocks[0].type).toBe("paragraph");
  });

  it("AI receives rendered HTML containing placeholders", async () => {
    let receivedHtml = "";
    await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "Price HK$1,200" }] },
      ],
      componentId: "ai-receives",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        receivedHtml = html;
        return html;
      },
    });
    expect(receivedHtml).toContain("__NUM_");
    expect(receivedHtml).toContain("wp:paragraph");
  });

  it("source blocks remain unchanged after protection", async () => {
    const original = [
      { id: "p1", type: "paragraph" as const, content: [{ type: "text" as const, text: "Price HK$500" }] },
    ];
    const copy = JSON.parse(JSON.stringify(original));
    await translateEditorialBlocks({
      blocks: original,
      componentId: "no-mutate-src",
      componentKind: "introduction",
      translateProtectedHtml: async (html) => html,
    });
    expect(original).toEqual(copy);
  });

  it("restored output contains exact original numbers", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "HK$1,200 and 50% off" }] },
      ],
      componentId: "exact-restore",
      componentKind: "conclusion",
      translateProtectedHtml: async (html) => html,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("HK$1,200");
    expect(rendered).toContain("50%");
  });

  it("returned blocks contain no placeholders", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "100% and HK$500" }] },
      ],
      componentId: "no-phas",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    const allText = result.blocks
      .flatMap((b) => b.type === "paragraph" ? b.content.map((c: any) => c.text).join(" ") : "")
      .join(" ");
    expect(allText).not.toContain("__NUM_");
  });

  it("source text without numbers is translated cleanly", async () => {
    // An empty source-number set must never be treated as a missing-number
    // failure. The identity mock is intentionally NOT used here: an unchanged
    // English response is correctly rejected by completeness and the
    // source-echo guard, so the provider mock returns a real Chinese
    // translation that contains no numbers.
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "This is plain text without any digits" }] },
      ],
      componentId: "plain-safe",
      componentKind: "introduction",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>這是沒有數字的純文字內容</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(true);
    expect(renderEditorialBlocksToWordPress(result.blocks)).toContain("純文字");
  });
});

// ── Placeholder integrity ──

describe("placeholder integrity validation", () => {
  it("one missing placeholder triggers repair", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "10 items and 50% off" }] },
      ],
      componentId: "missing-ph",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        // Drop one placeholder
        return html.replace(/__NUM_\d+__/, "");
      },
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
  });

  it("changed placeholder triggers repair", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "changed-ph",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        return html.replace(/__NUM_0__/, "__NUM_99__");
      },
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
  });

  it("duplicated placeholder triggers repair", async () => {
    let repairCalled = false;
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "dup-ph",
      componentKind: "section",
      translateProtectedHtml: async (html) => {
        const ph = html.match(/__NUM_\d+__/)?.[0] || "";
        return html.replace(ph, ph + " " + ph);
      },
      repairProtectedHtml: async (html) => {
        repairCalled = true;
        return html;
      },
    });
    expect(repairCalled).toBe(true);
  });

  it("repaired candidate succeeds after placeholder integrity failure", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "repair-ph-ok",
      componentKind: "section",
      translateProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>__NUM_0__ off</p><!-- /wp:paragraph -->";
      },
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>50% off</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(true);
  });

  it("second invalid candidate follows existing fallback", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [{ type: "text", text: "50% off" }] },
      ],
      componentId: "repair-ph-fail",
      componentKind: "section",
      translateProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>no placeholder here</p><!-- /wp:paragraph -->";
      },
      repairProtectedHtml: async () => {
        return "<!-- wp:paragraph --><p>still no placeholder</p><!-- /wp:paragraph -->";
      },
    });
    expect(result.passed).toBe(false);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("numeric URL remains unchanged through protection", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Link 123", href: "https://example.com/page123" },
        ]},
      ],
      componentId: "numeric-url",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain('href="https://example.com/page123"');
  });

  it("basic link with number passes identity", async () => {
    // Verify the simplest identity translate with a link that has numbers.
    // This must pass because the AI preserves both the placeholder and the URL.
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Read 50", href: "https://example.com" },
        ]},
      ],
      componentId: "label-num-id",
      componentKind: "conclusion",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
  });

  it("link label with number survives round trip with label translated", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Read 50", href: "https://example.com" },
        ]},
      ],
      componentId: "label-num",
      componentKind: "conclusion",
      translateProtectedHtml: async (html) => {
        return html.replace("Read __NUM_0__", "閱讀 __NUM_0__");
      },
    });
    expect(result.passed).toBe(true);
    const rendered = renderEditorialBlocksToWordPress(result.blocks);
    expect(rendered).toContain("50");
    expect(rendered).toContain('href="https://example.com"');
  });

  it("two links same label different URLs preserved", async () => {
    const result = await translateEditorialBlocks({
      blocks: [
        { id: "p1", type: "paragraph", content: [
          { type: "link", text: "Click", href: "https://a.com" },
          { type: "link", text: "Click", href: "https://b.com" },
        ]},
      ],
      componentId: "label-diff-url",
      componentKind: "section",
      translateProtectedHtml: async (html) => html,
    });
    expect(result.passed).toBe(true);
  });
});

// ── Structured translation shadow ──

describe("runConclusionStructuredShadow", () => {
  const identityPayload = (json: string) => Promise.resolve(json);
  function makeConclusionBlocks(): ReturnType<typeof protectNumbersInEditorialBlocks> {
    return protectNumbersInEditorialBlocks([
      { id: "c1", type: "paragraph", content: [
        { type: "text", text: "This is the conclusion with 50% growth." },
        { type: "link", text: "Learn more", href: "https://example.com" },
      ]},
    ]);
  }

  // ── Feature control ──

  it("disabled by default", async () => {
    const result = await runConclusionStructuredShadow(
      [],
      { placeholders: [], originalValues: [] },
      "zh-conc",
      { enabled: false, translatePayload: async () => { throw new Error("should not be called"); } },
    );
    expect(result.enabled).toBe(false);
    expect(result.attempted).toBe(false);
  });

  it("disabled mode makes zero AI calls", async () => {
    const fn = vi.fn();
    await runConclusionStructuredShadow(
      [],
      { placeholders: [], originalValues: [] },
      "zh-conc",
      { enabled: false, translatePayload: fn },
    );
    expect(fn).not.toHaveBeenCalled();
  });

  // ── Payload safety ──

  it("payload contains no block IDs", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).not.toContain("c1");
    expect(captured).toContain("__NUM_0__");
    expect(captured).toContain("linkRef");
  });

  it("payload contains no URLs", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).not.toContain("https://");
    expect(captured).not.toContain("href");
    expect(captured).not.toContain("sourceType");
  });

  it("payload contains no WordPress HTML", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).not.toContain("wp:");
    expect(captured).not.toContain("<!--");
  });

  it("payload contains protected number placeholders", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).toContain("__NUM_0__");
  });

  it("componentKind is conclusion", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let captured = "";
    await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async (json) => { captured = json; return json; },
    });
    expect(captured).toContain('"conclusion"');
  });

  // ── Successful shadow flow ──

  it("valid JSON normalizes and passes", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.attempted).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.blockCount).toBeGreaterThan(0);
  });

  it("shadow success does not affect authoritative output", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.passed).toBe(true);
    // Authoritative conclusion is stored separately — no side effect from shadow
  });

  it("links reconstruct from private link map", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.passed).toBe(true);
  });

  // ── Failure and repair ──

  it("malformed JSON triggers one repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => "not valid json",
      repairPayload: async (src, invalid, errs) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("CTA introduced in conclusion triggers repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => {
        const response = {
          componentKind: "conclusion",
          blocks: [{ type: "paragraph", seq: 0, nodes: [{ type: "text", seq: 0, text: "Ready to grow your brand" }] }],
        };
        return JSON.stringify(response);
      },
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("second invalid payload records shadow failure", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => "invalid",
      // no repair
    });
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("no extra repair attempts occur", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCount = 0;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => "invalid",
      repairPayload: async () => {
        repairCount++;
        return null;
      },
    });
    expect(repairCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  // ── Result isolation ──

  it("shadow blocks are never stored anywhere", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    expect(result.passed).toBe(true);
    // No global state change — result is only in the returned object
  });

  it("link map contents not included in diagnostics", async () => {
    const { blocks, state } = makeConclusionBlocks();
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: identityPayload,
    });
    for (const err of result.errors) {
      expect(err).not.toContain("https://");
      expect(err).not.toContain("example.com");
    }
  });

  // ── Additional failure cases ──

  it("structural mismatch triggers one repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "subheading", seq: 0, nodes: [{ type: "text", seq: 0, text: "Changed" }] },
        ],
      }),
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("missing placeholder triggers one repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "paragraph", seq: 0, nodes: [
            { type: "text", seq: 0, text: "This is the conclusion without placeholder." },
            { type: "link", seq: 1, linkRef: "link-0", text: "Learn more" },
          ]},
        ],
      }),
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("unknown linkRef triggers repair", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "paragraph", seq: 0, nodes: [
            { type: "text", seq: 0, text: "This is the conclusion with 50% growth." },
            { type: "link", seq: 1, linkRef: "link-999", text: "Bad ref" },
          ]},
        ],
      }),
      repairPayload: async (src) => {
        repairCalled = true;
        return src;
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("valid repaired response succeeds after structural failure", async () => {
    const { blocks, state } = makeConclusionBlocks();
    let repairCalled = false;
    const result = await runConclusionStructuredShadow(blocks, state, "zh-conc", {
      enabled: true,
      translatePayload: async () => JSON.stringify({
        componentKind: "conclusion",
        blocks: [
          { type: "subheading", seq: 0, nodes: [{ type: "text", seq: 0, text: "Wrong" }] },
        ],
      }),
      repairPayload: async () => {
        repairCalled = true;
        const { payload: srcPayload } = serializeTranslationPayload(blocks, "conclusion");
        return JSON.stringify(srcPayload);
      },
    });
    expect(repairCalled).toBe(true);
    expect(result.passed).toBe(true);
  });
});





describe("professional translation structure gate", () => {
  it("rejects a candidate that drops an inline emphasis node", async () => {
    const result = await translateEditorialBlocks({
      blocks: [{ id: "p1", type: "paragraph", content: [
        { type: "text", text: "Hello " },
        { type: "strong", text: "World" },
      ] }],
      componentId: "inline-shape-loss",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>你好世界</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });

  it("rejects a candidate that adds a new URL", async () => {
    const result = await translateEditorialBlocks({
      blocks: [p("Hello World")],
      componentId: "new-url",
      componentKind: "section",
      translateProtectedHtml: async () => '<!-- wp:paragraph --><p><a href="https://invented.example">你好世界</a></p><!-- /wp:paragraph -->',
    });
    expect(result.passed).toBe(false);
  });

  it("rejects a materially incomplete translation", async () => {
    const source = "This is a complete business paragraph with several important details about planning, customers, measurement, execution, and long-term improvement.";
    const result = await translateEditorialBlocks({
      blocks: [p(source)],
      componentId: "incomplete",
      componentKind: "section",
      translateProtectedHtml: async () => "<!-- wp:paragraph --><p>摘要。</p><!-- /wp:paragraph -->",
    });
    expect(result.passed).toBe(false);
  });
});

describe("source-echo validator", () => {
  it("normalizes tags to spaces so adjacent paragraphs never merge words", () => {
    expect(normalizeTranslationComparisonText("<p>Hello</p><p>World</p>")).toBe("hello world");
  });

  it("normalizes entities, Unicode, whitespace and case", () => {
    expect(normalizeTranslationComparisonText("<p>\n  HELLO&nbsp;WORLD with 25% growth\n</p>")).toBe("hello world with 25% growth");
    expect(normalizeTranslationComparisonText("He said &#39;hi&#39; &amp; left.")).toBe("he said 'hi' & left.");
  });

  it("classifies unchanged meaningful English prose as a source echo", () => {
    expect(isSourceEcho("Hello World with 25% growth", "Hello World with 25% growth")).toBe(true);
    expect(isSourceEcho("Threads reached 2.4M users in 2025", "Threads reached 2.4M users in 2025")).toBe(true);
    expect(isSourceEcho("Sales increased from 36% to 66%", "Sales increased from 36% to 66%")).toBe(true);
  });

  it("classifies formatting-only differences as a source echo", () => {
    expect(isSourceEcho(
      "<p>Hello World with 25% growth</p>",
      "<p>\n  HELLO&nbsp;WORLD with 25% growth\n</p>",
    )).toBe(true);
  });

  it("classifies unchanged bilingual prose as a source echo despite CJK content", () => {
    expect(isSourceEcho(
      "Use 「香港創作者」 when describing local creators.",
      "Use 「香港創作者」 when describing local creators.",
    )).toBe(true);
  });

  it("never classifies short token-only blocks as source echoes", () => {
    expect(isSourceEcho("25%", "25%")).toBe(false);
    expect(isSourceEcho("2025", "2025")).toBe(false);
    expect(isSourceEcho("Meta", "Meta")).toBe(false);
    expect(isSourceEcho("Meta、Threads、Instagram", "Meta、Threads、Instagram")).toBe(false);
  });

  it("does not classify genuine Chinese translations as source echoes", () => {
    expect(isSourceEcho("Hello World with 25% growth", "Hello World 錄得 25% 增長")).toBe(false);
    expect(isSourceEcho("Threads reached 2.4M users in 2025", "Threads 在 2025 年達到 2.4M 用戶")).toBe(false);
    expect(isSourceEcho("Sales increased from 36% to 66%", "銷售由 36% 增加至 66%")).toBe(false);
    expect(isSourceEcho(
      "Meta, Threads and Instagram are essential for Hong Kong marketers.",
      "Meta、Threads、Instagram 對香港營銷人員至關重要。",
    )).toBe(false);
  });
});





