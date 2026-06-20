# CORE-COMPONENT-0003: Configuration

## Status

Adopted

## Purpose

Every council is described by a declarative `council.yaml` (name, goal, members, orchestrator policy, artifacts). A single, validated configuration loader prevents malformed councils from reaching the runtime and gives every command one trustworthy shape to depend on.

## Scope

Affects any code path that reads council definitions: the CLI (`council run`/`continue`), the runtime, and future scaffolding (`council init`). Boundaries: this component parses and validates configuration only — it does not create sessions or write artifacts.

## Definition

### Rules
- `council.yaml` is parsed with the `yaml` package and validated before use.
- Validation is centralized in `validateCouncilConfig` (`src/config/council-config.ts`); `loadCouncilConfig` wraps file IO + parse + validate.
- Required fields: `name`, `goal`, at least one `members[]` entry (each with `id`, `cwd`, `role`), and an `orchestrator.cwd`.
- Members default to `tools: "read-only"` unless explicitly `"read-write"`.
- All validation failures raise `ConfigError` (see CORE-COMPONENT-0008) with an actionable message.

### Interfaces
- `loadCouncilConfig(path: string): Promise<CouncilConfig>`
- `validateCouncilConfig(data: unknown): CouncilConfig`
- Types: `CouncilConfig`, `MemberConfig`, `OrchestratorConfig`, `OrchestratorPolicy`.

### Expectations
- The returned `CouncilConfig` is fully normalized; downstream code never re-validates.
- Unknown/extra YAML keys are ignored rather than rejected.

## Rationale

Hand-written validation keeps v0 dependency-light while still producing typed, normalized output. A schema library (e.g. zod) can replace the internals later without changing the public interface.

## Usage Examples

```ts
import { loadCouncilConfig } from "conclave";

const config = await loadCouncilConfig("council.yaml");
console.log(config.name, config.members.length);
```

## Integration Guidelines

- Always obtain configuration via `loadCouncilConfig`/`validateCouncilConfig`; never parse `council.yaml` ad hoc.
- Treat `CouncilConfig` as read-only once loaded.

## Exceptions

- Tests may construct `CouncilConfig` objects directly instead of reading a file.

## Enforcement

- [x] Automated checks (`src/config/council-config.test.ts`)
- [x] Code review checklist
- [x] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
