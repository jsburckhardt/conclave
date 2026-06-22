# CORE-COMPONENT-0004: Session Lifecycle and Persistence

## Status

Adopted (amended 2026-06-22 — documented the `council continue` resume contract; see DECISION-LOG decisions #36–#38)

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

**Resume (`council continue`)**

- Resuming a council re-invokes `runBacklogCouncil` with the persisted `CouncilState` (CORE-COMPONENT-0006); the phase/round model is **not** redefined and no `CouncilRuntime.resume()` method is added — phase knowledge stays out of the runtime.
- `CouncilRuntime.start()` recreates one session per member through `SessionFactory.createSession(member, councilId)`, reusing the identical stable `"<councilId>/<memberId>"` ids; resume re-derives these ids from `councilId`/`memberId` and treats any stored `sessionId` only as a cross-check (never trusted blindly).
- Resume continues from the persisted `lastPhase`/`lastRound`, seeding intermediate products (`summary`/`backlog`/`validation`) from the state's `products` checkpoint, and re-checkpoints after each completed phase/round via an injected callback.
- Resuming an already-`completed` council is an idempotent no-op; a failed SDK session resume raises `SessionError` and leaves the persisted state intact so the run stays retryable.
- The on-disk council directory and `councilId` are resolved canonically via `resolveCouncilConfigPath(<council>)` (CORE-COMPONENT-0003); `run` and `continue` enforce `config.name === <council> === state.councilId` before resuming.

### Interfaces
- `interface SessionFactory { start(); createSession(member, councilId); stop(); }`
- `interface MemberSession { sendAndWait(prompt: string): Promise<string>; }`
- `class CouncilRuntime` — `start()`, `askMember(id, prompt)`, `stop()`.
- `class CopilotSessionFactory implements SessionFactory`.
- `runBacklogCouncil(runtime, config, { artifacts, logger?, resume?, checkpoint? }): Promise<BacklogCouncilResult>` — the fixed v0 phase orchestrator (`src/runtime/council-phases.ts`); `resume` seeds a start point from persisted state and `checkpoint` persists progress after each phase/round.
- `normalizePolicy(policy?): NormalizedPolicy` — pure policy validation/normalization (applies defaults and the `maxRounds`/contradiction checks).
- `runCouncil(options)` / `continueCouncil(options)` (`src/commands/`) — thin, testable command functions that own path/identity resolution, the state store, the concurrency lock, and the runtime lifecycle for `council run` / `council continue`.

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
