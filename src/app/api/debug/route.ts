import { NextResponse } from "next/server";
import { headers } from "next/headers";

export async function GET() {
  const results: Record<string, unknown> = {};

  const headersList = await headers();
  results.headers = {
    "x-user-id": headersList.get("x-user-id") ?? null,
  };

  try {
    const { cookies: cookieFn } = await import("next/headers");
    const cookieStore = await cookieFn();
    const allCookies = cookieStore.getAll();
    results.cookies = {
      count: allCookies.length,
      names: allCookies.map((c) => c.name),
    };
  } catch (e) {
    results.cookies = { error: String(e) };
  }

  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    results.client = { created: true };
  } catch (e) {
    results.client = { error: String(e) };
  }

  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    results.auth = {
      authenticated: !!data.user,
      userId: data.user?.id ?? null,
      error: error?.message ?? null,
    };
  } catch (e) {
    results.auth = { error: String(e) };
  }

  try {
    const { getDb } = await import("@/db");
    const db = getDb();
    const { data, error } = await db.from("profiles").select("id", { count: "exact", head: true });
    if (error) throw error;
    results.db = { connected: true, profileCount: (data as unknown as { count?: number })?.count ?? 0 };
  } catch (e) {
    results.db = { error: e instanceof Error ? e.message : String(e) };
  }

  try {
    const { getDb } = await import("@/db");
    const db = getDb();
    const { data, error } = await db.from("profiles").select("*").limit(1);
    if (error) throw error;
    results.dbQuery = { rowCount: data?.length ?? 0 };
  } catch (e) {
    const err = e as Error & { code?: string };
    results.dbQuery = {
      error: err.message,
      code: err.code ?? null,
    };
  }

  return NextResponse.json(results);
}
