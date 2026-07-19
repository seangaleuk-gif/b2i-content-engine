export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function normalize<T>(data: T): T {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(normalize) as unknown as T;
  if (typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const camelKey = snakeToCamel(key);
      out[camelKey] = normalize(value);
    }
    return out as T;
  }
  return data;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      body.error ?? `Request failed with status ${response.status}`,
      response.status
    );
  }

  const data = await response.json();
  return normalize(data) as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: "DELETE", body: body ? JSON.stringify(body) : undefined }),
};
