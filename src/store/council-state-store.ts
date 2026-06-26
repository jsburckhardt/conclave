import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { StateError } from "../errors.js";
import { atomicWriteFile } from "./atomic-write.js";

/**
 * The only `state.json` schema version supported in v0. Any other value (older,
 * newer, missing, or non-integer) is a {@link StateError} on read — there is no
 * best-effort upcasting (CORE-COMPONENT-0006).
 */
export const STATE_SCHEMA_VERSION = 1;

/** Run-lifecycle status persisted in `state.json`. */
export type CouncilStatus = "in-progress" | "completed";

/** The fixed v0 phase names a run can checkpoint at (CORE-COMPONENT-0004). */
export type CouncilPhase = "context" | "draft" | "validation" | "refinement" | "artifacts";

/** A member's session registry entry: id + the stable `"<councilId>/<id>"` session id. */
export interface CouncilStateMember {
  id: string;
  sessionId: string;
}

/**
 * The minimal durable work products needed to resume mid-flow without re-running
 * completed phases (Plan extension; research R2).
 */
export interface CouncilStateProducts {
  /** Context summary; present once the context phase completed (consumed by draft). */
  summary?: string;
  /** Backlog; present once draft completed and updated each refinement round. */
  backlog?: string;
  /** Round validation feedback; present transiently when refinement is pending. */
  validation?: string;
}

/** The full persisted run state (`council/<slug>/state.json`). */
export interface CouncilState {
  schemaVersion: number;
  councilId: string;
  status: CouncilStatus;
  lastPhase: CouncilPhase | null;
  lastRound: number;
  members: CouncilStateMember[];
  configHash: string;
  createdAt: string;
  updatedAt: string;
  products?: CouncilStateProducts;
}

const STATUS_VALUES: readonly CouncilStatus[] = ["in-progress", "completed"];
const PHASE_VALUES: readonly CouncilPhase[] = [
  "context",
  "draft",
  "validation",
  "refinement",
  "artifacts",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Type guard for Node `fs` errors carrying a string `code`. */
function hasErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code === code
  );
}

/**
 * Validate the optional `products` checkpoint: a mapping whose `summary`,
 * `backlog`, and `validation` fields (each optional) must be strings when
 * present. Throws {@link StateError} naming the file on any violation.
 */
function validateProducts(value: unknown, path: string): CouncilStateProducts | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new StateError(`Corrupt state file ${path}: 'products' must be a mapping`);
  }
  const products: CouncilStateProducts = {};
  for (const key of ["summary", "backlog", "validation"] as const) {
    const field = value[key];
    if (field === undefined) {
      continue;
    }
    if (typeof field !== "string") {
      throw new StateError(`Corrupt state file ${path}: 'products.${key}' must be a string`);
    }
    products[key] = field;
  }
  return products;
}

/**
 * Validate a parsed object against the {@link CouncilState} schema and return a
 * clean, typed state. Order matters: `schemaVersion` is checked first so an
 * unknown/newer schema yields an unsupported-schema message rather than a
 * generic corrupt-field one. Every failure raises {@link StateError} naming the
 * file (CORE-COMPONENT-0008); a corrupt file is never coerced to an empty state.
 */
function validateState(parsed: unknown, path: string): CouncilState {
  if (!isRecord(parsed)) {
    throw new StateError(`Corrupt state file ${path}: expected a JSON object`);
  }

  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new StateError(
      `Unsupported state schemaVersion ${JSON.stringify(parsed.schemaVersion)} in ${path}: ` +
        `this build supports schemaVersion ${STATE_SCHEMA_VERSION} only.`,
    );
  }

  if (!isNonEmptyString(parsed.councilId)) {
    throw new StateError(`Corrupt state file ${path}: 'councilId' must be a non-empty string`);
  }
  if (!STATUS_VALUES.includes(parsed.status as CouncilStatus)) {
    throw new StateError(
      `Corrupt state file ${path}: 'status' must be one of ${STATUS_VALUES.join(", ")}`,
    );
  }
  if (parsed.lastPhase !== null && !PHASE_VALUES.includes(parsed.lastPhase as CouncilPhase)) {
    throw new StateError(
      `Corrupt state file ${path}: 'lastPhase' must be null or one of ${PHASE_VALUES.join(", ")}`,
    );
  }
  if (
    typeof parsed.lastRound !== "number" ||
    !Number.isInteger(parsed.lastRound) ||
    parsed.lastRound < 0
  ) {
    throw new StateError(`Corrupt state file ${path}: 'lastRound' must be a non-negative integer`);
  }
  if (!Array.isArray(parsed.members)) {
    throw new StateError(`Corrupt state file ${path}: 'members' must be an array`);
  }
  const members: CouncilStateMember[] = parsed.members.map((entry, index) => {
    if (!isRecord(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.sessionId)) {
      throw new StateError(
        `Corrupt state file ${path}: member at index ${index} requires string 'id' and 'sessionId'`,
      );
    }
    return { id: entry.id, sessionId: entry.sessionId };
  });
  if (!isNonEmptyString(parsed.configHash)) {
    throw new StateError(`Corrupt state file ${path}: 'configHash' must be a non-empty string`);
  }
  if (!isNonEmptyString(parsed.createdAt)) {
    throw new StateError(`Corrupt state file ${path}: 'createdAt' must be a non-empty string`);
  }
  if (!isNonEmptyString(parsed.updatedAt)) {
    throw new StateError(`Corrupt state file ${path}: 'updatedAt' must be a non-empty string`);
  }

  const products = validateProducts(parsed.products, path);

  const state: CouncilState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    councilId: parsed.councilId,
    status: parsed.status as CouncilStatus,
    lastPhase: parsed.lastPhase as CouncilPhase | null,
    lastRound: parsed.lastRound,
    members,
    configHash: parsed.configHash,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
  if (products !== undefined) {
    state.products = products;
  }
  return state;
}

/**
 * Reads/writes a council's durable run state (`council/<slug>/state.json`) with
 * **no orchestration logic** (CORE-COMPONENT-0006). Writes are atomic (temp file
 * + `rename`) and create the parent dir; reads validate the schema and raise a
 * typed {@link StateError} for a missing, corrupt, or version-incompatible file —
 * never silently returning a fresh/empty state (research R4).
 */
export class CouncilStateStore {
  constructor(private readonly filePath: string) {}

  /** Best-effort existence check used by the producer/idempotent paths. */
  async exists(): Promise<boolean> {
    try {
      await stat(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Atomically persist `state`, creating the parent directory (`mkdir -p`). A
   * reader can never observe a partially written `state.json`.
   */
  async write(state: CouncilState): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await atomicWriteFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (cause) {
      // Normalize raw fs/atomic-write failures (EACCES, ENOSPC, …) to a typed
      // StateError naming the file, mirroring read() so run-state persistence
      // errors are consistently typed (review thread #3).
      throw new StateError(`Unable to write state file ${this.filePath}`, { cause });
    }
  }

  /**
   * Read and validate the persisted state. Raises {@link StateError} for a
   * missing file (actionable "no prior run; run `council run` first"), invalid
   * JSON, an unknown/newer `schemaVersion`, or any failed field check.
   */
  async read(): Promise<CouncilState> {
    const slug = basename(dirname(this.filePath));
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (hasErrorCode(cause, "ENOENT")) {
        throw new StateError(
          `No prior run found for council '${slug}' (no state file at ${this.filePath}). ` +
            `Run \`council run ${slug}\` first.`,
          { cause },
        );
      }
      throw new StateError(`Unable to read state file ${this.filePath}`, { cause });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new StateError(`Corrupt state file ${this.filePath}: invalid JSON`, { cause });
    }

    return validateState(parsed, this.filePath);
  }
}
