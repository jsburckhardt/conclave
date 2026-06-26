import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli-program.js";
import { loadCouncilConfig } from "./config/council-config.js";
import type { LogFields, Logger } from "./logging/logger.js";

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

const VALID_CONFIG = `name: demo
goal: Ship the thing
members:
  - id: alice
    cwd: ../alice
    role: Lead
    tools: read-only
orchestrator:
  cwd: .
`;

describe("cli-program main", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "council-cli-"));
    process.exitCode = 0;
    // Suppress any stderr noise (e.g. Commander parse diagnostics) for clean output.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  async function writeConfig(council: string): Promise<string> {
    const dir = join(baseDir, "council", council);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "council.yaml");
    await writeFile(path, VALID_CONFIG, "utf8");
    return path;
  }

  // TP-18 — add-member CLI: failure exits non-zero with a structured error log
  // carrying the code; success exits 0 with start + success logs.
  it("add-member CLI: non-existent council fails, valid council succeeds (TP-18)", async () => {
    // Failure: council/missing/council.yaml does not exist.
    process.exitCode = 0;
    const { logger: failLogger, records: failRecords } = createCapturingLogger();
    await main(["node", "council", "add-member", "missing", "bob", "--cwd", ".", "--role", "r"], {
      logger: failLogger,
      baseDir,
    });
    expect(process.exitCode).toBe(1);
    expect(
      failRecords.find((r) => r.message === "council.add-member.failed")?.fields,
    ).toMatchObject({ council: "missing", memberId: "bob", code: "CONFIG_ERROR" });
    expect(failRecords.find((r) => r.message === "council.error")?.fields).toMatchObject({
      code: "CONFIG_ERROR",
    });

    // Success: a valid council/demo/council.yaml gains the new member.
    process.exitCode = 0;
    const path = await writeConfig("demo");
    const { logger: okLogger, records: okRecords } = createCapturingLogger();
    await main(["node", "council", "add-member", "demo", "bob", "--cwd", ".", "--role", "r"], {
      logger: okLogger,
      baseDir,
    });
    expect(process.exitCode).toBe(0);
    expect(okRecords.some((r) => r.message === "council.add-member")).toBe(true);
    expect(okRecords.some((r) => r.message === "council.add-member.succeeded")).toBe(true);
    const cfg = await loadCouncilConfig(path);
    expect(cfg.members.some((m) => m.id === "bob")).toBe(true);
  });

  // TP-25 — init/run/continue behave correctly through the moved/wired actions:
  // continue now delegates to continueCouncil (no not-implemented stub), failing
  // with STATE_ERROR when there is no prior run; the traversal guard rejects an
  // escaping <council>; and `--force` parses without a Commander error.
  it("init/run/continue behave correctly through main (TP-25)", async () => {
    // init scaffolds council/smoke/ and exits 0.
    process.exitCode = 0;
    const { logger: initLogger, records: initRecords } = createCapturingLogger();
    await main(["node", "council", "init", "smoke"], { logger: initLogger, baseDir });
    expect(process.exitCode).toBe(0);
    expect(await exists(join(baseDir, "council", "smoke", "council.yaml"))).toBe(true);
    expect(initRecords.some((r) => r.message === "council.init")).toBe(true);

    // run loads the config and logs council.run, then fails fast (exit 1): the
    // init-scaffolded single-member 'smoke' council cannot resolve two distinct
    // roles, so resolveRoles raises ORCHESTRATION_ERROR before any SDK session.
    process.exitCode = 0;
    const validConfigPath = join(baseDir, "council", "smoke", "council.yaml");
    const { logger: runLogger, records: runRecords } = createCapturingLogger();
    await main(["node", "council", "run", "smoke", "--config", validConfigPath], {
      logger: runLogger,
      baseDir,
    });
    expect(process.exitCode).toBe(1);
    expect(runRecords.some((r) => r.message === "council.run")).toBe(true);

    // continue delegates to continueCouncil: 'smoke' was never successfully run, so
    // there is no state.json → StateError. main() logs council.continue (entry),
    // council.continue.failed { STATE_ERROR }, and council.error { STATE_ERROR },
    // then exits 1 — NOT the old not-implemented notice.
    process.exitCode = 0;
    const { logger: contLogger, records: contRecords } = createCapturingLogger();
    await main(["node", "council", "continue", "smoke"], { logger: contLogger, baseDir });
    expect(process.exitCode).toBe(1);
    expect(contRecords.some((r) => r.message === "council.continue")).toBe(true);
    expect(contRecords.find((r) => r.message === "council.continue.failed")?.fields).toMatchObject({
      council: "smoke",
      code: "STATE_ERROR",
    });
    expect(contRecords.find((r) => r.message === "council.error")?.fields).toMatchObject({
      code: "STATE_ERROR",
    });

    // continue with a traversal-escaping <council> is rejected by the path guard
    // (ConfigError) before any resume work, exit 1.
    process.exitCode = 0;
    const { logger: escLogger, records: escRecords } = createCapturingLogger();
    await main(["node", "council", "continue", "../escape"], { logger: escLogger, baseDir });
    expect(process.exitCode).toBe(1);
    expect(escRecords.find((r) => r.message === "council.error")?.fields).toMatchObject({
      code: "CONFIG_ERROR",
    });

    // `--force` is a recognized flag: it parses without a Commander error (it still
    // fails STATE_ERROR for the un-run 'smoke', proving the flag reached the action).
    process.exitCode = 0;
    const { logger: forceLogger, records: forceRecords } = createCapturingLogger();
    await main(["node", "council", "continue", "smoke", "--force"], {
      logger: forceLogger,
      baseDir,
    });
    expect(forceRecords.some((r) => r.message === "council.continue")).toBe(true);
    expect(forceRecords.find((r) => r.message === "council.error")?.fields).toMatchObject({
      code: "STATE_ERROR",
    });
  });

  // Thread-2/3 fix — exitOverride() stops Commander from calling process.exit(),
  // and main() honors the CommanderError exitCode: --help/--version exit 0 with
  // NO council.error log; a missing required option is handled in-process (the
  // test survives, proving no process.exit) and exits non-zero with an error log.
  it("honors Commander exit semantics: help/version exit 0, missing option exits non-zero", async () => {
    // Commander writes help/version to stdout; suppress it for clean output.
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // --help → exit 0, no council.error.
    process.exitCode = 0;
    const { logger: helpLogger, records: helpRecords } = createCapturingLogger();
    await main(["node", "council", "--help"], { logger: helpLogger, baseDir });
    expect(process.exitCode).toBe(0);
    expect(helpRecords.some((r) => r.message === "council.error")).toBe(false);

    // --version → exit 0, no council.error.
    process.exitCode = 0;
    const { logger: verLogger, records: verRecords } = createCapturingLogger();
    await main(["node", "council", "--version"], { logger: verLogger, baseDir });
    expect(process.exitCode).toBe(0);
    expect(verRecords.some((r) => r.message === "council.error")).toBe(false);

    // Missing required --cwd/--role → handled in-process, exits non-zero with a
    // council.error log (the action never runs, so no add-member entry log).
    process.exitCode = 0;
    const { logger: missLogger, records: missRecords } = createCapturingLogger();
    await main(["node", "council", "add-member", "demo", "bob"], { logger: missLogger, baseDir });
    expect(process.exitCode).not.toBe(0);
    expect(missRecords.some((r) => r.message === "council.error")).toBe(true);
    expect(missRecords.some((r) => r.message === "council.add-member")).toBe(false);
  });
});
