/**
 * Typed error hierarchy for Conclave. All council errors carry a stable `code`
 * so callers and logs can branch on machine-readable identifiers.
 */
export class CouncilError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CouncilError";
    this.code = code;
  }
}

export class ConfigError extends CouncilError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG_ERROR", options);
    this.name = "ConfigError";
  }
}

export class SessionError extends CouncilError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "SESSION_ERROR", options);
    this.name = "SessionError";
  }
}

export class OrchestrationError extends CouncilError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ORCHESTRATION_ERROR", options);
    this.name = "OrchestrationError";
  }
}

/**
 * Council run-state failures: a missing `state.json` (no prior run), a corrupt or
 * partially-written `state.json` (invalid JSON or a failed schema check), an
 * unknown/newer `schemaVersion`, or a concurrency-lock conflict. A single
 * `STATE_ERROR` code covers all of these; the specific condition and remedy live
 * in the message (CORE-COMPONENT-0008). A corrupt or absent state file is never
 * silently treated as an empty/fresh state.
 */
export class StateError extends CouncilError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "STATE_ERROR", options);
    this.name = "StateError";
  }
}
