import { readFile } from "node:fs/promises";
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
