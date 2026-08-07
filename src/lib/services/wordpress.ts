import { AppError } from "./errors";
import { fingerprintHtml } from "@/lib/blog/article-document";

function getCredentials() {
  const siteUrl = process.env.NEXT_PUBLIC_WP_SITE_URL;
  const username = process.env.WP_USERNAME;
  const appPassword = process.env.WP_APP_PASSWORD;

  if (!siteUrl || !username || !appPassword) {
    throw AppError.internal();
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

  console.error(`[wp] Failed to create ${taxonomy}: ${name}`);
  throw AppError.internal(new Error(`Failed to create ${taxonomy}: ${name}`));
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
      console.error("[wp] WordPress authentication failed");
      throw AppError.internal(new Error("WordPress authentication failed"));
    }
    console.error(`[wp] WordPress API returned ${response.status}: ${error.substring(0, 200)}`);
    throw AppError.internal(new Error(`WordPress API returned ${response.status}: ${error.substring(0, 200)}`));
  }

  const data = await response.json();
  return { id: data.id, url: data.link };
}

interface WpPostReadback {
  id: number;
  link: string;
  status: string;
  content?: { raw?: string; rendered?: string };
}

async function readWordPressPost(id: number): Promise<WpPostReadback> {
  const { baseUrl, auth } = getCredentials();
  const response = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${id}?context=edit`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    throw AppError.internal(new Error(`WordPress readback failed for post ${id}: ${response.status}`));
  }
  return response.json() as Promise<WpPostReadback>;
}

async function verifyWordPressPost(id: number, expectedContent: string, expectedStatus: "draft" | "publish"): Promise<WpPostReadback> {
  const post = await readWordPressPost(id);
  const raw = post.content?.raw;
  if (typeof raw !== "string") {
    throw AppError.internal(new Error(`WordPress readback for post ${id} omitted raw content`));
  }
  if (fingerprintHtml(raw) !== fingerprintHtml(expectedContent)) {
    throw AppError.internal(new Error(`WordPress content readback mismatch for post ${id}`));
  }
  if (post.status !== expectedStatus) {
    throw AppError.internal(new Error(`WordPress status mismatch for post ${id}: expected ${expectedStatus}, got ${post.status}`));
  }
  return post;
}

async function setWordPressPostStatus(id: number, status: "draft" | "publish"): Promise<WpPostReadback> {
  const { baseUrl, auth } = getCredentials();
  const response = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${id}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    throw AppError.internal(new Error(`WordPress status update failed for post ${id}: ${response.status}`));
  }
  return response.json() as Promise<WpPostReadback>;
}

async function compensateWordPressPost(id: number): Promise<void> {
  const { baseUrl, auth } = getCredentials();
  const response = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${id}?force=true`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok && response.status !== 404) {
    console.error(`[wp] Compensation failed for post ${id}: ${response.status}`);
  }
}

/** Delete both posts created by a completed bilingual attempt when a later
 * application-owned commit (for example, project status) fails. */
export async function compensateBilingualWordPress(enPostId: number, zhPostId: number): Promise<void> {
  await Promise.all([
    compensateWordPressPost(enPostId),
    compensateWordPressPost(zhPostId),
  ]);
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
  if (!zhContent) {
    throw AppError.badRequest("A validated Traditional Chinese version is required for bilingual WordPress saving");
  }

  let en: { id: number; url: string } | null = null;
  let zh: { id: number; url: string } | null = null;
  try {
    // Stage both language versions as drafts first. Nothing becomes publicly
    // visible until both posts have passed raw-content readback.
    en = await publishToWordPress({
      title: enTitle,
      content: enContent,
      slug: enSlug,
      categories: enCategories,
      tags: enTags,
      seoTitle: enSeoTitle,
      metaDescription: enMetaDescription,
      focusKeyword: enFocusKeyword,
      status: "draft",
    });
    await verifyWordPressPost(en.id, enContent, "draft");

    zh = await publishToWordPress({
      title: zhTitle,
      content: zhContent,
      slug: zhSlug,
      categories: zhCategories,
      tags: zhTags,
      seoTitle: zhSeoTitle,
      metaDescription: zhMetaDescription,
      focusKeyword: zhFocusKeyword,
      status: "draft",
    });
    await verifyWordPressPost(zh.id, zhContent, "draft");

    if (status === "publish") {
      await setWordPressPostStatus(en.id, "publish");
      await setWordPressPostStatus(zh.id, "publish");
      const enPublished = await verifyWordPressPost(en.id, enContent, "publish");
      const zhPublished = await verifyWordPressPost(zh.id, zhContent, "publish");
      en = { id: enPublished.id, url: enPublished.link };
      zh = { id: zhPublished.id, url: zhPublished.link };
    }

    return { en, zh };
  } catch (error) {
    // WordPress has no cross-post transaction. Delete every post created by
    // this attempt so a partial bilingual publication is never reported as
    // successful or left public.
    if (zh?.id && en?.id) await compensateBilingualWordPress(en.id, zh.id);
    else if (zh?.id) await compensateWordPressPost(zh.id);
    else if (en?.id) await compensateWordPressPost(en.id);
    throw error;
  }
}
