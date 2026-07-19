const DEFAULT_LINKS = [
  { urlSlug: "/blog/creator-led-marketing-hong-kong", displayText: "Creator-Led Marketing in Hong Kong", keywords: ["creator-led", "creator marketing", "hong kong creators"], priority: 5, minPerArticle: 1, maxPerArticle: 3, active: true },
  { urlSlug: "/blog/content-that-converts", displayText: "Content That Converts", keywords: ["content that converts", "content marketing", "conversion"], priority: 4, minPerArticle: 1, maxPerArticle: 2, active: true },
  { urlSlug: "/blog/how-to-land-your-first-brand-deal-in-hong-kong-pitch-scripts-7-day-plan", displayText: "Land Your First Brand Deal: Pitch Scripts & 7-Day Plan", keywords: ["pitch scripts", "7-day challenge", "first brand deal", "pitch", "outreach"], priority: 4, minPerArticle: 0, maxPerArticle: 2, active: true },
  { urlSlug: "/blog/how-much-can-hong-kong-influencers-really-earn-rates-packages-the-money-side", displayText: "How Much Can Hong Kong Influencers Really Earn?", keywords: ["influencer rates", "tax hong kong", "influencer tax", "earnings"], priority: 3, minPerArticle: 0, maxPerArticle: 2, active: true },
  { urlSlug: "/blog/become-brand-ready-hong-kong", displayText: "Become Brand-Ready in Hong Kong", keywords: ["brand ready", "hong kong creators", "brand collaboration"], priority: 5, minPerArticle: 1, maxPerArticle: 2, active: true },
  { urlSlug: "/blog/where-hong-kong-micro-influencers-find-paid-brand-deals-platforms-outreach", displayText: "Where to Find Paid Brand Deals in Hong Kong", keywords: ["paid deals", "hong kong", "sponsorships", "outreach"], priority: 4, minPerArticle: 1, maxPerArticle: 2, active: true },
  { urlSlug: "/blog/how-to-close-better-deals-negotiation-media-kits-b2i-hub-verification", displayText: "How to Close Better Deals: Negotiation, Media Kits & B2I Hub Verification", keywords: ["negotiation", "media kits", "verification", "close deals"], priority: 4, minPerArticle: 1, maxPerArticle: 2, active: true },
];

export function getDefaultLinks() {
  return DEFAULT_LINKS;
}

export async function seedDefaultLinks(userId: string) {
  const { getDb } = await import("@/db");
  const db = getDb() as any;

  const { data: existing } = await db
    .from("internal_links")
    .select("url_slug")
    .eq("created_by", userId);

  const existingSlugs = new Set((existing ?? []).map((r: Record<string, unknown>) => r.url_slug));

  for (const link of DEFAULT_LINKS) {
    if (!existingSlugs.has(link.urlSlug)) {
      await db.from("internal_links").insert({
        created_by: userId,
        display_text: link.displayText,
        url_slug: link.urlSlug,
        keywords: link.keywords,
        priority: link.priority,
        min_per_article: link.minPerArticle,
        max_per_article: link.maxPerArticle,
        active: link.active,
      });
      console.log(`[default-links] Seeded: ${link.urlSlug}`);
    }
  }
}
