import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

/**
 * Writes durable council artifacts (backlog, decisions, open questions) under a
 * base directory. Relative paths resolve against `baseDir`.
 *
 * Path traversal is prevented: any resolved path that escapes `baseDir` is
 * rejected with an error.
 */
export class ArtifactStore {
  constructor(private readonly baseDir: string) {}

  async write(relativePath: string, content: string): Promise<string> {
    const fullPath = resolve(this.baseDir, relativePath);
    const rel = relative(this.baseDir, fullPath);
    if (rel.startsWith("..") || resolve(fullPath) !== fullPath.replace(/\/$/, "")) {
      throw new Error(
        `Path traversal denied: '${relativePath}' resolves outside artifact base directory`,
      );
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return fullPath;
  }
}
