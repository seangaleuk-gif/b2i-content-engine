import fs from "fs";

const html = fs.readFileSync("generated-blog.html", "utf8");

// Check internal links
const hrefRe = /<a\b[^>]*href="([^"]*)"[^>]*>/gi;
const links = [];
let m;
while ((m = hrefRe.exec(html)) !== null) {
  links.push({ href: m[1], text: m[0].replace(/<[^>]+>/g, "").trim().substring(0, 80) });
}

console.log("=== ALL LINKS ===");
for (const l of links) {
  const type = l.href.startsWith("/blog/") ? "INTERNAL" : l.href.startsWith("http") ? "EXTERNAL" : "OTHER";
  console.log(`  [${type}] ${l.href.substring(0, 80)} → "${l.text}"`);
}

// Check for duplicate internal destinations
const internalDests = links.filter((l) => l.href.startsWith("/blog/")).map((l) => l.href);
const uniqueInternal = new Set(internalDests);
console.log(`\n=== INTERNAL LINKS ===`);
console.log(`Total: ${internalDests.length}, Unique: ${uniqueInternal.size}`);
if (internalDests.length !== uniqueInternal.size) {
  for (const dest of uniqueInternal) {
    const count = internalDests.filter((d) => d === dest).length;
    if (count > 1) console.log(`  DUPLICATE: ${dest} (${count}x)`);
  }
}

// Check external source links preserved
const externalLinks = links.filter((l) => l.href.startsWith("http") && !l.href.includes("b2ihub.com"));
console.log(`\n=== EXTERNAL LINKS (${externalLinks.length}) ===`);
for (const l of externalLinks) {
  console.log(`  ${l.href.substring(0, 90)}`);
}

// Check for unsupported claims/numbers
const bodyText = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const claimPatterns = [
  /\d{1,3}%\s+(?:of|increase|decrease|growth|drop|rise|fall|more|less)/gi,
  /(?:increased|decreased|grew|fell|rose|dropped|doubled|tripled)\s+by\s+\d/gi,
  /(?:sales|revenue|conversion)\s+(?:rose|increased|doubled|fell|dropped)/gi,
  /\d+\s*(?:percent|per cent)\s+(?:of|increase|more|growth)/gi,
  /(?:reach|grow|shrink)\s+(?:over|by|to)\s+\d+/gi,
];

console.log(`\n=== UNSOLICITED CLAIM CHECK ===`);
let totalClaims = 0;
for (const p of claimPatterns) {
  const found = bodyText.match(p);
  if (found) {
    for (const f of found) {
      console.log(`  ⚠️  "${f}"`);
      totalClaims++;
    }
  }
}
if (totalClaims === 0) {
  console.log("  ✅ No suspicious numeric claims found");
}
