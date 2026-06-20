import { describe, it, expect } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

describe("ArtifactStore", () => {
  let baseDir: string;

  it("writes artifacts under baseDir", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore(baseDir);
    const path = await store.write("notes/meeting.md", "# Notes");
    const content = await readFile(path, "utf8");
    expect(content).toBe("# Notes");
    expect(path).toBe(join(baseDir, "notes/meeting.md"));
    await rm(baseDir, { recursive: true });
  });

  it("rejects path traversal via .. segments", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore(baseDir);
    await expect(store.write("../escape.txt", "evil")).rejects.toThrow(/Path traversal denied/);
    await rm(baseDir, { recursive: true });
  });

  it("rejects absolute paths that escape baseDir", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "artifact-test-"));
    const store = new ArtifactStore(baseDir);
    await expect(store.write("/tmp/evil.txt", "evil")).rejects.toThrow(/Path traversal denied/);
    await rm(baseDir, { recursive: true });
  });
});
