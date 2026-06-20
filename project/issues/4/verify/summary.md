# Verify Summary — #4

## Feature Overview

**Issue:** #4 — feat(security): enforce read-only member permissions in Copilot sessions

Wired the existing, unit-tested read-only permission policy into **live Copilot sessions**, closing a least-privilege gap. `CopilotSessionFactory.createSession` now derives `onPermissionRequest` from a **fail-closed** handler built on `createMemberPermissionPolicy(member)` instead of the SDK `approveAll` (the import was removed). A new pure, side-effect-free `toPermissionRequestContext` mapper translates the SDK `PermissionRequest` discriminated union into the policy's `{ writes?, tool? }` context, with the approve/deny rule kept **single-sourced** in `src/permissions/policy.ts`. Each decision is logged through the structured logger as `permission.decision` with exactly `{ member, kind, decision }`, and denial feedback and logs never expose filesystem paths.

## Branch & PR

| Field | Value |
|-------|-------|
| Branch | `feat/4-readonly-permissions` |
| PR | [feat(security): enforce read-only member permissions in Copilot sessions](https://github.com/jsburckhardt/conclave/pull/9) |

## Commits

| Hash | Message |
|------|---------|
| f3d80ef | feat(security): add pure toPermissionRequestContext SDK→policy mapper (T3) |
| 59cbff3 | feat(security): enforce read-only handler in sessions (T4–T6) |
| 31ed313 | test(security): add factory wiring test + coverage friction note (T5/T7) |
| 5cd4d9c | docs(impl): add issue #4 implementation notes (T7) |

All commits follow Conventional Commits and carry the `Co-authored-by: Copilot` trailer (CORE-COMPONENT-0002, Decision #3).

## Acceptance Criteria

| Status | Criterion | Evidence |
|--------|-----------|----------|
| ✅ passed | **[Core]** `createSession` derives `onPermissionRequest` from `createMemberPermissionPolicy(member)`, no `approveAll` | `src/runtime/copilot-session-factory.ts`; test TP-12 |
| ✅ passed | **[Core]** unused `approveAll` import removed from `copilot-session-factory.ts` | import deleted; `./harness lint` (no-unused-vars + tsc) pass |
| ✅ passed | **[Core]** pure, exported SDK→`PermissionRequestContext` mapper without side effects | `toPermissionRequestContext` in `src/runtime/permission-handler.ts`; tests TP-01, TP-03 |
| ✅ passed | **[Core]** read-only member denies `write`/`shell`/write-`memory`/`extension-management` via `{ kind: "reject" }` | mapper `writes:true` → policy `deny`; tests TP-01, TP-04, TP-07 |
| ✅ passed | **[Core]** read-only member approves `read`/`url` via `{ kind: "approve-once" }` | mapper `writes:false`; test TP-05 |
| ✅ passed | **[Core]** `read-write` member has write requests approved | `src/permissions/policy.ts`; test TP-06 |
| ✅ passed | **[Core]** denial feedback and decision logs contain no absolute filesystem paths | constant feedback `"Denied: member is read-only"`; logs only `{member,kind,decision}`; tests TP-01, TP-10 |
| ✅ passed | **[Core]** each decision logged via structured logger with `member`, `kind`, `decision` | `logger?.info("permission.decision", {...})`; test TP-09 |
| ✅ passed | **[Edge]** unrecognized/future `kind` treated as write and denied for read-only (fail-closed) | `default` branch → `writes:true`; tests TP-01, TP-07, TP-11 |
| ✅ passed | **[Edge]** request lacking a mutation signal treated conservatively as a write | malformed `{}` → `default`; tests TP-01, TP-07 |
| ✅ passed | **[Edge]** memory by direction (re-expressed): SDK has no read/write memory direction, so all `memory` is denied (fail-closed, intent strengthened) | CORE-COMPONENT-0007 memory note + Plan Decision 1; tests TP-02, TP-07 |
| ✅ passed | **[Edge]** `read-write` member not over-locked: writes remain approved | test TP-06 (write + shell approved) |
| ✅ passed | **[Edge]** sequential requests on a session evaluated independently and deterministically | stateless handler; test TP-11 (sequential deny→approve) |
| ✅ passed | **[Edge]** concurrent/parallel evaluations safe (mapper + policy pure and stateless) | no shared mutable state; purity/determinism test TP-03 |
| ✅ passed | **[Edge]** handler never returns `undefined`, never throws; always a valid SDK result | test TP-11 (total over all kinds; never `no-result`) |
| ✅ passed | **[Testing]** unit test: mapper returns correct `{ writes }` per known `kind` | TP-01 table-driven + TP-02 (memory; re-expressed to always-write) |
| ✅ passed | **[Testing]** unit test: read-only member denies a write, approves a read via the handler | tests TP-04, TP-05 |
| ✅ passed | **[Testing]** unit test: `read-write` member approves a write | test TP-06 |
| ✅ passed | **[Testing]** unit test: ambiguous/unknown request denied for read-only | test TP-07 |
| ✅ passed | **[Testing]** unit test: handler returns SDK-shaped results, not internal strings | test TP-08 |
| ✅ passed | **[Testing]** security test: feedback and log carry no path even with a `fileName` present | test TP-10 (write/shell/mcp/memory exercised) |
| ✅ passed | **[Testing]** tests use fabricated `PermissionRequest` objects; coverage ≥80% | fakes/`requestBuilders`; coverage 84.40/87.64/87.50/84.40 |

All 22 acceptance criteria are satisfied. Two memory-direction criteria are satisfied via a documented re-expression: the installed `@github/copilot-sdk@1.0.2` exposes no read/write memory direction (`direction` is vote sentiment), so every `memory` request is classified as a write and denied — fail-closed, which strengthens the original intent. No criterion failed; none were unverifiable.

## ADRs & Core-Components

| ID | Title |
|----|-------|
| ADR-0002 | TypeScript + GitHub Copilot SDK Multi-Session Runtime |
| CORE-COMPONENT-0007 | Permission Policy (realizes the enforced read-only target) |
| CORE-COMPONENT-0005 | Logging and Observability (`permission.decision` event) |
| CORE-COMPONENT-0003 | Configuration (members default to read-only) |
| CORE-COMPONENT-0002 | Commit Standards (Conventional Commits + Co-authored-by) |

## Verification Results

| Category | Command | Status |
|----------|---------|--------|
| Lint (eslint + prettier + tsc) | `./harness verify` (`npm run lint && npm run format:check && npm run typecheck`) | pass |
| Test | `./harness verify` (`npm test` → `vitest run`, 7 files / 54 tests) | pass |
| Build | `./harness verify` (`npm run build` → `tsc`) | pass |
| Verify (aggregate verdict) | `./harness verify` | pass |
| Coverage ≥80% all metrics (84.40 / 87.64 / 87.50 / 84.40) | `npm run test:coverage` | pass |

The harness contract has no `coverage` verb and `./harness test`/`verify` run `vitest run` without `--coverage`, so the ≥80% gate was proven via the direct `npm run test:coverage` command — a recorded friction (`.harness/friction.jsonl`).

## Generated At

2026-06-20T09:08:32Z
