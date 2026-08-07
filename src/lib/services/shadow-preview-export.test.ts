import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import type { ShadowEditorialInfo, ShadowPreviewInfo, ShadowAssemblyInfo } from "./document-context-shadow-preview";
import { buildShadowPreviewPayload } from "./document-context-shadow-preview";
import { exportShadowPreview, buildShadowPreviewHtml, DEFAULT_SHADOW_PREVIEW_DIR } from "./shadow-preview-export";

function makeRetainedDoc(body: string, title = "預覽標題"): ArticleDocument {
  return {
    metadata: { title, slug: "preview-zh", metaDescription: "meta", excerpt: "excerpt", targetWordCount: 0, focusKeyphrase: "香港" },
    languageSwitcher: null,
    introduction: { id: "intro", blocks: [], status: "generated" },
    sections: [{ id: "s0", heading: "標題", headingLevel: 2, sectionType: "main", blocks: [{ id: "p0", type: "paragraph", content: [{ type: "text", text: body }] }], status: "generated" }],
    visibleFaq: [],
    conclusion: { id: "conc", blocks: [], status: "generated" },
    cta: null, faqSchema: null, insertedLinks: [],
  };
}

function makeEditorial(status: ShadowEditorialInfo["status"], accepted: number, rejected: number, changed: number, pre: ArticleDocument | null, polished: ArticleDocument | null): ShadowEditorialInfo {
  return {
    enabled: true,
    status,
    batchCount: accepted + rejected,
    attemptCount: accepted + rejected,
    acceptedBatchCount: accepted,
    rejectedBatchCount: rejected,
    providerFailedCount: 0,
    validationRejectedCount: rejected,
    skippedCount: 0,
    changedUnitCount: changed,
    unchangedUnitCount: 0,
    batches: [],
    failure: rejected > 0 ? `${rejected} of ${accepted + rejected} rejected` : null,
    preEditorialDoc: pre,
    polishedDoc: polished,
    perUnitValid: 0,
    perUnitInvalid: 0,
    tokenUsage: null,
    invariantFailures: [],
    quality: null,
  };
}

function makeResult(status: ShadowEditorialInfo["status"], retainedDoc: ArticleDocument, retainedSource: ShadowPreviewInfo["retainedSource"]): Parameters<typeof buildShadowPreviewPayload>[0] {
  const assembly: ShadowAssemblyInfo = { status: "assembled", missingUnits: [], doc: retainedDoc };
  const editorial = makeEditorial(status, status === "polished" ? 3 : status === "partially-polished" ? 2 : 0, status === "polished" ? 0 : status === "partially-polished" ? 1 : 3, status === "pre-editorial" ? 0 : 73, retainedDoc, retainedDoc);
  const preview: ShadowPreviewInfo = { previewOnly: true, retainedDoc, retainedSource, stored: false, exportPath: null, timestamp: "2026-08-02T00:00:00.000Z" };
  return {
    totalPlannedChunks: 8,
    substantiveChunkCallCount: 7,
    providerAttemptCount: 7,
    validChunkCount: 7,
    partialChunkCount: 0,
    failedChunkCount: 0,
    coverage: { translatedSubstantive: { translated: 105, total: 105 } },
    assembly,
    editorial,
    preview,
  };
}

const tempDirs: string[] = [];
function makeOutputDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-preview-export-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("shadow preview export (development-only)", () => {
  it("writes JSON and HTML preview files for a polished result", () => {
    const dir = makeOutputDir();
    const doc = makeRetainedDoc("呢段係保留嘅精修文件內容。");
    const result = makeResult("polished", doc, "polished");
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });

    expect(fs.existsSync(out.jsonPath)).toBe(true);
    expect(fs.existsSync(out.htmlPath)).toBe(true);
    expect(path.extname(out.jsonPath)).toBe(".json");
    expect(path.extname(out.htmlPath)).toBe(".html");
    expect(out.jsonPath).toContain("project-19-");
  });

  it("HTML contains the retained polished document", () => {
    const dir = makeOutputDir();
    const body = "呢段係保留嘅精修文件內容。";
    const result = makeResult("polished", makeRetainedDoc(body), "polished");
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });
    const html = fs.readFileSync(out.htmlPath, "utf8");
    expect(html).toContain(body);
    expect(html).toContain("polished");
  });

  it("a partially polished result exports the partially polished document", () => {
    const dir = makeOutputDir();
    const body = "部分批次通過，保留部分精修內容。";
    const result = makeResult("partially-polished", makeRetainedDoc(body), "partially-polished");
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });
    const html = fs.readFileSync(out.htmlPath, "utf8");
    expect(html).toContain(body);
    expect(html).toContain("partially-polished");
  });

  it("a pre-editorial result exports the assembled pre-editorial document", () => {
    const dir = makeOutputDir();
    const body = "未進行任何精修，保留組裝後嘅內容。";
    const result = makeResult("pre-editorial", makeRetainedDoc(body), "pre-editorial");
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });
    const html = fs.readFileSync(out.htmlPath, "utf8");
    expect(html).toContain(body);
    expect(html).toContain("pre-editorial");
  });

  it("JSON metadata contains correct statuses and metrics", () => {
    const dir = makeOutputDir();
    const result = makeResult("polished", makeRetainedDoc("內容。"), "polished");
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });
    const json = JSON.parse(fs.readFileSync(out.jsonPath, "utf8"));

    expect(json.projectId).toBe(19);
    expect(json.createdAt).toBeDefined();
    expect(json.previewOnly).toBe(true);
    expect(json.publishable).toBe(false);
    expect(json.chunkMetrics.translatedCoverage).toBe("105/105");
    expect(json.assembly.status).toBe("assembled");
    expect(json.editorial.status).toBe("polished");
    expect(json.editorial.acceptedBatchCount).toBe(3);
    expect(json.editorial.rejectedBatchCount).toBe(0);
    expect(json.editorial.changedUnitCount).toBe(73);
    expect(json.retainedSource).toBe("polished");
    expect(json.outputHtmlPath).toBe(out.htmlPath);
  });

  it("introduces no database or blog-version write fields", () => {
    const dir = makeOutputDir();
    const result = makeResult("polished", makeRetainedDoc("內容。"), "polished");
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });
    const json = JSON.parse(fs.readFileSync(out.jsonPath, "utf8"));
    expect(json).not.toHaveProperty("savePayload");
    expect(json).not.toHaveProperty("blog");
    expect(json).not.toHaveProperty("failedComponents");
    expect(json).not.toHaveProperty("version");
  });

  it("does not mutate the input shadow result (production zhDoc/save payload unchanged)", () => {
    const dir = makeOutputDir();
    const result = makeResult("polished", makeRetainedDoc("內容。"), "polished");
    const before = JSON.stringify(result);
    exportShadowPreview(result, { projectId: 19, outputDir: dir });
    expect(JSON.stringify(result)).toBe(before);
  });

  it("writes article content to files but never to console logs", () => {
    const dir = makeOutputDir();
    const body = "極其重要嘅文章內文，唔應該出現喺日誌。";
    const result = makeResult("polished", makeRetainedDoc(body), "polished");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      exportShadowPreview(result, { projectId: 19, outputDir: dir });
      const logs = [...logSpy.mock.calls.map((c) => String(c[0])), ...warnSpy.mock.calls.map((c) => String(c[0]))].join("\n");
      expect(logs).not.toContain(body);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("persists safe malformed-JSON diagnostics (message, position, snippet, recovered) in the preview JSON", () => {
    const dir = makeOutputDir();
    const result = {
      ...makeResult("pre-editorial", null as unknown as ArticleDocument, "pre-editorial"),
      chunkResults: [{
        chunkId: "chunk.0",
        jsonDiagnostics: {
          errorMessage: "Unexpected token 'x' ... is not valid JSON",
          position: 42,
          snippet: "…localized snippet…",
          recovered: true,
        },
      }],
    };
    const payload = buildShadowPreviewPayload(result);
    expect(payload.jsonDiagnostics).toEqual({
      errorMessage: "Unexpected token 'x' ... is not valid JSON",
      position: 42,
      snippet: "…localized snippet…",
      recovered: true,
    });
    const out = exportShadowPreview(result, { projectId: 19, outputDir: dir });
    const written = JSON.parse(fs.readFileSync(out.jsonPath, "utf8"));
    expect(written.jsonDiagnostics.recovered).toBe(true);
    expect(written.jsonDiagnostics.position).toBe(42);
  });

  it("leaves jsonDiagnostics null when no chunk had a parse failure", () => {
    const payload = buildShadowPreviewPayload(makeResult("polished", makeRetainedDoc("內容。"), "polished"));
    expect(payload.jsonDiagnostics).toBeNull();
  });

  it("buildShadowPreviewHtml wraps the rendered retained document", () => {
    const doc = makeRetainedDoc("渲染後嘅內文。");
    const html = buildShadowPreviewHtml(doc, "polished", 19);
    expect(html).toContain(renderArticleDocument(doc).replace(/<!--[\s\S]*?-->/g, "").trim());
    expect(html).toContain("<!doctype html>");
  });

  it("defaults to the gitignored .tmp/shadow-previews directory", () => {
    expect(DEFAULT_SHADOW_PREVIEW_DIR).toContain(path.join(".tmp", "shadow-previews"));
  });

  it(".tmp is ignored by Git", () => {
    const gitignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("/.tmp/");
  });
});
