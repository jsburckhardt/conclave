import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { StateError } from "../errors.js";

/**
 * Deterministic SHA-256 (hex) of the **raw `council.yaml` bytes**, used as
 * `state.json.configHash` to detect config drift between runs. Uses only
 * `node:crypto` (no new dependency, Q4/Q5).
 */
export function councilConfigHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Diagnostic payload stored inside `.council.lock`. */
interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
}

/** Type guard for Node `fs` errors carrying a string `code`. */
function hasErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code === code
  );
}

/**
 * An exclusive on-disk lock (`council/<slug>/.council.lock`) that prevents
 * concurrent `run`/`continue` of the same council from corrupting `state.json`
 * (CORE-COMPONENT-0006). Acquisition is TOCTOU-safe via an atomic `wx` create;
 * a conflict raises {@link StateError}. Only an explicit `--force` clears a
 * pre-existing (stale) lock. `release()` is best-effort and safe to call when
 * the lock is not held, so callers run it in a `finally` on every exit path.
 */
export class CouncilLock {
  constructor(private readonly filePath: string) {}

  /**
   * Acquire the lock. When `force` is true a pre-existing lock is removed first
   * (the caller logs `lock.forced`). Raises {@link StateError} when the lock is
   * already held and `force` is not set.
   */
  async acquire(force = false): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    if (force) {
      await rm(this.filePath, { force: true }).catch(() => undefined);
    }

    const info: LockInfo = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };

    try {
      await writeFile(this.filePath, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
    } catch (cause) {
      if (hasErrorCode(cause, "EEXIST")) {
        const slug = basename(dirname(this.filePath));
        throw new StateError(
          `Another run/continue is in progress for council '${slug}' (lock at ${this.filePath}). ` +
            `If no process is running, re-run with --force.`,
          { cause },
        );
      }
      // Any non-EEXIST failure (EACCES, ENOSPC, …) is still a run-state failure;
      // surface it as a typed StateError carrying a stable code and the original
      // cause (review thread #2) rather than leaking an untyped exception.
      throw new StateError(`Failed to acquire council lock at ${this.filePath}`, { cause });
    }
  }

  /** Best-effort lock removal; a no-op when the file is absent (idempotent). */
  async release(): Promise<void> {
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }
}
