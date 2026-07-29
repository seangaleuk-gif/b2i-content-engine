// Inspect the generated article for links and structure
const { createClient } = require('@supabase/supabase-js');
const s = createClient('https://jwpnlylwhioteyaydbnl.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const { data: p } = await s.from('projects').select('content').eq('id', 16).single();
  if (!p || !p.content) { console.log('No content'); return; }
  const html = p.content;

  // Internal links (b2ihub.com/blog or app.b2ihub.com/*)
  const internalR = /<a\b[^>]*href="(https?:\/\/(?:app|blog)\.b2ihub\.com\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const internalLinks = [];
  let m;
  while ((m = internalR.exec(html)) !== null) {
    const url = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').trim();
    internalLinks.push({ text, url });
  }
  console.log('=== INTERNAL LINKS ===');
  internalLinks.forEach(l => console.log(`  "${l.text}" → ${l.url}`));
  console.log('Count:', internalLinks.length);

  // External links (all non-b2ihub)
  const externalR = /<a\b[^>]*href="(https?:\/\/(?!(?:app|blog)\.b2ihub\.com)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const externalLinks = [];
  let m2;
  while ((m2 = externalR.exec(html)) !== null) {
    const url = m2[1];
    const text = m2[2].replace(/<[^>]*>/g, '').trim();
    // skip schema, signup
    if (url.includes('signup') || url.includes('FAQPage') || url.includes('schema.org')) continue;
    externalLinks.push({ text, url });
  }
  console.log('\n=== EXTERNAL LINKS ===');
  externalLinks.forEach(l => console.log(`  "${l.text}" → ${l.url}`));
  console.log('Count:', externalLinks.length);

  // Signup URLs in CTA
  const signupCount = (html.match(/app\.b2ihub\.com\/signup/g) || []).length;
  console.log('\nSignup URL count:', signupCount);

  // H2 headings
  const h2R = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const h2s = [];
  let m3;
  while ((m3 = h2R.exec(html)) !== null) {
    h2s.push(m3[1].replace(/<[^>]*>/g, '').trim());
  }
  console.log('\n=== H2 HEADINGS ===');
  h2s.forEach(h => console.log(`  ${h2s.indexOf(h) + 1}. ${h}`));
  console.log('Count:', h2s.length);

  // FAQ schema
  const faqSchema = (html.match(/"@type":\s*"FAQPage"/g) || []).length;
  console.log('\nFAQ schema count:', faqSchema);

  // Duplicate CTA blocks
  const ctaBlocks = (html.match(/app\.b2ihub\.com\/signup/g) || []).length;
  console.log('CTA signup occurrences:', ctaBlocks);

  console.log('\n=== INSPECTION COMPLETE ===');
})().catch(e => console.error(e));
