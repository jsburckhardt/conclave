# CORE-COMPONENT-0008: Error Handling

## Status

Adopted

## Purpose

Failures in a council run (bad config, session failure) must be distinguishable and actionable. A typed error hierarchy with stable codes lets callers, logs, and the CLI branch on machine-readable identifiers instead of string matching.

## Scope

Affects all modules that raise or handle errors (`src/errors.ts` and its consumers). Boundaries: this component defines the error taxonomy; it does not dictate retry or recovery strategy.

## Definition

### Rules
- All domain errors extend `CouncilError`, which carries a stable string `code` and supports an optional `cause`.
- Configuration failures raise `ConfigError` (`code: "CONFIG_ERROR"`).
- Session/runtime failures raise `SessionError` (`code: "SESSION_ERROR"`).
- Council phase-orchestration failures raise `OrchestrationError` (`code: "ORCHESTRATION_ERROR"`).
- Underlying errors are preserved via the standard `cause` option, never swallowed. Failures from non-typed throwers (e.g. `ArtifactStore.write`, which throws a plain `Error`) are wrapped in the most specific `CouncilError` subclass before propagating.
- Error messages are human-actionable and name the offending entity (file, member, field).

### Interfaces
- `class CouncilError extends Error { readonly code: string }`
- `class ConfigError extends CouncilError`
- `class SessionError extends CouncilError`
- `class OrchestrationError extends CouncilError` (`code: "ORCHESTRATION_ERROR"`)
- Constructors accept `(message, options?: { cause?: unknown })`.

### Expectations

- New error categories extend `CouncilError` with a new stable `code`.
- All `CouncilError` subclasses (including `OrchestrationError`) are exported from `src/index.ts`.
- The CLI top-level handler logs `error` records and sets a non-zero exit code, including the `code` field when the error is a `CouncilError`.

## Rationale

Subclassing the native `Error` with a `code` keeps interop with standard tooling while enabling typed `instanceof` checks and structured logging.

## Usage Examples

```ts
import { ConfigError } from "conclave";

try {
  await loadCouncilConfig("council.yaml");
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.code, err.message);
  }
}
```

## Integration Guidelines

- Throw the most specific `CouncilError` subclass; attach `cause` when wrapping a lower-level error.
- Wrap failures from non-typed throwers (e.g. `ArtifactStore.write`) in `OrchestrationError`, preserving the original via `cause`.
- Catch by `instanceof` and branch on `code`, not on message text.

## Exceptions

- Programmer errors (invariant violations) may use plain `Error`.

## Enforcement

- [x] Automated checks (`src/errors.test.ts`)
- [x] Code review checklist
- [x] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
