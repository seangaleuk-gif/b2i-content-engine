import { createClient } from "@supabase/supabase-js";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = process.env.B2I_TEST_ADMIN_USER_ID;

const missing = [
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY],
  ["NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL],
  ["B2I_TEST_ADMIN_USER_ID", ADMIN],
].filter(([, value]) => !value).map(([name]) => name);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

async function go() {
  const { data: projects } = await adminClient.from("projects").select("id, name").eq("user_id", ADMIN);
  console.log("Admin projects:", projects?.length || 0);

  for (const p of projects || []) {
    const { data: versions } = await adminClient
      .from("blog_versions")
      .select("id, version_number, slug, title, word_count, blog")
      .eq("project_id", p.id)
      .order("version_number", { ascending: false })
      .limit(5);

    for (const v of versions || []) {
      if (v.word_count >= 2000 && v.blog && v.blog.length > 100) {
        console.log(`Project #${p.id} "${p.name}" - v${v.version_number}: "${v.title}" (${v.word_count}w, ${v.blog.length}c, slug=${v.slug})`);
      }
    }
  }
}

go().catch(console.error);
