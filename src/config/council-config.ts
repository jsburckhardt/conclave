import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { ConfigError } from "../errors.js";

export type MemberTools = "read-only" | "read-write";

export interface MemberConfig {
  id: string;
  cwd: string;
  role: string;
  agent?: string;
  tools: MemberTools;
}

export interface OrchestratorPolicy {
  maxRounds?: number;
  requireProjectValidation?: boolean;
  writeArtifacts?: boolean;
}

export interface OrchestratorConfig {
  cwd: string;
  model?: string;
  policy?: OrchestratorPolicy;
}

export interface CouncilConfig {
  name: string;
  goal: string;
  members: MemberConfig[];
  orchestrator: OrchestratorConfig;
  artifacts: string[];
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(message);
  }
  return value as Record<string, unknown>;
}

function validateMember(value: unknown, index: number): MemberConfig {
  const member = asRecord(value, `Member at index ${index} must be a mapping`);
  if (typeof member.id !== "string" || member.id.length === 0) {
    throw new ConfigError(`Member at index ${index} requires a non-empty 'id'`);
  }
  if (typeof member.cwd !== "string" || member.cwd.length === 0) {
    throw new ConfigError(`Member '${member.id}' requires a 'cwd'`);
  }
  if (typeof member.role !== "string" || member.role.length === 0) {
    throw new ConfigError(`Member '${member.id}' requires a 'role'`);
  }
  return {
    id: member.id,
    cwd: member.cwd,
    role: member.role,
    agent: typeof member.agent === "string" ? member.agent : undefined,
    tools: member.tools === "read-write" ? "read-write" : "read-only",
  };
}

/**
 * Validate an already-parsed council configuration object, returning a fully
 * normalized {@link CouncilConfig}. Throws {@link ConfigError} on any problem.
 */
export function validateCouncilConfig(data: unknown): CouncilConfig {
  const root = asRecord(data, "Council config must be a YAML mapping");
  if (typeof root.name !== "string" || root.name.length === 0) {
    throw new ConfigError("Council config requires a non-empty 'name'");
  }
  if (typeof root.goal !== "string" || root.goal.length === 0) {
    throw new ConfigError("Council config requires a non-empty 'goal'");
  }
  if (!Array.isArray(root.members) || root.members.length === 0) {
    throw new ConfigError("Council config requires at least one member");
  }
  const orchestrator = asRecord(
    root.orchestrator,
    "Council config requires an 'orchestrator' section",
  );
  if (typeof orchestrator.cwd !== "string" || orchestrator.cwd.length === 0) {
    throw new ConfigError("Orchestrator requires a 'cwd'");
  }

  return {
    name: root.name,
    goal: root.goal,
    members: root.members.map(validateMember),
    orchestrator: {
      cwd: orchestrator.cwd,
      model: typeof orchestrator.model === "string" ? orchestrator.model : undefined,
      policy:
        typeof orchestrator.policy === "object" && orchestrator.policy !== null
          ? (orchestrator.policy as OrchestratorPolicy)
          : undefined,
    },
    artifacts: Array.isArray(root.artifacts) ? root.artifacts.map(String) : [],
  };
}

/**
 * Read and validate a council.yaml file from disk.
 */
export async function loadCouncilConfig(path: string): Promise<CouncilConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`Unable to read council config at ${path}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (cause) {
    throw new ConfigError(`Invalid YAML in council config at ${path}`, { cause });
  }

  return validateCouncilConfig(parsed);
}

/** Conservative ASCII allowlist for council names, shared with `council init`. */
const COUNCIL_NAME_ALLOWLIST = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a council `name` (the user-visible `<council>` argument) before it is
 * turned into an on-disk path. Rejects empty / whitespace-only names, null
 * bytes, path separators (`/` or `\`), exactly `.`/`..`, and any name outside
 * the conservative allowlist. This is the single source of truth for what a
 * valid council identity is, shared by `council init` (CORE-COMPONENT-0006) and
 * {@link resolveCouncilConfigPath} so both agree — without it, a `<council>`
 * containing separators (e.g. `demo/../other`) would normalize to a *different*
 * directory than the literal argument and silently read/write the wrong council.
 * Each failure throws a {@link ConfigError} (CORE-COMPONENT-0008) naming the
 * offending `name`. Performs **no** filesystem IO.
 */
export function validateCouncilName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ConfigError(
      `Invalid council name '${name}': a non-empty, non-whitespace name is required`,
    );
  }
  if (name.includes("\u0000")) {
    throw new ConfigError(`Invalid council name '${name}': name must not contain a null byte`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new ConfigError(
      `Invalid council name '${name}': name must not contain a path separator ('/' or '\\')`,
    );
  }
  if (name === "." || name === "..") {
    throw new ConfigError(`Invalid council name '${name}': name must not be '.' or '..'`);
  }
  if (!COUNCIL_NAME_ALLOWLIST.test(name)) {
    throw new ConfigError(
      `Invalid council name '${name}': only letters, digits, '.', '_', and '-' are allowed`,
    );
  }
}

/**
 * Resolve the canonical on-disk path of a council's `council.yaml`
 * (CORE-COMPONENT-0003). This is the single source of truth for where a council
 * lives on disk: `council/<council>/council.yaml`, relative to `baseDir` (which
 * defaults to `process.cwd()` and is injectable for hermetic tests).
 *
 * The `<council>` argument is first validated with {@link validateCouncilName}
 * (rejecting separators, `.`/`..`, null bytes, and non-allowlisted names) so it
 * can never silently address a different directory than the literal argument.
 * A defense-in-depth traversal guard then follows — the refined variant shared
 * with `council init`'s `resolveCouncilPaths` (CORE-COMPONENT-0006) — rejecting
 * only real escapes: an empty relative path, exactly `..`, or a relative path
 * that starts with `..` followed by a path separator (`../` on POSIX, `..\` on
 * Windows). A bare `startsWith("..")` would over-reject allowlisted names such
 * as `..a` or `...` that resolve to a real directory strictly inside the
 * council root. Escapes raise {@link ConfigError} (CORE-COMPONENT-0008) naming
 * the offending `<council>` value. The function performs **no** filesystem IO.
 */
export function resolveCouncilConfigPath(council: string, baseDir: string = process.cwd()): string {
  validateCouncilName(council);
  const councilBase = resolve(baseDir, "council");
  const councilDir = resolve(councilBase, council);
  const rel = relative(councilBase, councilDir);
  if (rel.length === 0 || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new ConfigError(
      `Invalid council '${council}': resolves outside the council base directory`,
    );
  }
  return join(councilDir, "council.yaml");
}
