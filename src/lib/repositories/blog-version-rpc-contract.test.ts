import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "phase15-blog-version-atomicity.sql"),
  "utf8",
);
const repository = readFileSync(
  join(process.cwd(), "src", "lib", "repositories", "blog-versions.ts"),
  "utf8",
);

function migrationParameters(
  sql: string,
  functionName: string,
): Array<{ name: string; type: string }> {
  const match = sql.match(
    new RegExp(`CREATE OR REPLACE FUNCTION\\s+${functionName}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS`),
  );
  expect(match, `migration must declare ${functionName}`).not.toBeNull();
  return match![1]
    .split(",")
    .map((decl) => decl.trim())
    .filter((decl) => decl.length > 0)
    .map((decl) => {
      const parts = decl.split(/\s+/);
      const name = parts[0];
      const type = parts.slice(1, parts.indexOf("DEFAULT") === -1 ? undefined : parts.indexOf("DEFAULT")).join(" ");
      return { name, type };
    });
}

function repositoryRpcArgs(
  source: string,
  functionName: string,
): { rpcName: string; argNames: string[] } {
  const call = source.match(
    new RegExp(`db\\.rpc\\(\\s*"${functionName}"\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`),
  );
  expect(call, `repository must call rpc(${functionName})`).not.toBeNull();
  const argNames = [...call![1].matchAll(/\b(p_[a-z_]+)\s*:/g)].map((m) => m[1]);
  return { rpcName: functionName, argNames };
}

describe("English save RPC contract: application signature matches the database migration", () => {
  it("save_generated_english_blog_version: repository RPC name and parameter names match the migration declaration", () => {
    const params = migrationParameters(migration, "save_generated_english_blog_version");
    const call = repositoryRpcArgs(repository, "save_generated_english_blog_version");

    expect(params.map((p) => p.name)).toEqual(["p_project_id", "p_user_id", "p_payload"]);
    expect(call.argNames).toEqual(["p_project_id", "p_user_id", "p_payload"]);
    expect(call.rpcName).toBe("save_generated_english_blog_version");
  });

  it("save_generated_english_blog_version: parameter types match the values the application sends", () => {
    const params = migrationParameters(migration, "save_generated_english_blog_version");
    expect(params.map((p) => p.type)).toEqual(["integer", "uuid", "jsonb"]);
  });

  it("sync_project_content_to_latest_english_blog_version: repository RPC matches the migration declaration", () => {
    const params = migrationParameters(migration, "sync_project_content_to_latest_english_blog_version");
    const call = repositoryRpcArgs(repository, "sync_project_content_to_latest_english_blog_version");

    expect(params.map((p) => p.name)).toEqual(["p_project_id", "p_user_id", "p_fallback_content"]);
    expect(call.argNames).toEqual(["p_project_id", "p_user_id", "p_fallback_content"]);
    expect(call.rpcName).toBe("sync_project_content_to_latest_english_blog_version");
    expect(params.map((p) => p.type)).toEqual(["integer", "uuid", "text"]);
  });

  it("save success atomically returns the inserted row and promotes project content in one function", () => {
    const fnBlock = migration.match(
      /CREATE OR REPLACE FUNCTION save_generated_english_blog_version[\s\S]*?RETURNS jsonb[\s\S]*?AS \$\$[\s\S]*?\$\$/,
    );
    expect(fnBlock).not.toBeNull();
    expect(fnBlock![0]).toMatch(/INSERT INTO blog_versions[\s\S]*RETURNING \* INTO saved/);
    expect(fnBlock![0]).toMatch(/UPDATE projects[\s\S]*SET content = COALESCE\(saved\.blog, ''\)/);
    expect(fnBlock![0]).toMatch(/RETURN to_jsonb\(saved\)/);
    const insertPos = fnBlock![0].indexOf("INSERT INTO blog_versions");
    const updatePos = fnBlock![0].indexOf("UPDATE projects");
    expect(insertPos).toBeGreaterThan(-1);
    expect(updatePos).toBeGreaterThan(insertPos);
  });
});
