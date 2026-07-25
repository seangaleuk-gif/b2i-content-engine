#!/usr/bin/env node
import fs from "fs";
import { createClient } from "@supabase/supabase-js";

// ── Configuration ──
const SUPABASE_URL = "https://jwpnlylwhioteyaydbnl.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3cG5seWx3aGlvdGV5YXlkYm5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxOTYzMDIsImV4cCI6MjA5OTc3MjMwMn0.IWdAnUGsEdeNokNUXFO79yXcUjEFTSa5gsuSa6f-BSw";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3cG5seWx3aGlvdGV5YXlkYm5sIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDE5NjMwMiwiZXhwIjoyMDk5NzcyMzAyfQ.mJKd_cKc74GZiFoI6TEB0Z0-4Ta6aL9kk8emXb9JaFQ";
const ADMIN_USER_ID = "5f399e6e-3a7a-4823-aa80-b265d45eb9a8";
const ADMIN_EMAIL = "admin@b2i.com";
const API_BASE = "http://localhost:3000";
const TOPIC = process.argv[2] || "threads marketing hong kong";

const supabase = createClient(SUPABASE_URL, ANON_KEY);

async function signIn() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: "TestGeneration123!",
  });
  if (error) throw new Error(`Sign-in failed: ${error.message}`);
  return data.session.access_token;
}

async function getOrCreateProject() {
  const projectName = `TEST: ${TOPIC}`;
  const { data: projects } = await supabase
    .from("projects")
    .select("*")
    .eq("user_id", ADMIN_USER_ID)
    .eq("name", projectName);

  if (projects && projects.length > 0) {
    console.log(`📋 Using existing project #${projects[0].id}`);
    return projects[0];
  }

  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      user_id: ADMIN_USER_ID,
      name: projectName,
      keyword: "Threads marketing Hong Kong",
      audience: "Hong Kong marketers and business owners",
      country: "HK",
      word_count: 1500,
      status: "draft",
      content: "",
    })
    .select()
    .single();

  if (error) throw new Error(`Create project: ${error.message}`);
  console.log(`✅ Created project #${project.id}`);
  return project;
}

async function ensureResearch(projectId) {
  const { data: existing } = await supabase
    .from("research_sources")
    .select("id")
    .eq("project_id", projectId);

  if (existing && existing.length > 0) {
    console.log(`📚 ${existing.length} research sources exist`);
    return;
  }

  const items = [
    {
      project_id: projectId, category: "web", position: 0,
      title: "Threads Marketing Guide 2026 - Social Media Today",
      url: "https://www.socialmediatoday.com/news/threads-instagram-marketers-guide-2026/",
      snippet: "Threads has grown to over 300 million monthly active users. Marketers use it for brand building.",
    },
    {
      project_id: projectId, category: "news", position: 1,
      title: "Threads Advertising Hong Kong Launch - Marketing Interactive",
      url: "https://www.marketing-interactive.com/threads-advertising-hong-kong-launch",
      snippet: "Meta expanded Threads advertising to Hong Kong, offering local brands new opportunities.",
    },
    {
      project_id: projectId, category: "web", position: 2,
      title: "Hong Kong Social Media Statistics 2026 - DataReportal",
      url: "https://datareportal.com/reports/hong-kong-social-media-2026",
      snippet: "Hong Kong has 6.8 million social media users. Threads adoption grew 45% in Q1 2026.",
    },
  ];

  const { error } = await supabase.from("research_sources").insert(items);
  if (error) console.log(`⚠️ Research error: ${error.message}`);
  else console.log(`📚 Added ${items.length} research sources`);
}

function analyzeArticle(data) {
  const blog = data.blog || "";
  const results = { passed: true, checks: [] };

  // 1. Response status
  const hasSuccess = data.success === true;
  results.checks.push({ name: "API success", ok: hasSuccess, detail: `status=${data.success}` });

  // 2. Title
  const title = data.title || "";
  results.checks.push({ name: "Title exists", ok: title.length > 0, detail: `"${title}"` });

  // 3. Blog HTML present
  results.checks.push({ name: "Blog HTML", ok: blog.length > 100, detail: `${blog.length} chars` });

  // 4. Structural integrity
  const wpOpen = (blog.match(/<!--\s*wp:\w+/gi) || []).length;
  const wpClose = (blog.match(/<!--\s*\/wp:\w+/gi) || []).length;
  const wpBalanced = wpOpen === wpClose;
  results.checks.push({ name: "WP blocks balanced", ok: wpBalanced, detail: `open=${wpOpen} close=${wpClose}` });

  // 5. Language switcher
  const hasSwitcher = /b2i-language-switcher/i.test(blog);
  results.checks.push({ name: "Language switcher", ok: hasSwitcher });

  // 6. CTA
  const hasCta = /app\.b2ihub\.com\/signup/i.test(blog);
  results.checks.push({ name: "CTA signup URL", ok: hasCta });

  // 7. FAQ schema
  const hasFaqSchema = /FAQPage/i.test(blog);
  results.checks.push({ name: "FAQPage schema", ok: hasFaqSchema });

  // 8. JSON-LD
  const hasJsonLd = /application\/ld\+json/i.test(blog);
  results.checks.push({ name: "JSON-LD script", ok: hasJsonLd });

  // 9. Visible FAQ H2
  const hasFaqH2 = /<h2[^>]*>.*?(?:Frequently Asked|FAQ|FAQs|Common Questions).*?<\/h2>/i.test(blog);
  results.checks.push({ name: "FAQ H2 heading", ok: hasFaqH2 });

  // 10. Content order (FAQ section before FAQ schema)
  const faqSectionIdx = blog.search(/<h2[^>]*>.*?(?:Frequently Asked|FAQ|FAQs).*?<\/h2>/i);
  const faqSchemaIdx = blog.indexOf("FAQPage");
  if (faqSectionIdx >= 0 && faqSchemaIdx >= 0) {
    results.checks.push({ name: "FAQ before schema", ok: faqSectionIdx < faqSchemaIdx,
      detail: `section@${faqSectionIdx} schema@${faqSchemaIdx}` });
  }

  // 11. Nested paragraphs
  const structHtml = blog
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--\s*wp:html\s*-->[\s\S]*?<!--\s*\/wp:html\s*-->/gi, "");
  const pOpens = [...structHtml.matchAll(/<p\b[^>]*>/gi)].map(m => m.index);
  const pCloses = [...structHtml.matchAll(/<\/p>/gi)].map(m => m.index + 4);
  let nested = 0;
  for (let i = 0; i < pOpens.length - 1; i++) {
    const hasClose = pCloses.some(cp => cp > pOpens[i] && cp < pOpens[i + 1]);
    if (!hasClose) nested++;
  }
  results.checks.push({ name: "No nested paragraphs", ok: nested === 0, detail: nested > 0 ? `${nested} found` : "ok" });

  // 12. Malformed headings
  const bareH2 = (structHtml.match(/<h2[^>]*>/gi) || []).length;
  const headingOpeners = (blog.match(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi) || []).length;
  const malformedHeadings = Math.abs(bareH2 - headingOpeners);
  results.checks.push({ name: "No malformed headings", ok: malformedHeadings === 0, detail: malformedHeadings > 0 ? `${malformedHeadings} mismatch` : "ok" });

  // 13. Word count
  const bodyText = blog.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  results.wordCount = data.wordCount || wordCount;
  results.checks.push({ name: "Word count check", ok: wordCount >= 200, detail: `${wordCount} words` });

  // 14. Keyphrase density
  const kp = "threads marketing hong kong".toLowerCase();
  const kpWords = kp.split(/\s+/).length;
  const kpCount = (bodyText.toLowerCase().match(new RegExp(kp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
  const density = wordCount > 0 ? (kpCount * kpWords / wordCount) * 100 : 0;
  results.checks.push({ name: "Keyphrase density <3%", ok: density < 3, detail: `${kpCount} occ, ${density.toFixed(2)}%` });

  // Overall
  const failed = results.checks.filter(c => !c.ok);
  results.passed = failed.length === 0;
  results.failedChecks = failed;

  return results;
}

async function callGeneration(token, projectId) {
  console.log(`\n🚀 Generating blog for project #${projectId}...`);
  const start = Date.now();

  const resp = await fetch(`${API_BASE}/api/generate-blog`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `sb-jwpnlylwhioteyaydbnl-auth-token=${token}`,
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ projectId }),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`⏱️  ${elapsed}s, status ${resp.status}`);

  const data = await resp.json();

  if (!resp.ok) {
    console.error("❌ Generation failed:");
    console.error(JSON.stringify(data, null, 2));
    return { status: resp.status, error: data, data };
  }

  return { status: resp.status, data };
}

async function main() {
  try {
    const token = await signIn();
    console.log(`🔑 Authenticated (token: ${token.substring(0, 16)}...)`);

    const project = await getOrCreateProject();
    await ensureResearch(project.id);

    const result = await callGeneration(token, project.id);

    if (result.data) {
      console.log("\n" + "=".repeat(60));
      console.log("📊 GENERATION ANALYSIS");
      console.log("=".repeat(60));
      const analysis = analyzeArticle(result.data);
      console.log(`\n📝 Title: "${result.data.title}"`);
      console.log(`📐 Word count: ${analysis.wordCount}`);

      for (const check of analysis.checks) {
        const icon = check.ok ? "✅" : "❌";
        console.log(`  ${icon} ${check.name}: ${check.detail || ""}`);
      }

      if (analysis.failedChecks.length > 0) {
        console.log(`\n⚠️  ${analysis.failedChecks.length} check(s) FAILED:`);
        for (const f of analysis.failedChecks) {
          console.log(`   ❌ ${f.name}: ${f.detail}`);
        }
      } else {
        console.log(`\n✅ ALL CHECKS PASSED`);
      }

      // Save blog to file for inspection
      if (result.data.blog) {
        fs.writeFileSync("generated-blog.html", result.data.blog);
        console.log(`\n💾 Blog saved to generated-blog.html`);
      }
    }
  } catch (err) {
    console.error("FATAL:", err);
    process.exit(1);
  }
}

main();
