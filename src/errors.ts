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
