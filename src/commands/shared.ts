import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
import { ConfigError, CouncilError } from "../errors.js";
import { validateCouncilConfig, type CouncilConfig } from "../config/council-config.js";
import type { CouncilStateMember } from "../store/council-state-store.js";

/**
 * Read and validate a `council.yaml`, returning both the typed {@link CouncilConfig}
 * and the **raw bytes** (needed for `configHash`). Mirrors `loadCouncilConfig`'s
 * error handling but additionally exposes the raw text so `run`/`continue` can hash
 * the exact on-disk config. Shared internal helper (not exported from `src/index.ts`).
 */
export async function loadConfigWithRaw(
  configPath: string,
): Promise<{ config: CouncilConfig; raw: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (cause) {
    throw new ConfigError(`Unable to read council config at ${configPath}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (cause) {
    throw new ConfigError(`Invalid YAML in council config at ${configPath}`, { cause });
  }

  return { config: validateCouncilConfig(parsed), raw };
}

/**
 * Resolve the effective `council.yaml` path for `continue`, honoring an optional
 * `-c/--config` override while keeping it **inside** the resolved council
 * directory (CORE-COMPONENT-0003, Q3). With no override the canonical
 * `council/<slug>/council.yaml` is used. An override (relative or absolute) is
 * resolved against `councilDir` and must not escape it: a `../` segment or an
 * absolute path that lands outside raises {@link ConfigError}
 * (CORE-COMPONENT-0008). An absolute path that already points inside the council
 * directory is accepted. This closes the traversal hole where `--config
 * ../../x` or `--config /etc/x` could read a file outside the council directory,
 * matching the guard in {@link resolveCouncilConfigPath}.
 */
export function resolveConfigPath(
  councilDir: string,
  canonicalConfigPath: string,
  configOverride?: string,
): string {
  if (configOverride === undefined) {
    return canonicalConfigPath;
  }
  const resolved = resolve(councilDir, configOverride);
  const rel = relative(councilDir, resolved);
  if (rel.length === 0 || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new ConfigError(
      `Invalid --config '${configOverride}': resolves outside the council directory ` +
        `'${councilDir}'.`,
    );
  }
  return resolved;
}

/** The stable session id convention `"<councilId>/<memberId>"` (CORE-COMPONENT-0004). */
export function sessionIdFor(councilId: string, memberId: string): string {
  return `${councilId}/${memberId}`;
}

/** Build the persisted member session registry from config (id + stable session id). */
export function memberRegistry(config: CouncilConfig): CouncilStateMember[] {
  return config.members.map((member) => ({
    id: member.id,
    sessionId: sessionIdFor(config.name, member.id),
  }));
}

/**
 * Enforce the council identity invariant `config.name === <council slug>`
 * (CORE-COMPONENT-0004, Q3). Any mismatch raises an actionable {@link ConfigError},
 * closing the path/identity divergence so sessions/artifacts (keyed on `config.name`)
 * and `state.json` (resolved from the slug) can never address different councils.
 */
export function assertCouncilIdentity(config: CouncilConfig, council: string): void {
  if (config.name !== council) {
    throw new ConfigError(
      `Council identity mismatch: council.yaml 'name' is '${config.name}' but the requested ` +
        `council is '${council}'. Rename the council or run against '${config.name}'.`,
    );
  }
}

/**
 * Map any thrown value to a {@link CouncilError}, preserving an existing typed
 * `code`/`cause` (mirrors the `add-member` precedent). Used by command top-level
 * catches so `*.failed` logs and re-throws carry a machine-readable code
 * (CORE-COMPONENT-0008); an unexpected non-typed error becomes a `ConfigError`.
 */
export function toCouncilError(error: unknown): CouncilError {
  if (error instanceof CouncilError) {
    return error;
  }
  return new ConfigError(error instanceof Error ? error.message : String(error), { cause: error });
}
