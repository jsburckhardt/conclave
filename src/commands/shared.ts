import { readFile } from "node:fs/promises";
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
