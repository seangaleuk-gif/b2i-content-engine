import fs from "fs";

const h = fs.readFileSync("generated-blog.html", "utf8");

// Find component positions (all use first occurrence)
const ls = h.indexOf("b2i-language-switcher");
const intro = h.indexOf("<!-- wp:paragraph -->") >= 0 ? h.indexOf("<!-- wp:paragraph -->") : h.indexOf("<p>");
const firstH2 = h.search(/<h2\b[^>]*>/);
const faqH2 = h.search(/<h2[^>]*>.*?(?:Frequently Asked|FAQ|Common Questions).*?<\/h2>/i);
const faqH2End = faqH2 >= 0 ? h.indexOf("</h2>", faqH2) + 5 : -1;

// FAQ section content ends at the next structural boundary (CTA signup or FAQ schema)
const signup = h.indexOf("app.b2ihub.com/signup");
const schema = h.indexOf('"@type": "FAQPage"');
// Find CTA block start: the wp:html block containing signup
const ctaBlockStart = signup >= 0 ? h.lastIndexOf("<!-- wp:html -->", signup) : -1;

// Conclusion: find the last paragraph block before CTA that's not in FAQ section
// Use the last occurrence of "Threads marketing" as a proxy (it's the conclusion topic)
const conclusionMarker = h.lastIndexOf("Threads marketing");
const conclusionPos = conclusionMarker >= 0 ? conclusionMarker : h.lastIndexOf("<!-- wp:paragraph -->");

// Build a list of ordered component positions
const items = [
  ["language-switcher", ls],
  ["intro", intro],
  ["first-H2", firstH2],
  ["FAQ-H2", faqH2],
  ["FAQ-section-end", faqH2End],
  ["conclusion-marker", conclusionPos],
  ["CTA-block-start", ctaBlockStart],
  ["CTA-signup", signup],
  ["FAQ-schema", schema],
].filter(([_, p]) => p >= 0)
 .sort((a, b) => a[1] - b[1]);

console.log("=== Component ORDER (by position, ascending) ===");
for (const [name, pos] of items) {
  console.log(`  ${String(pos).padStart(6)}  ${name}`);
}

console.log("\n=== Order check ===");
const names = items.map(([n]) => n);
const expected = ["language-switcher", "intro", "first-H2", "FAQ-H2", "FAQ-section-end", "conclusion-marker", "CTA-block-start", "CTA-signup", "FAQ-schema"];
const matches = expected.every((e, i) => names[i] === e);
if (matches) {
  console.log("✅ Component order is CORRECT");
} else {
  console.log("❌ Component order is WRONG");
  console.log("  Expected first 9:", expected.join(", "));
  console.log("  Got:            ", names.join(", "));
}
