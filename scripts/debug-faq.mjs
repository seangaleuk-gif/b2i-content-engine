import fs from "fs";

const h = fs.readFileSync("generated-blog.html", "utf8");

// Find FAQ H2
const faqH2 = /<h2[^>]*>.*?Frequently Asked.*?<\/h2>/i.exec(h);
if (!faqH2) { console.log("No FAQ H2 found"); process.exit(0); }

const faqStart = faqH2.index + faqH2[0].length;
const faqPageIdx = h.indexOf("FAQPage", faqStart);

// FAQ section: between H2 end and FAQPage
const faqSection = h.substring(faqStart, faqPageIdx > 0 ? faqPageIdx : h.length);
console.log("FAQ section length:", faqSection.length);

// Find all <strong> elements in FAQ section
const strongRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>/gi;
let m;
let count = 0;
while ((m = strongRe.exec(faqSection)) !== null) {
  const text = m[1].replace(/<[^>]+>/g, " ").trim();
  count++;
  console.log(`  Q${count}: "${text.substring(0, 60)}" endsWith?=${text.endsWith("?")}`);
}

console.log("\nTotal <strong> ends with ?:", 
  [...faqSection.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)]
    .filter((m2) => m2[1].replace(/<[^>]+>/g, " ").trim().endsWith("?")).length
);
