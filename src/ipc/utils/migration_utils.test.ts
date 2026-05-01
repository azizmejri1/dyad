import { describe, expect, it } from "vitest";
import {
  detectDestructiveStatements,
  parseDrizzleMigrationFile,
  deriveDestructiveReasons,
} from "./migration_utils";

// Sample inputs are anchored to the format drizzle-kit `generate` writes:
// SQL files separated by `--> statement-breakpoint` markers on their own
// lines. Re-validate when MIGRATION_DEPS bumps drizzle-kit.

describe("parseDrizzleMigrationFile", () => {
  it("returns a single statement when there are no breakpoints", () => {
    const sql = `CREATE TABLE "users" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"email" text NOT NULL\n);\n`;
    const statements = parseDrizzleMigrationFile(sql);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE "users"');
    expect(statements[0]).toContain('"email" text NOT NULL');
  });

  it("splits multiple statements on the breakpoint marker", () => {
    const sql = [
      'ALTER TABLE "users" ADD COLUMN "email" text;',
      "--> statement-breakpoint",
      'CREATE TABLE "posts" (',
      '\t"id" serial PRIMARY KEY NOT NULL,',
      '\t"title" text NOT NULL',
      ");",
      "--> statement-breakpoint",
      'DROP TABLE "old";',
      "",
    ].join("\n");

    const statements = parseDrizzleMigrationFile(sql);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe('ALTER TABLE "users" ADD COLUMN "email" text;');
    expect(statements[1]).toContain('CREATE TABLE "posts"');
    expect(statements[1]).toContain('"title" text NOT NULL');
    expect(statements[2]).toBe('DROP TABLE "old";');
  });

  it("returns an empty array for a comment-only file (the baseline shape)", () => {
    const sql =
      "-- Baseline: prod schema captured at bootstrap. Intentionally no-op; the snapshot\n" +
      "-- (meta/0000_snapshot.json) is the authoritative anchor for diffing.\n";

    expect(parseDrizzleMigrationFile(sql)).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseDrizzleMigrationFile("")).toEqual([]);
    expect(parseDrizzleMigrationFile("\n\n\n")).toEqual([]);
  });

  it("does not split on the marker text inside a SQL string literal", () => {
    // Marker on its own line splits; same text mid-line (e.g. inside a quoted
    // value) must NOT split. We anchor the regex to ^...$ with the m flag.
    const sql = [
      `INSERT INTO "logs" ("note") VALUES ('--> statement-breakpoint inline');`,
      "--> statement-breakpoint",
      'CREATE TABLE "x" ("id" serial);',
    ].join("\n");

    const statements = parseDrizzleMigrationFile(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("INSERT INTO");
    expect(statements[0]).toContain("inline");
    expect(statements[1]).toBe('CREATE TABLE "x" ("id" serial);');
  });

  it("strips ANSI codes that may have leaked into the file", () => {
    const sql =
      '\x1b[34mCREATE TABLE "x" ("id" serial);\x1b[0m\n' +
      "--> statement-breakpoint\n" +
      '\x1b[31mDROP TABLE "old";\x1b[0m\n';

    const statements = parseDrizzleMigrationFile(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('CREATE TABLE "x" ("id" serial);');
    expect(statements[1]).toBe('DROP TABLE "old";');
  });
});

describe("detectDestructiveStatements", () => {
  it("flags DROP TABLE / DROP COLUMN / TRUNCATE / ALTER COLUMN TYPE", () => {
    const statements = [
      'CREATE TABLE "x" ("id" serial);',
      'DROP TABLE "old";',
      'ALTER TABLE "users" DROP COLUMN "legacy_id";',
      'TRUNCATE "events";',
      'ALTER TABLE "users" ALTER COLUMN "age" SET DATA TYPE bigint;',
      'DROP SCHEMA "stale" CASCADE;',
    ];

    const result = detectDestructiveStatements(statements);

    expect(result).toEqual([
      { index: 1, reason: "drop_table" },
      { index: 2, reason: "drop_column" },
      { index: 3, reason: "truncate" },
      { index: 4, reason: "alter_column_type" },
      { index: 5, reason: "drop_schema" },
    ]);
  });

  it("returns empty for purely additive migrations", () => {
    const result = detectDestructiveStatements([
      'CREATE TABLE "x" ("id" serial);',
      'ALTER TABLE "x" ADD COLUMN "name" text;',
      'CREATE INDEX "idx" ON "x" ("id");',
    ]);
    expect(result).toEqual([]);
  });

  it("only flags each statement once", () => {
    const result = detectDestructiveStatements([
      'ALTER TABLE "x" DROP COLUMN "a", ALTER COLUMN "b" SET DATA TYPE bigint;',
    ]);
    expect(result).toHaveLength(1);
    // First match wins; drop_column comes before alter_column_type.
    expect(result[0].reason).toBe("drop_column");
  });
});

describe("deriveDestructiveReasons", () => {
  it("returns a unique reason code per destructive statement", () => {
    const reasons = deriveDestructiveReasons([
      { index: 0, reason: "drop_table" },
      { index: 1, reason: "drop_column" },
      { index: 2, reason: "drop_column" }, // duplicate reason
      { index: 3, reason: "alter_column_type" },
    ]);

    expect(reasons).toEqual(["drop_table", "drop_column", "alter_column_type"]);
  });

  it("returns empty when there are no destructive statements", () => {
    expect(deriveDestructiveReasons([])).toEqual([]);
  });
});
