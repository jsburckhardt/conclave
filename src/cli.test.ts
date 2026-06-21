import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI hermetically via tsx (no build step required). The orchestrator's
 * success path and the role-resolution OrchestrationError path require a live
 * Copilot SDK session (`runtime.start()` creates real sessions before role
 * resolution), so only the deterministic config-load failure path is exercised
 * here; the SDK-dependent paths are covered at unit level (TP-07/08/09/18/19).
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

describe("council run CLI smoke (TP-25)", () => {
  it("exits non-zero and logs council.error with a code on a CouncilError failure", async () => {
    const missingConfig = join(process.cwd(), "does-not-exist", "council.yaml");
    const { code, stderr } = await runCli(["run", "demo", "-c", missingConfig]);

    expect(code).not.toBe(0);

    const errorLine = stderr
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.message === "council.error");

    expect(errorLine).toBeDefined();
    // Q6: the top-level catch attaches `code` for any CouncilError subclass.
    expect(typeof errorLine?.code).toBe("string");
    expect(errorLine?.code).toBe("CONFIG_ERROR");
    expect(typeof errorLine?.error).toBe("string");
  }, 30000);
});
