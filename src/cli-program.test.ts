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
    // notImplemented() writes plain text to stderr; suppress for clean output.
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

  // TP-19 — init/run/continue still behave correctly through the moved actions.
  it("init/run/continue behave correctly through main (TP-19)", async () => {
    // init scaffolds council/smoke/ and exits 0.
    process.exitCode = 0;
    const { logger: initLogger, records: initRecords } = createCapturingLogger();
    await main(["node", "council", "init", "smoke"], { logger: initLogger, baseDir });
    expect(process.exitCode).toBe(0);
    expect(await exists(join(baseDir, "council", "smoke", "council.yaml"))).toBe(true);
    expect(initRecords.some((r) => r.message === "council.init")).toBe(true);

    // run loads the config, logs council.run, then reports not-implemented (exit 1).
    process.exitCode = 0;
    const validConfigPath = join(baseDir, "council", "smoke", "council.yaml");
    const { logger: runLogger, records: runRecords } = createCapturingLogger();
    await main(["node", "council", "run", "smoke", "--config", validConfigPath], {
      logger: runLogger,
      baseDir,
    });
    expect(process.exitCode).toBe(1);
    expect(runRecords.some((r) => r.message === "council.run")).toBe(true);

    // continue logs council.continue, then reports not-implemented (exit 1).
    process.exitCode = 0;
    const { logger: contLogger, records: contRecords } = createCapturingLogger();
    await main(["node", "council", "continue", "smoke"], { logger: contLogger, baseDir });
    expect(process.exitCode).toBe(1);
    expect(contRecords.some((r) => r.message === "council.continue")).toBe(true);
  });
});
