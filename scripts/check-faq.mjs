import fs from "fs";

const html = fs.readFileSync("generated-blog.html", "utf8");

// Extract FAQ schema
const schemaMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (schemaMatch) {
  const schema = JSON.parse(schemaMatch[1]);
  console.log("FAQ schema entries:", schema.mainEntity.length);

  const ctaPatterns = /(Ready to|Sign up|Create your|Get started|Start your|B2I Hub connects|Create a free)/i;
  for (let i = 0; i < schema.mainEntity.length; i++) {
    const entry = schema.mainEntity[i];
    const answer = entry.acceptedAnswer.text;
    const hasCta = ctaPatterns.test(answer);
    console.log(`  Q${i + 1}: "${entry.name.substring(0, 60)}"`);
    console.log(`    Answer len=${answer.length}${hasCta ? " HAS CTA!" : " clean"}`);
    if (hasCta) {
      console.log(`    Answer starts with: "${answer.substring(0, 120)}..."`);
    }
  }

  // Count visible FAQ questions
  const visibleFaq = html.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi) || [];
  const faqQs = visibleFaq.filter((s) => {
    const t = s.replace(/<[^>]+>/g, "").trim();
    return t.endsWith("?");
  });
  console.log(`\nVisible FAQ <strong> questions: ${faqQs.length}`);
  console.log(`Schema questions: ${schema.mainEntity.length}`);
  console.log(`Match: ${faqQs.length === schema.mainEntity.length ? "YES" : "NO"}`);
}

// Verify no CTA text in last answer
if (schemaMatch) {
  const schema = JSON.parse(schemaMatch[1]);
  const lastAnswer = schema.mainEntity[schema.mainEntity.length - 1].acceptedAnswer.text;
  console.log(`\nLast answer text (first 200): "${lastAnswer.substring(0, 200)}"`);
}
