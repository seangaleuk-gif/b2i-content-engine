import fs from "fs";

const html = fs.readFileSync("generated-blog.html", "utf8");

// Find "30% more" context
const idx30 = html.indexOf("30% more");
if (idx30 >= 0) {
  console.log("=== 30% claim context ===");
  console.log(html.substring(Math.max(0, idx30 - 80), idx30 + 120));
} else {
  console.log("No '30% more' found");
}

// Check last FAQ answer
const schemaMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (schemaMatch) {
  const schema = JSON.parse(schemaMatch[1]);
  const last = schema.mainEntity[schema.mainEntity.length - 1];
  console.log("\n=== Last FAQ entry ===");
  console.log("Q:", last.name);
  console.log("A:", last.acceptedAnswer.text);
}
