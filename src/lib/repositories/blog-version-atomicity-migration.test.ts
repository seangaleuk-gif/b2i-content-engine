import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "phase15-blog-version-atomicity.sql"),
  "utf8",
);

describe("blog-version atomicity migration contract", () => {
  it("enforces one version number per project without deleting saved versions", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS blog_versions_project_version_unique\s+ON blog_versions \(project_id, version_number\)/,
    );
    expect(migration).not.toMatch(/DELETE\s+FROM\s+blog_versions/i);
    expect(migration).toContain("Cannot enforce blog version uniqueness");
  });

  it("synchronizes project content to the latest English version only", () => {
    expect(migration).toContain("sync_project_content_to_latest_english_blog_version");
    expect(migration).toContain("bv.slug !~ '-zh$'");
    expect(migration).toContain("FOR UPDATE");
  });

  it("allocates, inserts, and promotes an English version inside one database function", () => {
    expect(migration).toContain("save_generated_english_blog_version");
    expect(migration).toMatch(/FROM projects[\s\S]*FOR UPDATE/);
    expect(migration).toMatch(/SELECT COALESCE\(MAX\(version_number\), 0\) \+ 1[\s\S]*INSERT INTO blog_versions/);
    expect(migration).toMatch(/INSERT INTO blog_versions[\s\S]*UPDATE projects[\s\S]*RETURN to_jsonb\(saved\)/);
    expect(migration).toContain("English generation cannot save a Traditional Chinese slug");
  });

  it("exposes the synchronization boundary only to the server service role", () => {
    expect(migration).toMatch(/REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]*TO service_role/);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION save_generated_english_blog_version\(integer, uuid, jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated/,
    );
  });
});
