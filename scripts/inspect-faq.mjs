import fs from "fs";

const en = fs.readFileSync("generated-blog.html", "utf8");
const zh = fs.readFileSync("generated-blog-zh.html", "utf8");

// EN FAQ schema
const enSchemaMatch = en.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (enSchemaMatch) {
  const schema = JSON.parse(enSchemaMatch[1]);
  console.log("=== EN FAQ SCHEMA ===");
  console.log("Entries:", schema.mainEntity.length);
  for (let i = 0; i < schema.mainEntity.length; i++) {
    const e = schema.mainEntity[i];
    console.log(`  Q${i + 1}: ${e.name.substring(0, 80)}`);
    console.log(`    A: ${e.acceptedAnswer.text.substring(0, 100)}`);
  }
}

// ZH FAQ schema
const zhSchemaMatch = zh.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (zhSchemaMatch) {
  const schema = JSON.parse(zhSchemaMatch[1]);
  console.log("\n=== ZH FAQ SCHEMA ===");
  console.log("Entries:", schema.mainEntity.length);
  for (let i = 0; i < schema.mainEntity.length; i++) {
    const e = schema.mainEntity[i];
    const isEng = /^[A-Z]/.test(e.name);
    console.log(`  Q${i + 1} [${isEng ? "EN" : "ZH"}]: ${e.name.substring(0, 80)}`);
    console.log(`    A: ${e.acceptedAnswer.text.substring(0, 100)}`);
  }
}

// ZH visible FAQ (strong elements ending with ?)
const visibleQs = [...zh.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)];
console.log("\n=== ZH VISIBLE FAQ STRONG ELEMENTS ===");
for (const v of visibleQs) {
  const text = v[1].replace(/<[^>]+>/g, "").trim();
  const isQ = text.endsWith("?") || text.endsWith("？");
  const isEng = /^[A-Z]/.test(text);
  console.log(`  [${isQ ? "Q" : "NOT-Q"}][${isEng ? "EN" : "ZH"}]: "${text.substring(0, 80)}"`);
}

// Count keyphrase in ZH
const kp = "threads marketing hong kong";
const kpCount = (zh.match(new RegExp(kp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
console.log(`\n=== Keyphrase "${kp}" in ZH: ${kpCount} occurrences ===`);

// Extract internal links from EN
const extractInternal = (html) => {
  const links = [];
  const re = /<a\b[^>]*href="(\/blog\/[^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return [...new Set(links)];
};
const enInternal = extractInternal(en);
const zhInternal = extractInternal(zh);
console.log(`\n=== INTERNAL LINKS ===`);
console.log(`EN: ${enInternal.length} unique: ${enInternal.join(", ")}`);
console.log(`ZH: ${zhInternal.length} unique: ${zhInternal.join(", ")}`);
