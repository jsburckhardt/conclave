import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

// Mock ONLY `rename` so the failure sub-case can force a post-write rename
// rejection while every other fs call delegates to the real implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  };
});

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-write-"));
  tempDirs.push(dir);
  return dir;
}

function tempFiles(dir: string): Promise<string[]> {
  return readdir(dir).then((entries) => entries.filter((e) => e.endsWith(".tmp")));
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

describe("atomicWriteFile", () => {
  // TP-02: write + overwrite leave no orphan temp; a forced rename failure
  // propagates the original error and orphans no temp file.
  it("TP-02: writes, overwrites in place, and leaves no orphan temp file", async () => {
    const dir = await makeDir();
    const target = join(dir, "f.json");

    await atomicWriteFile(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
    expect(await tempFiles(dir)).toEqual([]);

    await atomicWriteFile(target, "world");
    expect(await readFile(target, "utf8")).toBe("world");
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("TP-02: propagates the original error and orphans no temp on a rename failure", async () => {
    const dir = await makeDir();
    const target = join(dir, "f.json");
    await atomicWriteFile(target, "before");

    vi.mocked(rename).mockRejectedValueOnce(new Error("rename boom"));
    await expect(atomicWriteFile(target, "after")).rejects.toThrow("rename boom");

    // The original target is untouched and no temp file remains.
    expect(await readFile(target, "utf8")).toBe("before");
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("TP-02: rejects (and orphans no temp) when the parent directory is absent", async () => {
    const dir = await makeDir();
    const target = join(dir, "missing", "f.json");
    await expect(atomicWriteFile(target, "x")).rejects.toBeInstanceOf(Error);
    // The non-existent parent dir means nothing is left behind in `dir`.
    expect(await tempFiles(dir)).toEqual([]);
  });
});
