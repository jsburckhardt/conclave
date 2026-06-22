import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically replace `targetPath` with `content`: write a uniquely named temp
 * file in the **same directory** (so `rename` stays same-filesystem, avoiding
 * `EXDEV`), then `rename` it over the original. The unique name
 * (`.<base>.<pid>.<uuid>.tmp`) guarantees two concurrent writers can never share
 * a temp file. On any error the temp file is removed (best-effort) and the
 * original error re-thrown, so the target is left untouched. `fsync` is
 * intentionally omitted for v0 (POSIX dev-container assumption).
 *
 * Shared internal helper (CORE-COMPONENT-0006) used by both `add-member` and
 * `CouncilStateStore`; not re-exported from `src/index.ts`.
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, targetPath);
  } catch (cause) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}
