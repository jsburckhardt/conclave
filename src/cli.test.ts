import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI hermetically via tsx (no build step required). `council run`
 * validates orchestrator policy and resolves roles BEFORE `runtime.start()`, so
 * the contradictory-policy and unresolvable-role error paths fail fast without a
 * live Copilot SDK session and are exercised here. The orchestrator's success
 * path and the SDK-dependent ask paths still require a live session and are
 * covered at unit level (TP-07/08/09/18/19).
 */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      { cwd: process.cwd() },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function findCouncilError(stderr: string): Record<string, unknown> | undefined {
  return stderr
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.message === "council.error");
}

async function writeTempConfig(
  yaml: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "council-cli-"));
  const path = join(dir, "council.yaml");
  await writeFile(path, yaml, "utf8");
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("council run CLI smoke (TP-25)", () => {
  it("exits non-zero and logs council.error with a code on a CouncilError failure", async () => {
    const missingConfig = join(process.cwd(), "does-not-exist", "council.yaml");
    const { code, stderr } = await runCli(["run", "demo", "-c", missingConfig]);

    expect(code).not.toBe(0);

    const errorLine = findCouncilError(stderr);

    expect(errorLine).toBeDefined();
    // Q6: the top-level catch attaches `code` for any CouncilError subclass.
    expect(typeof errorLine?.code).toBe("string");
    expect(errorLine?.code).toBe("CONFIG_ERROR");
    expect(typeof errorLine?.error).toBe("string");
  }, 30000);
});

describe("council run CLI fail-fast (pre-start validation)", () => {
  it("fails fast with ORCHESTRATION_ERROR on contradictory policy before starting the runtime", async () => {
    const { path, cleanup } = await writeTempConfig(
      [
        "name: hermetic-demo",
        "goal: verify fail-fast",
        "members:",
        "  - id: context-1",
        "    cwd: .",
        "    role: project context source of truth",
        "  - id: backlog-1",
        "    cwd: .",
        "    role: scrum backlog author",
        "orchestrator:",
        "  cwd: .",
        "  policy:",
        "    requireProjectValidation: true",
        "    maxRounds: 0",
        "",
      ].join("\n"),
    );
    try {
      const { code, stderr } = await runCli(["run", "demo", "-c", path]);
      expect(code).not.toBe(0);
      const errorLine = findCouncilError(stderr);
      expect(errorLine).toBeDefined();
      // normalizePolicy runs before runtime.start(); the contradiction surfaces
      // as a typed OrchestrationError without any SDK session being created.
      expect(errorLine?.code).toBe("ORCHESTRATION_ERROR");
    } finally {
      await cleanup();
    }
  }, 30000);

  it("fails fast with ORCHESTRATION_ERROR when roles cannot be resolved (single-member council)", async () => {
    const { path, cleanup } = await writeTempConfig(
      [
        "name: hermetic-demo",
        "goal: verify fail-fast",
        "members:",
        "  - id: solo",
        "    cwd: .",
        "    role: project context source of truth",
        "orchestrator:",
        "  cwd: .",
        "",
      ].join("\n"),
    );
    try {
      const { code, stderr } = await runCli(["run", "demo", "-c", path]);
      expect(code).not.toBe(0);
      const errorLine = findCouncilError(stderr);
      expect(errorLine).toBeDefined();
      // resolveRoles runs before runtime.start(); a single-member council cannot
      // yield two distinct roles, so it fails fast without an SDK session.
      expect(errorLine?.code).toBe("ORCHESTRATION_ERROR");
    } finally {
      await cleanup();
    }
  }, 30000);
});
