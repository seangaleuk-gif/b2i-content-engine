import fs from "fs";

const zh = fs.readFileSync("generated-blog-zh.html", "utf8");

// WP block imbalance
const openCounts = {};
const closeCounts = {};
for (const m of zh.matchAll(/<!--\s*wp:(\w+)[\s>]/gi)) {
  openCounts[m[1].toLowerCase()] = (openCounts[m[1].toLowerCase()] || 0) + 1;
}
for (const m of zh.matchAll(/<!--\s*\/wp:(\w+)\s*-->/gi)) {
  closeCounts[m[1].toLowerCase()] = (closeCounts[m[1].toLowerCase()] || 0) + 1;
}

console.log("=== WP BLOCK BALANCE ===");
const allTypes = new Set([...Object.keys(openCounts), ...Object.keys(closeCounts)]);
for (const t of allTypes) {
  const op = openCounts[t] || 0;
  const cl = closeCounts[t] || 0;
  if (op !== cl) {
    console.log(`  IMBALANCE: ${t} open=${op} close=${cl}`);
    
    // Find all openers of this type
    const openerRe = new RegExp(`<!--\\s*wp:${t}[\\s>]`, "gi");
    const openers = [...zh.matchAll(openerRe)];
    if (openers.length > 0) {
      const last = openers[openers.length - 1];
      console.log(`    Last open at ${last.index}: ${zh.substring(Math.max(0, last.index - 30), last.index + 120).replace(/\n/g, " ").substring(0, 150)}`);
    }
    const closerRe = new RegExp(`<!--\\s*/wp:${t}\\s*-->`, "gi");
    const closers = [...zh.matchAll(closerRe)];
    if (closers.length > 0) {
      const last = closers[closers.length - 1];
      console.log(`    Last close at ${last.index}: ${zh.substring(Math.max(0, last.index - 30), last.index + 120).replace(/\n/g, " ").substring(0, 150)}`);
    }
  }
}
console.log("  Total: open=" + Object.values(openCounts).reduce((a,b) => a+b, 0) + " close=" + Object.values(closeCounts).reduce((a,b) => a+b, 0));

// All H2 headings
console.log("\n=== ALL H2 HEADINGS ===");
const h2s = [...zh.matchAll(/<h2[^>]*>.*?<\/h2>/gi)];
for (const c of h2s) {
  const text = c[0].replace(/<[^>]+>/g, "").trim();
  console.log(`  H2 at ${c.index}: "${text.substring(0, 80)}"`);
}

// FAQ section content
const faqH2Idx = zh.search(/<h2[^>]*>.*?(?:常見|FAQ|問答|問題).*?<\/h2>/i);
if (faqH2Idx >= 0) {
  const faqH2End = zh.indexOf("</h2>", faqH2Idx) + 5;
  const ctaSignupIdx = zh.indexOf("app.b2ihub.com/signup");
  const nextBoundary = ctaSignupIdx >= 0 ? ctaSignupIdx : zh.length;
  const faqContent = zh.substring(faqH2End, Math.min(faqH2End + 2000, nextBoundary));
  console.log("\n=== FAQ SECTION CONTENT (first 2000 chars) ===");
  console.log(faqContent);
}

// CTA area
const signupIdx = zh.indexOf("app.b2ihub.com/signup");
if (signupIdx >= 0) {
  console.log("\n=== CTA AREA (500 chars around signup) ===");
  console.log(zh.substring(Math.max(0, signupIdx - 200), Math.min(zh.length, signupIdx + 300)));
}

// Malformed headings
const bareH2s = [...zh.matchAll(/<h2\b[^>]*>/gi)].map(m => m.index);
const wpHeadings = [...zh.matchAll(/<!--\s*wp:heading\s+\{[^}]*"level"\s*:\s*2[^}]*\}\s*-->/gi)].map(m => m.index);
console.log(`\n=== HEADING COUNT ===`);
console.log(`  Bare <h2>: ${bareH2s.length}`);
console.log(`  wp:heading level 2: ${wpHeadings.length}`);
console.log(`  Mismatch: ${Math.abs(bareH2s.length - wpHeadings.length)}`);

// Check for English in FAQ
const faqStrongs = [...zh.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)];
let engCount = 0;
for (const s of faqStrongs) {
  const text = s[1].replace(/<[^>]+>/g, "").trim();
  if (/^[A-Z][a-z]/.test(text)) engCount++;
}
console.log(`\n=== FAQ <strong> that start with English: ${engCount} / ${faqStrongs.length} ===`);
if (engCount > 0) {
  for (const s of faqStrongs.slice(0, 3)) {
    const text = s[1].replace(/<[^>]+>/g, "").trim();
    console.log(`  "${text.substring(0, 80)}"`);
  }
}
