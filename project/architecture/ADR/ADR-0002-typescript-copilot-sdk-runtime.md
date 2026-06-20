# ADR-0002: TypeScript + GitHub Copilot SDK Multi-Session Runtime

## Status

Accepted

## Context

Conclave is a "council" runtime: an orchestration layer that composes multiple Copilot-powered, repo-grounded agent sessions into a structured, auditable discussion that produces durable artifacts (see `prd.md`). The foundational technology choice must support:

- Programmatic creation and control of Copilot agent sessions (not terminal scraping).
- One persistent session per council member, each bound to its own working directory/repo.
- Structured events, streaming, tool/permission handlers, and session persistence.
- A command-line entry point (`council init|add-member|run|continue`).
- File-based council memory (transcript, decisions, artifacts) as the source of truth.

The `@github/copilot-sdk` package provides exactly this surface (`CopilotClient`, `createSession`, `sendAndWait`, permission handlers, resumable session IDs). It is distributed as an ESM-first TypeScript package, which makes TypeScript on Node.js the natural host environment.

## Decision

Conclave v0 is built as a **TypeScript (ESM) application running on Node.js (LTS, >=20)**, using:

- **`@github/copilot-sdk`** for the Copilot agent runtime (one `CopilotSession` per council member).
- **`commander`** for the `council` CLI.
- **`yaml`** for parsing `council.yaml`.
- **`vitest`** as the test runner, **ESLint** + **typescript-eslint** for linting, and **Prettier** for formatting.
- **`tsc`** (NodeNext module resolution, `strict: true`) for type-checking and build.

We adopt **Model A (multi-session council)** from the PRD as the runtime topology: each member is an independent SDK session with its own working directory and stable session id (`<councilId>/<memberId>`). The concrete Copilot wiring lives behind a `SessionFactory` abstraction (`src/runtime/`) so the orchestration logic stays testable and decoupled from the SDK.

Out of scope for this decision (deferred to later issues): the MCP "council bus", orchestrator-as-session, streaming UI, and dynamic council phases (PRD v1/v2).

## Alternatives

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Copilot CLI automation (spawn terminals, scrape stdout) | No SDK dependency | Fragile, hard to observe, no structured events or persistence | PRD explicitly rejects terminal multiplexing for v0 |
| Python + subprocess to Copilot CLI | Familiar ecosystem | No first-class Copilot SDK; loses structured events/permissions | SDK is TypeScript/Node; reimplementing the runtime is wasteful |
| Single-session with subagents (Model B) | Simpler, one workspace | Cannot bind each member to its own repo/working directory | Cross-repo council requires per-member working directories |
| Go/Rust CLI | Fast, single binary | No Copilot SDK bindings; would shell out to the SDK anyway | No ecosystem fit for the Copilot SDK |

## Consequences

What becomes easier or harder as a result of this decision?

### Positive
- Native, programmatic control of Copilot sessions with structured events and permissions.
- Per-member repo grounding via independent working directories and stable session ids.
- Strong typing across config, runtime, and stores; fast feedback via `tsc` + `vitest`.
- The `SessionFactory` seam keeps orchestration logic unit-testable without the live SDK.

### Negative
- Couples the project to the `@github/copilot-sdk` release cadence and its (currently preview) API surface.
- ESM + NodeNext requires `.js` import specifiers in TypeScript source, a minor authoring constraint.

### Neutral
- Node.js LTS runtime requirement (>=20) for contributors and CI.
- The orchestration phases remain to be designed and implemented in subsequent issues.

## Related Issues

- [#1](https://github.com/jsburckhardt/conclave/issues/1)

## References

- `prd.md` — Conclave product brief ("Recommended v0")
- [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk)
- Core-components CORE-COMPONENT-0003 … CORE-COMPONENT-0009
