import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { scaffoldCouncil } from "./init.js";
import { ConfigError } from "../errors.js";
import { loadCouncilConfig, validateCouncilConfig } from "../config/council-config.js";
import type { LogFields, Logger } from "../logging/logger.js";

// Mock only `writeFile` from node:fs/promises so the partial-failure test
// (TP-11) can force a post-create write error while `mkdir`/`rm` (and the
// remaining functions) delegate to the real implementation. By default the
// spy delegates to the real `writeFile`, so every other test behaves normally.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

interface CapturedLog {
  message: string;
  fields?: LogFields;
}

function createCapturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const record = (message: string, fields?: LogFields): void => {
    records.push({ message, fields });
  };
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    records,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  const err = await promise.then(
    () => {
      throw new Error("expected scaffoldCouncil to reject, but it resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).code).toBe("CONFIG_ERROR");
  return err as ConfigError;
}

describe("scaffoldCouncil", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "council-init-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // TP-01 — happy-path scaffolds the exact workspace tree.
  it("scaffolds the exact workspace tree and returns created paths (TP-01)", async () => {
    const { logger } = createCapturingLogger();
    const res = await scaffoldCouncil({ name: "demo", baseDir, logger });

    const councilDir = resolve(baseDir, "council", "demo");
    expect(res.councilDir).toBe(councilDir);

    const entries = (await readdir(councilDir)).sort();
    expect(entries).toEqual([
      "artifacts",
      "council.yaml",
      "decisions.md",
      "open-questions.md",
      "transcript",
    ]);

    // artifacts/ and transcript/ are empty (no .gitkeep) per the action plan.
    expect(await readdir(join(councilDir, "artifacts"))).toEqual([]);
    expect(await readdir(join(councilDir, "transcript"))).toEqual([]);

    expect(res.created).toEqual([
      councilDir,
      join(councilDir, "artifacts"),
      join(councilDir, "transcript"),
      join(councilDir, "council.yaml"),
      join(councilDir, "decisions.md"),
      join(councilDir, "open-questions.md"),
    ]);
    // The shared council/ base is intentionally excluded from `created`.
    expect(res.created).not.toContain(resolve(baseDir, "council"));
  });

  // TP-02 — council/ base is created when absent and reused when present.
  it("creates the council/ base when absent and reuses it when present (TP-02)", async () => {
    // Case 1: fresh baseDir, no council/ yet.
    expect(await exists(resolve(baseDir, "council"))).toBe(false);
    await scaffoldCouncil({ name: "a", baseDir });
    expect(await exists(resolve(baseDir, "council", "a", "council.yaml"))).toBe(true);

    // Case 2: council/ already exists, scaffold a second council under it.
    await scaffoldCouncil({ name: "b", baseDir });
    expect(await exists(resolve(baseDir, "council", "b", "council.yaml"))).toBe(true);
    // The first council is untouched.
    expect(await exists(resolve(baseDir, "council", "a", "council.yaml"))).toBe(true);
  });

  // TP-03 — generated council.yaml passes validateCouncilConfig (members array).
  it("generates a council.yaml that passes validateCouncilConfig (TP-03)", async () => {
    const res = await scaffoldCouncil({ name: "demo", baseDir });
    const raw = await readFile(join(res.councilDir, "council.yaml"), "utf8");
    const parsed = parse(raw) as { members: { id: string }[] };

    expect(() => validateCouncilConfig(parsed)).not.toThrow();
    const cfg = validateCouncilConfig(parsed);

    expect(Array.isArray(parsed.members)).toBe(true);
    expect(typeof parsed.members[0].id).toBe("string");
    expect(parsed.members[0].id.length).toBeGreaterThan(0);
    expect(cfg.members[0].tools).toBe("read-only");
  });

  // TP-04 — loadCouncilConfig round-trips and populates the typed policy fields.
  it("round-trips through loadCouncilConfig with populated typed policy fields (TP-04)", async () => {
    const res = await scaffoldCouncil({ name: "demo", baseDir });
    const cfg = await loadCouncilConfig(join(res.councilDir, "council.yaml"));

    expect(cfg.orchestrator.policy?.maxRounds).toBe(5);
    expect(cfg.orchestrator.policy?.requireProjectValidation).toBe(true);
    expect(cfg.orchestrator.policy?.writeArtifacts).toBe(true);

    expect(cfg.name).toBe("demo");
    expect(typeof cfg.goal).toBe("string");
    expect(cfg.goal.length).toBeGreaterThan(0);
    expect(cfg.members.length).toBeGreaterThanOrEqual(1);
    expect(cfg.orchestrator.cwd.length).toBeGreaterThan(0);
    expect(cfg.artifacts.length).toBeGreaterThanOrEqual(1);
  });

  // TP-05 — starter council.yaml includes all required fields.
  it("includes name, goal, member, orchestrator, and artifacts (TP-05)", async () => {
    const res = await scaffoldCouncil({ name: "demo", baseDir });
    const raw = await readFile(join(res.councilDir, "council.yaml"), "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    const cfg = await loadCouncilConfig(join(res.councilDir, "council.yaml"));

    expect(cfg.name).toBe("demo");
    expect(cfg.goal.length).toBeGreaterThan(0);

    const member = cfg.members[0];
    expect(member.cwd.length).toBeGreaterThan(0);
    expect(member.role.length).toBeGreaterThan(0);
    expect(member.agent).toBeDefined();
    expect(member.tools).toBe("read-only");

    expect(cfg.orchestrator.cwd.length).toBeGreaterThan(0);
    expect(cfg.orchestrator.model).toBeDefined();
    expect(cfg.orchestrator.policy).toBeDefined();
    expect(cfg.artifacts.length).toBeGreaterThanOrEqual(1);

    // `agent` and `model` are present in the raw body too.
    const rawMembers = parsed.members as { agent?: string }[];
    expect(rawMembers[0].agent).toBe("project-architect");
    expect((parsed.orchestrator as { model?: string }).model).toBe("gpt-5");
  });

  // TP-06 — seed files created with expected content.
  it("creates decisions.md and open-questions.md seed files (TP-06)", async () => {
    const res = await scaffoldCouncil({ name: "demo", baseDir });

    const decisions = await readFile(join(res.councilDir, "decisions.md"), "utf8");
    expect(decisions.startsWith("# Decisions")).toBe(true);
    expect(decisions).toContain("Records of decisions made by this council");

    const openQuestions = await readFile(join(res.councilDir, "open-questions.md"), "utf8");
    expect(openQuestions.startsWith("# Open Questions")).toBe(true);
    expect(openQuestions).toContain("Unresolved questions for this council");
  });

  // TP-07 — success emits council.init.created; no console.log.
  it("emits council.init.created and never calls console.log (TP-07)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger, records } = createCapturingLogger();

    const res = await scaffoldCouncil({ name: "demo", baseDir, logger });

    const created = records.filter((r) => r.message === "council.init.created");
    expect(created).toHaveLength(1);
    expect(created[0].fields?.councilDir).toBe(res.councilDir);
    expect(created[0].fields?.created).toBe(res.created.length);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // TP-08 — existing council directory is not clobbered.
  it("refuses to clobber an existing council directory (TP-08)", async () => {
    const councilDir = resolve(baseDir, "council", "demo");
    await mkdir(councilDir, { recursive: true });
    const sentinel = join(councilDir, "sentinel.txt");
    await writeFile(sentinel, "keep", "utf8");

    const err = await expectConfigError(scaffoldCouncil({ name: "demo", baseDir }));
    expect(err.message).toContain(councilDir);

    // No existing file was modified and cleanup did NOT run (sentinel survives).
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect(await exists(councilDir)).toBe(true);
  });

  // TP-09 — each invalid-name class is rejected before any filesystem write.
  it("rejects every invalid-name class before any filesystem write (TP-09)", async () => {
    // The seven required classes plus allowlist-violating names (space, '@').
    const invalidNames = ["", "   ", ".", "..", "a/b", "a\\b", "a\u0000b", "a b", "a@b"];
    for (const name of invalidNames) {
      await expectConfigError(scaffoldCouncil({ name, baseDir }));
      // Rejection happens before any FS write: council/ base is never created.
      expect(await exists(resolve(baseDir, "council"))).toBe(false);
    }
  });

  // TP-10 — traversal guard via resolve+relative (not string matching alone).
  it("keeps every accepted name strictly inside council/ and rejects .. (TP-10)", async () => {
    const councilBase = resolve(baseDir, "council");
    for (const name of ["demo", "a.b_c-1"]) {
      const res = await scaffoldCouncil({ name, baseDir });
      const rel = relative(councilBase, res.councilDir);
      expect(rel).toBe(name);
      expect(rel.startsWith("..")).toBe(false);
    }

    // Backstop: ".." is rejected and nothing escapes council/.
    await expectConfigError(scaffoldCouncil({ name: "..", baseDir }));
    expect(await exists(resolve(baseDir, "council", ".."))).toBe(true); // == baseDir
    // No council artifacts leaked into baseDir itself.
    expect(await exists(join(baseDir, "council.yaml"))).toBe(false);
  });

  // TP-10b — allowlisted dot-prefixed names that stay inside council/ are
  // accepted; the guard rejects only real escapes, not any name starting with
  // ".." (regression for the overly-broad `startsWith("..")` guard).
  it("accepts allowlisted dot-prefixed names that remain inside council/ (TP-10b)", async () => {
    const councilBase = resolve(baseDir, "council");
    for (const name of ["..a", "..."]) {
      const res = await scaffoldCouncil({ name, baseDir });
      // The directory is created at exactly council/<name>, strictly inside base.
      expect(res.councilDir).toBe(resolve(councilBase, name));
      expect(relative(councilBase, res.councilDir)).toBe(name);
      expect(await exists(join(res.councilDir, "council.yaml"))).toBe(true);
    }
  });

  // TP-11 — partial-failure cleanup removes the partially-created directory.
  it("removes the partial directory when a post-create write fails (TP-11)", async () => {
    const councilDir = resolve(baseDir, "council", "demo");
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));

    const err = await expectConfigError(scaffoldCouncil({ name: "demo", baseDir }));
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("disk full");

    // The partially-created council/demo/ was removed; the council/ base remains.
    expect(await exists(councilDir)).toBe(false);
    expect(await exists(resolve(baseDir, "council"))).toBe(true);
  });

  // TP-12 — error messages are human-actionable and name the offending name/path.
  it("produces human-actionable messages naming the name/path (TP-12)", async () => {
    // Invalid name: message names the rejected name.
    const invalid = await expectConfigError(scaffoldCouncil({ name: "a/b", baseDir }));
    expect(invalid.message).toContain("a/b");

    // No-clobber: message names the council path.
    const councilDir = resolve(baseDir, "council", "demo");
    await mkdir(councilDir, { recursive: true });
    const clobber = await expectConfigError(scaffoldCouncil({ name: "demo", baseDir }));
    expect(clobber.message).toContain(councilDir);

    // Partial failure: message names the name/path and preserves cause.
    const fresh = await mkdtemp(join(tmpdir(), "council-init-"));
    try {
      vi.mocked(writeFile).mockRejectedValueOnce(new Error("boom"));
      const partial = await expectConfigError(scaffoldCouncil({ name: "demo", baseDir: fresh }));
      expect(partial.message).toContain("demo");
      expect(partial.cause).toBeInstanceOf(Error);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
