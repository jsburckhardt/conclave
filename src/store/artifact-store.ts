import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Writes durable council artifacts (backlog, decisions, open questions) under a
 * base directory. Relative paths resolve against `baseDir`.
 */
export class ArtifactStore {
  constructor(private readonly baseDir: string) {}

  async write(relativePath: string, content: string): Promise<string> {
    const fullPath = resolve(this.baseDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  }
}
