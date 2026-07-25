import { createClient } from "@supabase/supabase-js";

const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3cG5seWx3aGlvdGV5YXlkYm5sIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDE5NjMwMiwiZXhwIjoyMDk5NzcyMzAyfQ.mJKd_cKc74GZiFoI6TEB0Z0-4Ta6aL9kk8emXb9JaFQ";
const SUPABASE_URL = "https://jwpnlylwhioteyaydbnl.supabase.co";
const ADMIN = "5f399e6e-3a7a-4823-aa80-b265d45eb9a8";

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
