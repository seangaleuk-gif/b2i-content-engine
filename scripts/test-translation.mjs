#!/usr/bin/env node
import fs from "fs";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env.local") });

// ── Secrets from environment ──
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = process.env.B2I_TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.B2I_TEST_ADMIN_PASSWORD;
const API_BASE = process.env.API_BASE || "http://localhost:3000";
const PROJECT_ID = parseInt(process.argv[2] || "16");

if (!SUPABASE_URL) { console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL not set"); process.exit(1); }
if (!ANON_KEY) { console.error("FATAL: NEXT_PUBLIC_SUPABASE_ANON_KEY not set"); process.exit(1); }
if (!SERVICE_KEY) { console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY not set"); process.exit(1); }
if (!ADMIN_EMAIL) { console.error("FATAL: B2I_TEST_ADMIN_EMAIL not set"); process.exit(1); }
if (!ADMIN_PASSWORD) { console.error("FATAL: B2I_TEST_ADMIN_PASSWORD not set"); process.exit(1); }

const adminHeaders = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function adminQuery(table, searchParams) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${searchParams}`;
  const resp = await fetch(url, { headers: adminHeaders });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase query failed (${resp.status}): ${err.substring(0, 500)}`);
  }
  return resp.json();
}

async function signIn() {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "apikey": ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Sign-in failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Helpers ──

function visibleBodyText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHrefs(html) {
  const hrefs = [];
  const re = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

// ── Fix 1: Smart brand check ──
const ALL_BRANDS = ["B2I Hub", "Threads", "Instagram", "Facebook", "Meta", "Google"];
function checkBrands(enText, zhText) {
  const brandsInSource = ALL_BRANDS.filter((b) => {
    const re = new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return re.test(enText);
  });
  const missing = brandsInSource.filter((b) => {
    const re = new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return !re.test(zhText);
  });
  return { brandsInSource, missing };
}

// ── Fix 2: Heading check excluding protected blocks ──
function editorialHeadings(html) {
  // Strip wp:html blocks (CTA, switcher, schema), scripts, JSON-LD
  const cleaned = html
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->/gi, "")
    .replace(/<!--\s*\/wp:html\s*-->/gi, "");
  const bareH2s = (cleaned.match(/<h2[^>]*>/gi) || []).length;
  const wpHeading2 = (cleaned.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) || []).length;
  return { bareH2s, wpHeading2, mismatch: Math.abs(bareH2s - wpHeading2) };
}

// ── Unit-aware number extraction and comparison ──

function extractScaledNumbers(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const results = [];
  const re = /(?:HK?\$|US?\$)?\d+(?:,\d{3})*(?:\.\d+)?[%％]?/gi;
  let m;

  while ((m = re.exec(body)) !== null) {
    const match = m[0];
    const isPercent = /[%％]/.test(match);
    const cleanMatch = match.replace(/,/g, "").replace(/[%％]/g, "").replace(/^[A-Za-z]+\$/, "");
    const numPart = parseFloat(cleanMatch);
    const after = body.substring(m.index + match.length, m.index + match.length + 16).toLowerCase();

    let scale = 1;
    let hasScale = false;

    const engWord = after.match(/^\s*(thousand|million|billion|trillion)\b/);
    if (engWord) {
      const w = engWord[1];
      if (w === "thousand") { scale = 1000; hasScale = true; }
      else if (w === "million") { scale = 1000000; hasScale = true; }
      else if (w === "billion") { scale = 1000000000; hasScale = true; }
    }

    const zhChar = after.match(/^\s*(千|萬|億)\s*/);
    if (zhChar) {
      const ch = zhChar[1];
      if (ch === "千") { scale = 1000; hasScale = true; }
      else if (ch === "萬") { scale = 10000; hasScale = true; }
      else if (ch === "億") { scale = 100000000; hasScale = true; }
    }

    const hasHkdSuffix = !!after.match(/^\s*(?:[千萬億]\s*)?港元的?/);
    const hasHkdPrefix = /^HK?\$/.test(match);
    const hasUsdPrefix = /^US?\$/.test(match) && !hasHkdPrefix;

    const scaledValue = isPercent
      ? `%:${numPart}`
      : hasScale
        ? `${hasHkdPrefix || hasHkdSuffix ? "HKD:" : hasUsdPrefix ? "USD:" : ""}${Math.round(numPart * scale)}`
        : hasHkdPrefix || hasHkdSuffix
          ? `HKD:${numPart}`
          : /^\d+$/.test(String(numPart)) ? String(numPart) : String(numPart).replace(/\.0$/, "");

    results.push({ raw: match, scaled: scaledValue });
  }

  return results;
}

function countBasedNumberCheck(enHtml, zhHtml) {
  const srcNums = extractScaledNumbers(enHtml).map((n) => n.scaled);
  const tgtNums = extractScaledNumbers(zhHtml).map((n) => n.scaled);
  const srcCounts = {};
  const tgtCounts = {};
  for (const n of srcNums) srcCounts[n] = (srcCounts[n] || 0) + 1;
  for (const n of tgtNums) tgtCounts[n] = (tgtCounts[n] || 0) + 1;
  const lost = [];
  const extras = [];
  for (const [n, c] of Object.entries(srcCounts)) {
    const tc = tgtCounts[n] || 0;
    if (tc < c) lost.push(...Array(c - tc).fill(n));
  }
  for (const [n, c] of Object.entries(tgtCounts)) {
    const sc = srcCounts[n] || 0;
    if (sc < c) extras.push(...Array(c - sc).fill(n));
  }
  return { lost, extras, srcTotal: srcNums.length, tgtTotal: tgtNums.length };
}

// ── Main analysis ──

function analyzeTranslation(enHtml, zhHtml, enTitle, zhTitle, zhMeta) {
  const results = { passed: true, checks: [], warnings: [] };

  results.checks.push({ name: "Translation saved", ok: !!zhHtml, detail: zhHtml ? `${zhHtml.length} chars` : "missing" });

  // WP blocks balanced
  const zhOpen = (zhHtml.match(/<!--\s*wp:\w+/gi) || []).length;
  const zhClose = (zhHtml.match(/<!--\s*\/wp:\w+/gi) || []).length;
  results.checks.push({ name: "WP blocks balanced (ZH)", ok: zhOpen === zhClose, detail: `open=${zhOpen} close=${zhClose}` });

  // Language switcher
  results.checks.push({ name: "Language switcher (ZH)", ok: /b2i-language-switcher/i.test(zhHtml) });

  // CTA signup
  results.checks.push({ name: "CTA signup (ZH)", ok: /app\.b2ihub\.com\/signup/i.test(zhHtml) });

  // Title
  results.checks.push({ name: "Title contains Chinese", ok: /[\u4e00-\u9fff]/.test(zhTitle || ""), detail: (zhTitle || "").substring(0, 80) });

  // Meta
  results.checks.push({ name: "ZH meta description exists", ok: !!(zhMeta && zhMeta.length > 20), detail: (zhMeta || "").substring(0, 80) });

  // Traditional Chinese dominant
  const pureSimplifiedRe = /[为会们当开与无后时现经对从动长问学发种变体过实里东关义]/g;
  const pureTraditionalRe = /[為會們當開與無後時現經驗從動長問學發種體過實裡東關義]/g;
  const simplifiedOnly = (zhHtml.match(pureSimplifiedRe) || []).length;
  const traditionalOnly = (zhHtml.match(pureTraditionalRe) || []).length;
  const scRatio = (simplifiedOnly + traditionalOnly) > 0 ? (simplifiedOnly / (simplifiedOnly + traditionalOnly)) * 100 : 0;
  results.checks.push({
    name: "Traditional Chinese dominant",
    ok: simplifiedOnly === 0 || traditionalOnly >= simplifiedOnly * 20,
    detail: `TR=${traditionalOnly} SC=${simplifiedOnly} (${scRatio.toFixed(1)}% simplified)`
  });

  // English leakage
  const zhBodyText = visibleBodyText(zhHtml);
  const engWordRuns = zhBodyText.match(/\b([A-Za-z]{2,}\s+){4,}[A-Za-z]{2,}\b/g) || [];
  results.checks.push({
    name: "No untranslated EN paragraphs",
    ok: engWordRuns.length === 0,
    detail: engWordRuns.length > 0 ? `${engWordRuns.length} EN runs: "${engWordRuns[0]?.substring(0, 60)}..."` : "ok"
  });

  // External links
  const enHrefs = extractHrefs(enHtml);
  const zhHrefs = extractHrefs(zhHtml);
  const enExternal = enHrefs.filter((h) => h.startsWith("http") && !h.includes("b2ihub.com"));
  const zhExternal = zhHrefs.filter((h) => h.startsWith("http") && !h.includes("b2ihub.com"));
  results.checks.push({
    name: "External links preserved",
    ok: zhExternal.length >= Math.max(0, enExternal.length - 2),
    detail: `EN=${enExternal.length} ZH=${zhExternal.length}`
  });

  // FAQ schema
  results.checks.push({ name: "FAQPage schema (ZH)", ok: /FAQPage/i.test(zhHtml) });

  // Nested paragraphs
  const zhStruct = zhHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const zhPOpens = [...zhStruct.matchAll(/<p\b[^>]*>/gi)].map((m) => m.index);
  const zhPCloses = [...zhStruct.matchAll(/<\/p>/gi)].map((m) => m.index + 4);
  let zhNested = 0;
  for (let i = 0; i < zhPOpens.length - 1; i++) {
    if (!zhPCloses.some((cp) => cp > zhPOpens[i] && cp < zhPOpens[i + 1])) zhNested++;
  }
  results.checks.push({ name: "No nested paragraphs (ZH)", ok: zhNested === 0, detail: zhNested > 0 ? `${zhNested} nested` : "ok" });

  // ── Fix 4: Component-level number check ──
  const numCheck = countBasedNumberCheck(enHtml, zhHtml);
  const numOk = numCheck.lost.length === 0;
  const numDetail = numOk
    ? `EN=${numCheck.srcTotal} ZH=${numCheck.tgtTotal} — all preserved`
    : `EN=${numCheck.srcTotal} ZH=${numCheck.tgtTotal} — LOST: ${numCheck.lost.join(", ")}` + (numCheck.extras.length > 0 ? ` EXTRA: ${numCheck.extras.join(", ")}` : "");
  results.checks.push({ name: "Numbers preserved (exact)", ok: numOk, detail: numDetail });

  // FAQ heading
  const hasFaqH2Zh = /<h2[^>]*>.*?(?:常見|FAQ|問答|問題).*?<\/h2>/i.test(zhHtml);
  results.checks.push({ name: "FAQ heading (ZH)", ok: hasFaqH2Zh, detail: hasFaqH2Zh ? "found" : "missing" });

  // Component order
  const lsIdx = zhHtml.indexOf("b2i-language-switcher");
  const firstP = zhHtml.search(/<p\b[^>]*>/);
  const faqH2Idx = zhHtml.search(/<h2[^>]*>.*?(?:常見|FAQ|問答|問題).*?<\/h2>/i);
  const signupIdx = zhHtml.indexOf("app.b2ihub.com/signup");
  const schemaIdx = zhHtml.indexOf("FAQPage");
  const orderOk = [lsIdx, firstP, faqH2Idx, signupIdx, schemaIdx].every((i) => i >= 0)
    && lsIdx < firstP && faqH2Idx < signupIdx && signupIdx < schemaIdx;
  results.checks.push({
    name: "Component order (ZH)",
    ok: orderOk,
    detail: `LS@${lsIdx} P@${firstP} FAQ@${faqH2Idx} CTA@${signupIdx} SC@${schemaIdx}`
  });

  // CTA heading count
  const ctaHeadings = (zhHtml.match(/<h2[^>]*>[\s\S]*?(?:Ready to|Start your|Create your|Get started|Sign up|B2I Hub connects|準備好|建立(?:免費)?檔案|立即(?:開始|加入|註冊)|馬上|開始(?:合作|使用)|註冊|免費[^<]{0,10}(?:檔案|帳戶)).*?<\/h2>/gi) || []).length;
  results.checks.push({ name: "CTA heading = 1", ok: ctaHeadings === 1, detail: `${ctaHeadings}` });

  // ── Fix 1: Smart brand check ──
  const enVisibleText = visibleBodyText(enHtml);
  const brandCheck = checkBrands(enVisibleText, zhBodyText);
  results.checks.push({
    name: "Brand names preserved",
    ok: brandCheck.missing.length === 0,
    detail: brandCheck.missing.length > 0
      ? `Missing from ZH: ${brandCheck.missing.join(", ")} (source had: ${brandCheck.brandsInSource.join(", ")})`
      : `${brandCheck.brandsInSource.join(", ")} — all present`
  });

  // WP block type preservation
  const enWpBlocks = new Set(enHtml.match(/<!--\s*wp:(\w+)/gi)?.map(b => b.toLowerCase()) || []);
  const zhWpBlocks = new Set(zhHtml.match(/<!--\s*wp:(\w+)/gi)?.map(b => b.toLowerCase()) || []);
  const enBlockCount = enWpBlocks.size;
  const lostBlocks = [...enWpBlocks].filter(b => !zhWpBlocks.has(b)).length;
  results.checks.push({
    name: "WP block types not lost",
    ok: lostBlocks <= 1,
    detail: lostBlocks > 0 ? `Lost: ${[...enWpBlocks].filter(b => !zhWpBlocks.has(b)).join(", ")}` : `EN=${enBlockCount} types preserved`
  });

  // ── Fix 2: Heading check excluding protected blocks ──
  const hCheck = editorialHeadings(zhHtml);
  results.checks.push({
    name: "No malformed editorial headings",
    ok: hCheck.mismatch === 0,
    detail: hCheck.mismatch > 0
      ? `mismatch=${hCheck.mismatch} (bare H2=${hCheck.bareH2s} wp:heading=${hCheck.wpHeading2}, after excluding wp:html/script blocks)`
      : "ok"
  });

  const failed = results.checks.filter((c) => !c.ok);
  results.passed = failed.length === 0;
  results.failedChecks = failed;

  return results;
}

async function callTranslation(token, projectId) {
  console.log(`\n🌐 Translating project #${projectId}...`);
  const start = Date.now();

  const resp = await fetch(`${API_BASE}/api/projects/${projectId}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `sb-jwpnlylwhioteyaydbnl-auth-token=${token}`,
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`⏱️  ${elapsed}s, status ${resp.status}`);

  let data;
  try { data = await resp.json(); } catch { data = await resp.text(); }

  if (!resp.ok) {
    console.error("❌ Translation failed:");
    console.error(typeof data === "string" ? data.substring(0, 1000) : JSON.stringify(data, null, 2));
    return { status: resp.status, error: data };
  }

  return { status: resp.status, data };
}

async function main() {
  try {
    const token = await signIn();
    console.log(`🔑 Authenticated`);

    const versions = await adminQuery("blog_versions",
      `project_id=eq.${PROJECT_ID}&order=version_number.desc&limit=10`);

    const enVersion = (versions || []).find((v) => !v.slug?.endsWith("-zh") && v.blog?.length > 100);
    if (!enVersion) {
      console.error("❌ No valid English version found for project #" + PROJECT_ID);
      process.exit(1);
    }

    console.log(`📄 EN: v${enVersion.version_number} "${enVersion.title}" (${enVersion.word_count} words, ${enVersion.blog.length} chars)`);
    fs.writeFileSync("generated-blog.html", enVersion.blog);
    console.log("💾 English -> generated-blog.html");

    const result = await callTranslation(token, PROJECT_ID);

    if (result.data && result.status === 201) {
      console.log("\n" + "=".repeat(60));
      console.log("📊 TRANSLATION ANALYSIS");
      console.log("=".repeat(60));

      const afterVersions = await adminQuery("blog_versions",
        `project_id=eq.${PROJECT_ID}&order=version_number.desc&limit=10`);

      const zhVersion = (afterVersions || []).find((v) => v.slug?.endsWith("-zh") && v.blog?.length > 100);

      if (zhVersion) {
        // ── Fix 3: Chinese-aware length label ──
        console.log(`\n📝 ZH Title: "${zhVersion.title}"`);
        console.log(`🔗 ZH Slug: ${zhVersion.slug}`);
        if (zhVersion.slug?.endsWith("-zh")) {
          console.log(`📐 ZH Chinese characters: ${zhVersion.word_count}`);
          if (zhVersion.reading_time) console.log(`⏱️  ZH Reading time: ${zhVersion.reading_time}`);
        } else {
          console.log(`📐 ZH Word count: ${zhVersion.word_count}`);
        }
        console.log(`📝 ZH Meta: "${zhVersion.meta_description || ""}"`);

        const analysis = analyzeTranslation(
          enVersion.blog, zhVersion.blog, enVersion.title,
          zhVersion.title, zhVersion.meta_description || ""
        );

        for (const check of analysis.checks) {
          const icon = check.ok ? "✅" : "❌";
          console.log(`  ${icon} ${check.name}: ${check.detail || ""}`);
        }

        if (analysis.failedChecks.length > 0) {
          console.log(`\n⚠️  ${analysis.failedChecks.length} FAILED:`);
          for (const f of analysis.failedChecks) {
            console.log(`   ❌ ${f.name}: ${f.detail}`);
          }
        }

        fs.writeFileSync("generated-blog-zh.html", zhVersion.blog);
        console.log(`\n💾 ZH blog -> generated-blog-zh.html`);
        console.log(`\n🏁 ${analysis.passed ? "✅ ALL CHECKS PASSED" : "❌ FAILURES FOUND"}`);
      } else {
        console.error("❌ Could not find saved ZH version");
      }
    } else {
      console.error("❌ Translation API returned", result.status);
    }
  } catch (err) {
    console.error("FATAL:", err);
    process.exit(1);
  }
}

main();
