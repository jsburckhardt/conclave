# CORE-COMPONENT-0003: Configuration

## Status

Adopted (amended 2026-06-21 — added the `resolveCouncilConfigPath` locator and the canonical on-disk council layout; see DECISION-LOG decisions #17–#19).

## Purpose

Every council is described by a declarative `council.yaml` (name, goal, members, orchestrator policy, artifacts). A single, validated configuration loader prevents malformed councils from reaching the runtime and gives every command one trustworthy shape to depend on. The same component owns the canonical *location* of `council.yaml` on disk, so every command agrees on where a council lives.

## Scope

Affects any code path that reads, locates, or edits council definitions: the CLI (`council run`/`continue`/`add-member`), the runtime, and scaffolding (`council init`). Boundaries: this component parses, validates, and locates configuration only — it does not create sessions or write artifacts.

## Definition

### Rules
- `council.yaml` is parsed with the `yaml` package and validated before use.
- Validation is centralized in `validateCouncilConfig` (`src/config/council-config.ts`); `loadCouncilConfig` wraps file IO + parse + validate.
- Required fields: `name`, `goal`, at least one `members[]` entry (each with `id`, `cwd`, `role`), and an `orchestrator.cwd`.
- Members default to `tools: "read-only"` unless explicitly `"read-write"`.
- All validation failures raise `ConfigError` (see CORE-COMPONENT-0008) with an actionable message.
- A council's `council.yaml` lives at `council/<council>/council.yaml`, relative to a base directory that defaults to the process working directory.
- Commands resolve that path **only** via `resolveCouncilConfigPath(council, baseDir?)`; they never construct the `council.yaml` path ad hoc.
- `resolveCouncilConfigPath` applies a path-traversal guard and raises `ConfigError` when `<council>` would escape the `council/` root.

### Interfaces
- `loadCouncilConfig(path: string): Promise<CouncilConfig>`
- `validateCouncilConfig(data: unknown): CouncilConfig`
- `resolveCouncilConfigPath(council: string, baseDir?: string): string` — single source of truth for a council's on-disk `council.yaml` path.
- Types: `CouncilConfig`, `MemberConfig`, `OrchestratorConfig`, `OrchestratorPolicy`.

### Expectations
- The returned `CouncilConfig` is fully normalized; downstream code never re-validates.
- Unknown/extra YAML keys are ignored rather than rejected. This is intentional for forward-compatibility: new config fields can be introduced without breaking older tool versions. Strict validation may be introduced via opt-in `strict: true` mode in a future iteration.
- `resolveCouncilConfigPath(council, baseDir?)` returns `<baseDir ?? process.cwd()>/council/<council>/council.yaml`, performs no filesystem IO, and rejects traversal escapes with `ConfigError`.
- Tools that **edit** `council.yaml` (e.g. `council add-member`) persist the edited YAML *document* — preserving comments, key order, the orchestrator section, and unknown/forward-compat keys — never the normalized `validateCouncilConfig` output.

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
- Obtain a council's `council.yaml` path via `resolveCouncilConfigPath(council, baseDir?)`; never hand-build `council/<name>/council.yaml`.
- Treat `CouncilConfig` as read-only once loaded.

## Exceptions

- Tests may construct `CouncilConfig` objects directly instead of reading a file.

## Enforcement

- [x] Automated checks (`src/config/council-config.test.ts`)
- [x] Code review checklist
- [x] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
