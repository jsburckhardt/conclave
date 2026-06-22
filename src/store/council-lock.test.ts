import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CouncilLock, councilConfigHash } from "./council-lock.js";
import { CouncilLock as RootLock, councilConfigHash as rootHash } from "../index.js";
import { StateError } from "../errors.js";

const tempDirs: string[] = [];

async function makeLockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-lock-"));
  tempDirs.push(dir);
  return join(dir, "council", "demo", ".council.lock");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("CouncilLock", () => {
  it("is exported from the package root", () => {
    expect(RootLock).toBe(CouncilLock);
  });

  // TP-08: acquire / conflict / --force / release.
  it("TP-08: acquires, rejects a second acquire, --force clears, release is idempotent", async () => {
    const lockPath = await makeLockPath();

    const a = new CouncilLock(lockPath);
    await a.acquire();
    expect(await exists(lockPath)).toBe(true);

    // The lock file carries diagnostic JSON.
    const info = JSON.parse(await readFile(lockPath, "utf8"));
    expect(typeof info.pid).toBe("number");
    expect(typeof info.hostname).toBe("string");
    expect(typeof info.startedAt).toBe("string");

    // A second acquire while held → StateError (lock conflict).
    const b = new CouncilLock(lockPath);
    const err = await b.acquire().then(
      () => {
        throw new Error("expected acquire() to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StateError);
    expect((err as StateError).code).toBe("STATE_ERROR");
    expect((err as Error).message).toContain("--force");

    // --force clears the stale lock and succeeds.
    await b.acquire(true);
    expect(await exists(lockPath)).toBe(true);

    // release removes the file; a second release is a safe no-op.
    await b.release();
    expect(await exists(lockPath)).toBe(false);
    await b.release();
    expect(await exists(lockPath)).toBe(false);

    // After release the lock can be re-acquired.
    await a.acquire();
    expect(await exists(lockPath)).toBe(true);
    await a.release();
  });

  // Thread #2: a non-EEXIST acquire failure is surfaced as a typed StateError.
  it("wraps an unexpected (non-EEXIST) acquire failure in StateError", async () => {
    const lockPath = await makeLockPath();
    const lockDir = dirname(lockPath);
    await mkdir(lockDir, { recursive: true });
    // Make the lock's directory read-only so the `wx` create fails with EACCES
    // (a non-EEXIST error), exercising the typed-wrap branch.
    await chmod(lockDir, 0o555);

    try {
      const lock = new CouncilLock(lockPath);
      const err = await lock.acquire().then(
        () => {
          throw new Error("expected acquire() to reject");
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StateError);
      expect((err as StateError).code).toBe("STATE_ERROR");
      expect((err as Error).message).toContain("Failed to acquire council lock");
    } finally {
      // Restore write permission so afterEach cleanup can remove the temp dir.
      await chmod(lockDir, 0o755);
    }
  });
});

describe("councilConfigHash", () => {
  it("is exported from the package root", () => {
    expect(rootHash).toBe(councilConfigHash);
  });

  // TP-09: deterministic + change-sensitive hex digest.
  it("TP-09: is deterministic and change-sensitive", () => {
    const h1 = councilConfigHash("a: 1");
    const h2 = councilConfigHash("a: 1");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(councilConfigHash("a: 1")).not.toBe(councilConfigHash("a: 2"));
  });
});
