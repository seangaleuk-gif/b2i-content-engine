const WP_API_BASE = process.env.NEXT_PUBLIC_WP_SITE_URL || "";

function getCredentials() {
  const siteUrl = process.env.NEXT_PUBLIC_WP_SITE_URL;
  const username = process.env.WP_USERNAME;
  const appPassword = process.env.WP_APP_PASSWORD;

  if (!siteUrl || !username || !appPassword) {
    throw new Error("WordPress credentials not configured. Set NEXT_PUBLIC_WP_SITE_URL, WP_USERNAME, and WP_APP_PASSWORD in .env.local");
  }

  const baseUrl = siteUrl.replace(/\/+$/, "");
  const auth = Buffer.from(`${username}:${appPassword}`).toString("base64");

  return { baseUrl, auth };
}

interface WpPostInput {
  title: string;
  content: string;
  slug: string;
  excerpt?: string;
  categories?: string[];
  tags?: string[];
  status?: "publish" | "draft";
  seoTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
}

async function getOrCreateTerm(
  baseUrl: string,
  auth: string,
  taxonomy: "categories" | "tags",
  name: string
): Promise<number> {

  const response = await fetch(
    `${baseUrl}/wp-json/wp/v2/${taxonomy}?search=${encodeURIComponent(name)}`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  if (response.ok) {
    const existing = await response.json();
    if (existing.length > 0) return existing[0].id;
  }

  const createResp = await fetch(`${baseUrl}/wp-json/wp/v2/${taxonomy}`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });

  if (createResp.ok) {
    const created = await createResp.json();
    return created.id;
  }

  throw new Error(`Failed to create ${taxonomy}: ${name}`);
}

export async function publishToWordPress(input: WpPostInput): Promise<{ id: number; url: string }> {
  const { baseUrl, auth } = getCredentials();

  const categoryIds: number[] = [];
  for (const cat of input.categories || ["Creator Economy", "Resources"]) {
    try {
      const id = await getOrCreateTerm(baseUrl, auth, "categories", cat);
      categoryIds.push(id);
    } catch {}
  }

  const tagIds: number[] = [];
  for (const tag of input.tags || []) {
    try {
      const id = await getOrCreateTerm(baseUrl, auth, "tags", tag);
      tagIds.push(id);
    } catch {}
  }

  const response = await fetch(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: input.title,
      content: input.content,
      slug: input.slug.replace(/\/+$/, "").replace(/^\//, ""),
      excerpt: input.excerpt || "",
      categories: categoryIds,
      tags: tagIds,
      status: input.status || "publish",
      meta: {
        _yoast_wpseo_title: input.seoTitle || input.title,
        _yoast_wpseo_metadesc: input.metaDescription || input.excerpt || "",
        _yoast_wpseo_focuskw: input.focusKeyword || "",
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[wp] Publish failed:", error.substring(0, 500));
    if (response.status === 401) {
      throw new Error("WordPress authentication failed. Check your Application Password.");
    }
    throw new Error(`WordPress API returned ${response.status}: ${error.substring(0, 200)}`);
  }

  const data = await response.json();
  return { id: data.id, url: data.link };
}

export async function publishBilingual(
  enTitle: string,
  enContent: string,
  enSlug: string,
  enCategories: string[],
  enTags: string[],
  enSeoTitle: string,
  enMetaDescription: string,
  enFocusKeyword: string,
  zhTitle: string,
  zhContent: string,
  zhSlug: string,
  zhCategories: string[],
  zhTags: string[],
  zhSeoTitle: string,
  zhMetaDescription: string,
  zhFocusKeyword: string,
  status: "publish" | "draft" = "publish"
): Promise<{ en: { id: number; url: string }; zh: { id: number; url: string } }> {
  const en = await publishToWordPress({
    title: enTitle,
    content: enContent,
    slug: enSlug,
    categories: enCategories,
    tags: enTags,
    seoTitle: enSeoTitle,
    metaDescription: enMetaDescription,
    focusKeyword: enFocusKeyword,
    status,
  });

  let zh: { id: number; url: string } | null = null;

  if (zhContent) {
    try {
      zh = await publishToWordPress({
        title: zhTitle,
        content: zhContent,
        slug: zhSlug,
        categories: zhCategories,
        tags: zhTags,
        seoTitle: zhSeoTitle,
        metaDescription: zhMetaDescription,
        focusKeyword: zhFocusKeyword,
        status,
      });
    } catch (err) {
      console.error("[wp] Chinese version publish failed:", err);
    }
  }

  return {
    en,
    zh: zh || { id: 0, url: "" },
  };
}
