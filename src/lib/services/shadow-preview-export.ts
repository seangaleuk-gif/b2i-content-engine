// ── Development-only shadow preview export ──
//
// Serializes the completed document-context shadow preview to local diagnostic
// files under `.tmp/shadow-previews/` so the actual polished (or partial /
// pre-editorial) shadow document can be reviewed manually. This is strictly a
// developer aid:
//   - local filesystem only;
//   - never written to the database or any blog version;
//   - never touches production zhDoc, the save payload, validation or publishing;
//   - a failure here logs a warning and never rejects the translation or the
//     shadow result.
//
// The article content is written to the local files, but is never logged.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArticleDocument } from "@/lib/blog/article-document";
import { renderArticleDocument } from "@/lib/blog/article-document";
import { buildShadowPreviewPayload } from "./document-context-shadow-preview";

/** Default (gitignored) export directory for shadow previews. */
export const DEFAULT_SHADOW_PREVIEW_DIR = path.join(process.cwd(), ".tmp", "shadow-previews");

export interface ShadowPreviewExportTarget {
  /** Project whose article produced this shadow preview. */
  projectId: number;
  /** Override the export directory (used by tests). Defaults to `.tmp/shadow-previews`. */
  outputDir?: string;
}

export interface ShadowPreviewExportResult {
  jsonPath: string;
  htmlPath: string;
  exported: boolean;
}

/** Strip WordPress comment markers so the review HTML is clean and readable. */
function cleanArticleHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Build a readable review HTML page containing the retained shadow document. */
export function buildShadowPreviewHtml(
  doc: ArticleDocument | null,
  retainedSource: string,
  projectId: number,
): string {
  const body = doc ? cleanArticleHtml(renderArticleDocument(doc)) : "<p>No retained document.</p>";
  return [
    "<!doctype html>",
    '<html lang="zh-Hant">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>B2I Shadow Preview — project ${projectId} (${retainedSource})</title>`,
    "<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.7;color:#1f2937}article{font-size:17px}article p{margin:1rem 0}article h2,article h3{line-height:1.3}</style>",
    "</head>",
    "<body>",
    `<h1>B2I Shadow Preview</h1>`,
    `<p><strong>Project:</strong> ${projectId} &middot; <strong>Retained source:</strong> <code>${retainedSource}</code></p>`,
    "<article>",
    body,
    "</article>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Write the shadow preview JSON + readable HTML to the export directory.
 * `result` is the completed `DocumentContextTranslationShadowResult`.
 */
export function exportShadowPreview(
  result: Parameters<typeof buildShadowPreviewPayload>[0],
  target: ShadowPreviewExportTarget,
): ShadowPreviewExportResult {
  const dir = target.outputDir ?? DEFAULT_SHADOW_PREVIEW_DIR;
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const base = `project-${target.projectId}-${ts}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const htmlPath = path.join(dir, `${base}.html`);

  const retainedDoc = result.preview.retainedDoc;
  const html = buildShadowPreviewHtml(retainedDoc, result.preview.retainedSource, target.projectId);

  const payload = buildShadowPreviewPayload(result);
  const json = {
    ...payload,
    projectId: target.projectId,
    createdAt: now.toISOString(),
    outputHtmlPath: htmlPath,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  fs.writeFileSync(htmlPath, html, "utf8");

  return { jsonPath, htmlPath, exported: true };
}
