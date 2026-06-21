# CORE-COMPONENT-0004: Session Lifecycle and Persistence

## Status

Adopted

## Purpose

A council is a set of Copilot sessions. Creating, addressing, and tearing those sessions down — and being able to resume them later — is a cross-cutting concern shared by every council run. Centralizing it keeps orchestration logic decoupled from the Copilot SDK and makes councils resumable.

## Scope

Affects the runtime layer (`src/runtime/`). Boundaries: this component owns session creation, message dispatch, and shutdown; it does not own configuration parsing, transcript formatting, or artifact writing.

## Definition

### Rules
- Council orchestration depends on the `SessionFactory` and `MemberSession` interfaces, never directly on `@github/copilot-sdk`.
- Each member maps to exactly one session, keyed by a stable id `"<councilId>/<memberId>"`, so councils can be resumed.
- Members default to read-only; the v0 Copilot adapter approves requests and defers fine-grained enforcement to CORE-COMPONENT-0007.
- Session/runtime failures raise `SessionError` (see CORE-COMPONENT-0008).
- The concrete SDK adapter lives in `src/runtime/copilot-session-factory.ts`; the orchestrator lives in `src/runtime/council-runtime.ts`.

**Phase orchestration, policy, and role resolution**

- The fixed v0 backlog flow (`runBacklogCouncil`, `src/runtime/council-phases.ts`) runs phases in a deterministic order — context summary → backlog draft → optional project validation → refinement → optional artifact generation — driving members exclusively through `CouncilRuntime.askMember`; it never imports `@github/copilot-sdk` and is runnable with a fake `SessionFactory`.
- Orchestrator policy defaults are `writeArtifacts: true`, `requireProjectValidation: true`, `maxRounds: 1`. `maxRounds` must be a non-negative integer or a `ConfigError` is raised; `requireProjectValidation: true` combined with `maxRounds: 0` is contradictory and raises `OrchestrationError` (see CORE-COMPONENT-0008).
- Logical roles (context source, backlog author) are resolved from member `role` text by a documented, fail-closed heuristic and must resolve to two **distinct** members; unresolved, ambiguous, or non-distinct roles raise `OrchestrationError` with an actionable message (a single-member council always fails). Member ids are never hardcoded.
- Every phase response must be non-blank after `trim()`; a blank or whitespace-only response raises `OrchestrationError` and no artifact is written.
- `runtime.stop()` runs in a `finally` on every path (success or failure); a `stop()` failure is logged separately and never masks the original error.

### Interfaces
- `interface SessionFactory { start(); createSession(member, councilId); stop(); }`
- `interface MemberSession { sendAndWait(prompt: string): Promise<string>; }`
- `class CouncilRuntime` — `start()`, `askMember(id, prompt)`, `stop()`.
- `class CopilotSessionFactory implements SessionFactory`.
- `runBacklogCouncil(runtime, config, { artifacts, logger? }): Promise<BacklogCouncilResult>` — the fixed v0 phase orchestrator (`src/runtime/council-phases.ts`).
- `normalizePolicy(policy?): NormalizedPolicy` — pure policy validation/normalization (applies defaults and the `maxRounds`/contradiction checks).

### Expectations
- `start()` creates all member sessions before any `askMember` call.
- Stable session ids are durable across process restarts to support `council continue`.
- Phase prompts are passed verbatim to `askMember` (no hidden preamble); prompt construction is pure and unit-testable.
- The orchestrator depends only on the runtime, stores, config types, and the typed error hierarchy — never on `@github/copilot-sdk`.

## Rationale

The `SessionFactory` seam allows the runtime to be unit-tested with in-memory fakes and isolates the (preview) SDK API behind a thin adapter, limiting blast radius when the SDK changes.

## Usage Examples

```ts
import { CouncilRuntime, CopilotSessionFactory } from "conclave";

const runtime = new CouncilRuntime({
  config,
  sessionFactory: new CopilotSessionFactory(),
  transcript,
  artifacts,
});
await runtime.start();
const summary = await runtime.askMember("project-x", "Summarize the repo.");
await runtime.stop();
```

## Integration Guidelines

- Inject a `SessionFactory` into `CouncilRuntime`; use `CopilotSessionFactory` in production and a fake in tests.
- Derive session ids only via the `"<councilId>/<memberId>"` convention.

## Exceptions

- Tests substitute a fake `SessionFactory` that returns deterministic responses.

## Enforcement

- [x] Automated checks (`src/runtime/council-runtime.test.ts`)
- [x] Code review checklist
- [x] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
