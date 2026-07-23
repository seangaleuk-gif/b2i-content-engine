const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

import { AppError } from "./errors";

export interface ResearchItem {
  title: string;
  url: string;
  snippet: string;
  category: "google" | "paa" | "related" | "knowledge" | "news" | "discussion" | "faq";
  position: number;
}

function getApiKey(): string {
  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    throw AppError.internal();
  }
  return key;
}

export async function runBraveResearch(query: string): Promise<ResearchItem[]> {
  const apiKey = getApiKey();

  console.log(`[brave:REQ] key_prefix=${apiKey.substring(0, 8)}... key_length=${apiKey.length}`);
  console.log(`[brave:REQ] query="${query}"`);
  console.log(`[brave:REQ] endpoint=${BRAVE_API_URL}?q=${encodeURIComponent(query)}`);

  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=10`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      console.error("[brave] Research request timed out");
      throw AppError.internal(err instanceof Error ? err : undefined);
    }
    console.error("[brave] Research network error:", err instanceof Error ? err.message : String(err));
    throw AppError.internal(new Error(`Brave Search network error: ${err instanceof Error ? err.message : String(err)}`));
  }
  clearTimeout(timeout);

  if (!response.ok) {
    let errorBody = "";
    try { errorBody = await response.text(); } catch {}
    console.error(`[brave:FAIL] HTTP ${response.status}: ${errorBody.substring(0, 300)}`);
    if (response.status === 401 || response.status === 403) {
      console.error(`[brave] API authentication failed (${response.status})`);
      throw AppError.internal(new Error(`Brave Search API authentication failed (${response.status})`));
    }
    if (response.status === 429) {
      throw AppError.tooManyRequests("Research rate limit exceeded");
    }
    throw AppError.internal(new Error(`Brave Search API returned ${response.status}: ${errorBody.substring(0, 200)}`));
  }

  const data = await response.json() as import("./brave-types").BraveSearchResponse;

  console.log(
    `[brave:RES] web=${data.web?.results?.length ?? 0} | discussion=${data.discussion?.results?.length ?? 0} | faq=${data.faq?.results?.length ?? 0} | news=${data.news?.results?.length ?? 0}`
  );

  const results: ResearchItem[] = [];
  let pos = 0;

  const webResults = data.web?.results;
  if (webResults) {
    for (const r of webResults.slice(0, 10)) {
      results.push({
        title: r.title || "",
        url: r.url || "",
        snippet: r.description || "",
        category: "google",
        position: pos++,
      });
    }
  }

  const discussions = data.discussion?.results;
  if (discussions) {
    for (const d of discussions) {
      results.push({
        title: d.title || "",
        url: d.url || "",
        snippet: d.description || "",
        category: "discussion",
        position: pos++,
      });
    }
  }

  const faqs = data.faq?.results;
  if (faqs) {
    for (const f of faqs) {
      results.push({
        title: f.question || f.title || "",
        url: f.url || "",
        snippet: f.answer || "",
        category: "faq",
        position: pos++,
      });
    }
  }

  const newsResults = data.news?.results;
  if (newsResults) {
    for (const n of newsResults) {
      results.push({
        title: n.title || "",
        url: n.url || "",
        snippet: n.description || "",
        category: "news",
        position: pos++,
      });
    }
  }

  return results;
}

export async function runBraveResearchWithRetry(
  query: string,
  maxRetries = 2
): Promise<ResearchItem[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runBraveResearch(query);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[brave] Attempt ${attempt + 1}/${maxRetries + 1} failed:`, lastError.message);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  console.error("[brave] Research request failed after all retries");
  throw lastError ?? AppError.internal(new Error("Brave research failed after all retries"));
}
