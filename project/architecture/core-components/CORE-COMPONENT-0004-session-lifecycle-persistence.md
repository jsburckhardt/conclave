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

### Interfaces
- `interface SessionFactory { start(); createSession(member, councilId); stop(); }`
- `interface MemberSession { sendAndWait(prompt: string): Promise<string>; }`
- `class CouncilRuntime` — `start()`, `askMember(id, prompt)`, `stop()`.
- `class CopilotSessionFactory implements SessionFactory`.

### Expectations
- `start()` creates all member sessions before any `askMember` call.
- Stable session ids are durable across process restarts to support `council continue`.

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
