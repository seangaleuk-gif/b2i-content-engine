import fs from "fs";

const html = fs.readFileSync("generated-blog.html", "utf8");

// Search for claim contexts
for (const term of ["300%", "increased by 3", "bakery", "told us", "follower said"]) {
  const idx = html.indexOf(term);
  if (idx >= 0) {
    console.log(`=== "${term}" ===`);
    console.log(html.substring(Math.max(0, idx - 100), idx + 150));
    console.log();
  }
}

// Count all percentage claims
const pctRe = /\d{1,3}%/g;
const pcts = html.match(pctRe) || [];
console.log("=== ALL PERCENTAGE CLAIMS ===");
for (const p of new Set(pcts)) {
  const idx = html.indexOf(p);
  console.log(` "${p}" at ${idx}: "${html.substring(Math.max(0, idx - 40), idx + 60).trim()}"`);
}
