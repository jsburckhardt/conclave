# CORE-COMPONENT-0005: Logging and Observability

## Status

Adopted

## Purpose

Council runs coordinate multiple agents over multiple rounds. Without consistent, structured logging the process is opaque. A shared logger makes every run observable and machine-parseable without adopting a heavyweight logging framework.

## Scope

Affects all runtime and CLI code that needs to report progress or errors. Boundaries: this component standardizes log emission only; durable council memory belongs to CORE-COMPONENT-0006.

## Definition

### Rules
- Logging goes through `createLogger()` (`src/logging/logger.ts`); modules do not call `console.log` directly.
- Each log record is a single line of JSON with `ts`, `level`, `message`, and arbitrary structured `fields`.
- Levels are `debug | info | warn | error`; `warn`/`error` are written to stderr, `info`/`debug` to stdout.
- Log messages use stable dotted event names (e.g. `session.created`, `council.run`).

### Interfaces
- `createLogger(minLevel?: LogLevel): Logger`
- `interface Logger { debug/info/warn/error(message: string, fields?: LogFields): void }`

### Expectations
- Logs are structured key/value data, not interpolated prose.
- A logger may be injected into `CouncilRuntime`; if omitted it defaults to an `info`-level logger.

## Rationale

Line-delimited JSON is trivially greppable and ingestible by log pipelines, and requires zero dependencies — appropriate for v0. A richer telemetry backend can wrap the same `Logger` interface later.

## Usage Examples

```ts
import { createLogger } from "conclave";

const logger = createLogger("debug");
logger.info("council.run", { council: "scrum-project-x", members: 2 });
```

## Integration Guidelines

- Use dotted, stable event names as the `message`; put variable data in `fields`.
- Inject the logger into long-lived components rather than creating ad hoc instances.

## Exceptions

- The CLI may write plain human-facing strings to stderr for usage/`notImplemented` messages.

## Enforcement

- [x] Automated checks (lint forbids stray patterns; runtime emits structured events)
- [x] Code review checklist
- [ ] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
