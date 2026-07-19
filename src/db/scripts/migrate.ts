import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  console.log("Running database migrations...");

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const migration = readFileSync(
      join(__dirname, "..", "migrations", "0000_initial_schema.sql"),
      "utf-8"
    );

    await sql.unsafe(migration);
    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  } finally {
    await sql.end();
  }
}

runMigrations();
