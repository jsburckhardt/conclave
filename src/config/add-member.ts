import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { ConfigError, CouncilError } from "../errors.js";
import {
  resolveCouncilConfigPath,
  validateCouncilConfig,
  type MemberConfig,
  type MemberTools,
} from "./council-config.js";
import { createLogger, type Logger } from "../logging/logger.js";

/**
 * Options for {@link addMember}. Scalar fields mirror the `council add-member`
 * CLI surface. `tools` is intentionally typed as a loose `string` because it
 * arrives as untrusted CLI input and is **validated** (never coerced) at
 * runtime; the central validator (CORE-COMPONENT-0003) would otherwise silently
 * coerce an unknown value to `read-only`.
 */
export interface AddMemberOptions {
  /** Council name → `council/<council>/council.yaml`. */
  council: string;
  /** Member id (becomes a session-id path segment; strict charset). */
  memberId: string;
  /** Member working directory (`--cwd`; required, non-empty after trim). */
  cwd: string;
  /** Member role (`--role`; required, non-empty after trim). */
  role: string;
  /** Optional agent name (`--agent`). */
  agent?: string;
  /** Capability (`--tools`); `read-only`/`read-write`, default `read-only`. */
  tools?: string;
  /** Base directory; defaults to `process.cwd()`. Injected in tests. */
  baseDir?: string;
  /** Structured logger; defaults to {@link createLogger}. Injected in tests. */
  logger?: Logger;
}

/**
 * `memberId` must start alphanumeric, then allow `.`, `_`, `-`. This is stricter
 * than init's council-name allowlist because `memberId` becomes a path segment
 * in the stable session id `"<councilId>/<memberId>"` (CORE-COMPONENT-0004), so
 * `.`/`..`-style ids must be forbidden.
 */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Trim then require a non-empty string; raise a field-naming {@link ConfigError}. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`Invalid '${field}': a non-empty, non-whitespace string is required`);
  }
  return value.trim();
}

/**
 * Validate `--tools`: exactly `read-only`/`read-write`, defaulting to
 * `read-only` when omitted (CORE-COMPONENT-0007). Anything else is rejected
 * (not silently coerced).
 */
function validateTools(value: unknown): MemberTools {
  if (value === undefined) {
    return "read-only";
  }
  if (value === "read-only" || value === "read-write") {
    return value;
  }
  throw new ConfigError(
    `Invalid 'tools' value '${String(value)}': must be 'read-only' or 'read-write'`,
  );
}

/**
 * Normalize and validate the scalar member inputs (trim **then** check). The
 * central validator accepts whitespace-only `cwd`/`role`, silently coerces an
 * invalid `tools`, and does not enforce a `memberId` charset, so `add-member`
 * compensates with stricter, field-naming validation before any IO.
 */
function validateMemberInput(options: AddMemberOptions): MemberConfig {
  const id = requireNonEmptyString(options.memberId, "memberId");
  if (!MEMBER_ID_PATTERN.test(id)) {
    throw new ConfigError(
      `Invalid 'memberId' '${id}': must match ${MEMBER_ID_PATTERN.source} ` +
        `(start with a letter or digit; then letters, digits, '.', '_', '-')`,
    );
  }
  const cwd = requireNonEmptyString(options.cwd, "cwd");
  const role = requireNonEmptyString(options.role, "role");
  const tools = validateTools(options.tools);

  const member: MemberConfig = { id, cwd, role, tools };
  if (typeof options.agent === "string" && options.agent.trim().length > 0) {
    member.agent = options.agent.trim();
  }
  return member;
}

/**
 * Pure edit: append a (pre-validated) member to a parsed Document's `members`
 * sequence, preserving comments, key order, and unknown/forward-compat keys
 * (CORE-COMPONENT-0003). Throws a conflict {@link ConfigError} on a
 * case-sensitive, trimmed duplicate id (the doc is left unmutated), and a
 * structural {@link ConfigError} when `members` is absent or not a sequence.
 * Performs no IO.
 */
export function applyAddMember(doc: Document, member: MemberConfig): void {
  const members = doc.get("members");
  if (!isSeq(members)) {
    throw new ConfigError(
      "Council config requires a 'members' sequence before a member can be added",
    );
  }

  const newId = member.id.trim();
  for (const item of members.items) {
    const existingId = isMap(item) ? item.get("id") : undefined;
    if (typeof existingId === "string" && existingId.trim() === newId) {
      throw new ConfigError(`Member id '${member.id}' already exists in this council`);
    }
  }

  const node: Record<string, string> = { id: member.id, cwd: member.cwd, role: member.role };
  if (member.agent !== undefined) {
    node.agent = member.agent;
  }
  node.tools = member.tools;
  members.add(node);
}

/**
 * Atomically replace `targetPath` with `content`: write a uniquely named temp
 * file in the **same directory** (so `rename` stays same-filesystem, avoiding
 * `EXDEV`), then `rename` it over the original. The unique name
 * (`.<base>.<pid>.<uuid>.tmp`) guarantees two concurrent writers can never share
 * a temp file. On any error the temp file is removed (best-effort) and the
 * original error re-thrown, so the target is left untouched. `fsync` is
 * intentionally omitted for v0 (POSIX dev-container assumption). Private,
 * single-use helper (not exported from `src/index.ts`).
 */
async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
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

/** Map any thrown value to a {@link CouncilError}, preserving `code` + `cause`. */
function toCouncilError(error: unknown): CouncilError {
  if (error instanceof CouncilError) {
    return error;
  }
  return new ConfigError(error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * Add a validated member to an existing council's `council.yaml`.
 *
 * The flow is **validate-then-persist** (the file is never left invalid or
 * partially written):
 * 1. Resolve the path via {@link resolveCouncilConfigPath} (traversal-guarded).
 * 2. Log entry `council.add-member { council, memberId }`.
 * 3. Validate scalar inputs (trim/charset/enum) before any IO.
 * 4. `readFile` → {@link ConfigError} naming the path if the dir/file is missing.
 * 5. `parseDocument` → {@link ConfigError} if the YAML is unparseable.
 * 6. {@link applyAddMember} → {@link ConfigError} on a duplicate id.
 * 7. Re-validate the edited document with `validateCouncilConfig` → on failure
 *    (including a pre-existing-invalid parseable file) {@link ConfigError}; no write.
 * 8. {@link atomicWriteFile} persists `String(doc)` (the edited document, never
 *    the normalized validator output).
 * 9. Log success `council.add-member.succeeded { council, memberId, tools }`.
 *
 * Any failure after entry emits `council.add-member.failed { council, memberId,
 * code }` before the typed error propagates, guaranteeing a non-zero exit (via
 * the top-level handler) and a byte-for-byte-unchanged file. No `console.log`.
 */
export async function addMember(options: AddMemberOptions): Promise<void> {
  const { council, memberId } = options;
  const baseDir = options.baseDir ?? process.cwd();
  const logger = options.logger ?? createLogger();

  logger.info("council.add-member", { council, memberId });

  try {
    // Resolve the path *inside* the try (after the entry log) so an invalid or
    // traversal-escaping <council> rejected by resolveCouncilConfigPath is still
    // recorded as council.add-member.failed, honoring the documented
    // entry/success/failure logging contract (CORE-COMPONENT-0005).
    const path = resolveCouncilConfigPath(council, baseDir);
    const member = validateMemberInput(options);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      throw new ConfigError(
        `Unable to read council config at ${path}; create the council first ` +
          `(council init ${council})`,
        { cause },
      );
    }

    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      throw new ConfigError(`Invalid YAML in council config at ${path}`, {
        cause: doc.errors[0],
      });
    }

    applyAddMember(doc, member);

    // Re-validate the FULL edited config; persist only when validation passes.
    // This also blocks a pre-existing-invalid (but parseable) council.yaml.
    validateCouncilConfig(doc.toJS());

    await atomicWriteFile(path, String(doc));

    logger.info("council.add-member.succeeded", { council, memberId, tools: member.tools });
  } catch (error) {
    const councilError = toCouncilError(error);
    logger.error("council.add-member.failed", { council, memberId, code: councilError.code });
    throw councilError;
  }
}
