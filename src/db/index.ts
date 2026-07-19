import { createClient as createSupabaseClient } from "@supabase/supabase-js";

let _client: ReturnType<typeof createSupabaseClient> | null = null;

export function getDb() {
  if (_client) return _client;

  _client = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );

  return _client;
}
