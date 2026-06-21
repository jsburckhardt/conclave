# Action Plan: feat(security): enforce read-only member permissions in Copilot sessions

## Feature
- **ID:** 4
- **Title:** feat(security): enforce read-only member permissions in Copilot sessions
- **Branch:** `feat/4-readonly-permissions`
- **Research Brief:** project/issues/4/research/00-research.md
- **Scope Type:** `issue` (realizes/enforces existing architecture — no new ADR or core-component)

## Summary

The read-only default already exists and is unit-tested as a *pure decision function*
(`createMemberPermissionPolicy` in `src/permissions/policy.ts`, Decision #11 /
CORE-COMPONENT-0007), but it is **not wired into live sessions**:
`src/runtime/copilot-session-factory.ts` still passes `onPermissionRequest: approveAll`.
This issue closes that least-privilege gap by introducing a small, pure SDK→policy
mapping and a fail-closed handler, then wiring it into the session factory — keeping the
approve/deny rule single-sourced in `policy.ts`.

## Chosen Approach

1. **New pure module `src/runtime/permission-handler.ts`** with two exports:
   - `toPermissionRequestContext(request: PermissionRequest): PermissionRequestContext` —
     a pure, side-effect-free, 10-way `switch (request.kind)` that maps each SDK
     permission request to `{ writes, tool }`, with a **fail-closed `default`**
     (`{ writes: true }`). It copies **only** path-free hints (`kind`, or `toolName` for
     `mcp`/`custom-tool`/`hook`) — never `fileName`, `path`, `diff`, `args`,
     `fullCommandText`, `url`, or `fact`.
   - `createPermissionHandler(member: MemberConfig, logger?: Logger): PermissionHandler` —
     **translates then delegates**: builds `createMemberPermissionPolicy(member)`, maps the
     SDK request via `toPermissionRequestContext`, calls the single-sourced policy, logs
     `permission.decision` with `{ member, kind, decision }` (CORE-COMPONENT-0005), and
     returns an SDK-shaped result — `{ kind: "approve-once" }` on approve,
     `{ kind: "reject", feedback: "Denied: member is read-only" }` on deny. It never
     throws, never returns `undefined`, and never returns `{ kind: "no-result" }`.
2. **Wire it into `CopilotSessionFactory`**: replace `onPermissionRequest: approveAll`
   with `createPermissionHandler(member, this.logger)`, remove the now-unused `approveAll`
   import, and inject a `logger` via the constructor (defaulting to `createLogger()`),
   matching `CouncilRuntime`'s injection convention.
3. **Keep the rule single-sourced**: the new module must *not* re-implement the read-only
   check; `policy.ts` and its `policy.test.ts` remain the source of truth and must not
   regress.
4. **Update the public surface / repo map**: re-export the new module from `src/index.ts`
   and add an `LLM.txt` row.

### SDK ground truth (verified against installed `@github/copilot-sdk@1.0.2` `.d.ts`/`.js`)

- `PermissionHandler = (request: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult> | PermissionRequestResult` — `dist/types.d.ts:726-728`.
- `approveAll = () => ({ kind: "approve-once" })` — `dist/types.js:92` (the permissive behavior we are removing).
- Approve shape `{ kind: "approve-once" }` — `rpc.d.ts:6028-6033`; Reject shape `{ kind: "reject"; feedback?: string }` — `rpc.d.ts:6384-6393`.
- **Never** return `{ kind: "no-result" }` (protocol-v2 servers reject it — `README.md:910`).
- `PermissionRequest` is a discriminated union of **exactly 10 `kind`s** — `session-events.d.ts:277`: `read`, `url`, `write`, `shell`, `extension-management`, `extension-permission-access`, `mcp`, `custom-tool`, `hook`, `memory`. Every variant has a `kind` discriminator, so a `switch` is exhaustive.
- Top-level exports confirmed: `PermissionHandler`, `PermissionRequest`, `PermissionRequestResult`, `SessionConfig`, `approveAll` — `dist/index.d.ts`.

### `writes` mapping (the enforced classification)

| `kind` | `writes` | `tool` hint |
|--------|----------|-------------|
| `read`, `url` | `false` (inert) | `kind` |
| `write`, `shell`, `extension-management`, `extension-permission-access`, `memory` | `true` | `kind` |
| `mcp`, `custom-tool`, `hook` | `true` | `toolName` |
| _unknown / future / malformed_ | `true` (fail-closed `default`) | `kind` or `"unknown"` |

## Key Decisions Resolved (the two Plan blockers)

### Decision 1 — `memory` mapping (Research Risk #1): treat ALL `memory` as a write

**Committed:** every `memory` request maps to `{ writes: true }` and is **denied for
read-only members**, regardless of `action`/`direction`.

**Why.** The installed `@github/copilot-sdk@1.0.2` `PermissionRequestMemory`
(`session-events.d.ts:4800-4827`) has **no read/write direction**. It carries only:
- `action?: "store" | "vote"` — the operation (`session-events.d.ts:281`)
- `direction?: "upvote" | "downvote"` — the **vote sentiment**, *not* read vs. write
  (`session-events.d.ts:289`)

Both `store` (writes a new fact) and `vote` (mutates an existing memory's standing) change
**persistent** state, so there is no provably-inert "read" memory variant. The strict
fail-closed reading (Research's recommended option **(a)**) is the only least-privilege
choice. The semantic option (b) (`action: "vote"` → inert) was **rejected** because a vote
still mutates persistent memory and approving it for a read-only member weakens
least-privilege.

**Re-expression of the issue's memory AC (does not weaken fail-closed intent).** The
issue's literal wording — *"A read-direction `memory` request is approved for a read-only
member; a write-direction or missing-direction `memory` request is denied"* — assumes a
read/write direction the SDK does not model. We map the issue's intent onto the installed
types:

> **Re-expressed AC (memory):** For a read-only member, **every** `memory` request — for
> any `action` (`store`/`vote`/absent) and any `direction` (`upvote`/`downvote`/absent) —
> is **denied** (`{ kind: "reject" }`), because the SDK exposes no read-only memory
> variant. For a `read-write` member it is approved. The issue's "read-direction → approve"
> clause maps to the **empty set** under the installed SDK and is intentionally not
> implemented; the "write-direction or missing-direction → denied" clause is satisfied in
> full and strengthened (all directions denied).

This is documented in CORE-COMPONENT-0007 ("Memory note") and recorded as Decision #15.

### Decision 2 — Documentation and date edits (Research Risk #1 / Proposed Core-Components)

**Committed and DONE in this plan stage:**
- **CORE-COMPONENT-0007** edited in place (existing concrete doc, not a template) to
  replace the "v0 wires a permissive handler / documented target" language with the
  enforcement reality, and to document: the SDK `PermissionRequest` → `writes` mapping
  table, the fail-closed `default`, the memory decision, the no-path
  feedback/logging rule, the SDK result shapes (`approve-once` / `reject`), and an updated
  Enforcement checklist (now claims test-coverage enforcement). API names match the planned
  code (`toPermissionRequestContext`, `createPermissionHandler`).
- **DECISION-LOG.md** updated with the correct date **2026-06-20**: the CORE-COMPONENT-0007
  row date refreshed; Decision #11 refreshed to reflect enforcement; new decision records
  #14, #15, #16 added (every core-component change yields >=1 decision record).

## Non-Goals (explicitly out of scope)

- **No new ADR and no new core-component.** Runtime topology (`ADR-0002`) and the read-only
  default (Decision #11 / CORE-COMPONENT-0007) already exist; this issue only enforces them.
- **Network egress policy.** `url`/MCP network access remains a *deliberate follow-up*;
  `url` maps to `writes: false` (workspace not mutated). Governing egress as a first-class
  policy axis would warrant a *future* ADR and is not opened here.
- **Honoring SDK refinement hints** (`mcp.readOnly`, `shell.commands[].readOnly`,
  `shell.hasWriteFileRedirection`) to relax the classification — intentionally ignored;
  v0 stays strictly fail-closed.
- **Orchestrator/`read-write` artifact-writing behavior** beyond the existing policy.
- **Changing `policy.ts` or `policy.test.ts`** — the rule stays single-sourced and unchanged.

## ADRs Created

**None.** No new architectural decision is introduced.

- **Related (unchanged):** `ADR-0002` — TypeScript + GitHub Copilot SDK Multi-Session
  Runtime (establishes the SDK runtime and the `SessionFactory` seam this issue plugs into).

## Core-Components Created

**None new.** This issue **updates** an existing component:

- **CORE-COMPONENT-0007 — Permission Policy (UPDATED in place):** now documents enforced
  read-only sessions, the SDK→`writes` mapping, fail-closed default, the memory decision,
  the no-path rule, and SDK result shapes.
- **Related (unchanged):** CORE-COMPONENT-0005 (Logging) governs the per-decision log;
  CORE-COMPONENT-0003 (Configuration) is the source of `tools` and the read-only default.

## Acceptance Criteria (from issue #4) → task mapping

> AC IDs: `C#` = Core, `E#` = Edge Cases, `T#` = Testing. Memory case re-expressed per
> Decision 1 above.

**Core**
- **C1** — Factory derives `onPermissionRequest` from `createMemberPermissionPolicy`, not `approveAll`. → **T5**
- **C2** — Unused `approveAll` import removed from `copilot-session-factory.ts`. → **T5**
- **C3** — Pure, exported mapping `PermissionRequest` → `PermissionRequestContext`, no side effects. → **T3**
- **C4** — Read-only member: `write`, `shell`, `memory` (all), `extension-management` denied via `{ kind: "reject" }`. → **T3, T4**
- **C5** — Read-only member: `read`, `url` approved via `{ kind: "approve-once" }`. → **T3, T4**
- **C6** — `read-write` member: write approved. → **T4**
- **C7** — Denial `feedback` and decision logs contain no absolute paths (no `fileName`/`workingDirectory`). → **T3, T4**
- **C8** — Each decision logged via the structured logger with `member`, `kind`, `decision`. → **T4**

**Edge Cases**
- **E1** — Unrecognized/future `kind` treated as write, denied for read-only (fail-closed). → **T3, T4**
- **E2** — Request lacking a mutation signal / missing variant fields treated conservatively as write. → **T3, T4**
- **E3** (re-expressed) — Every `memory` request denied for read-only; approved for `read-write`. → **T3, T4**
- **E4** — `read-write` member not over-locked: writes remain approved. → **T4**
- **E5** — Multiple sequential requests evaluated independently and deterministically. → **T4**
- **E6** — Concurrent/parallel evaluations safe (mapper + policy pure/stateless). → **T3, T4**
- **E7** — Handler never returns `undefined` and never throws; every path returns a valid SDK result. → **T4**

**Testing**
- **T-a** — Unit: mapping returns correct `{ writes }` per known `kind` (+ memory invariance). → **T3**
- **T-b** — Unit: read-only denies write, approves read through the handler. → **T4**
- **T-c** — Unit: `read-write` approves write. → **T4**
- **T-d** — Unit: ambiguous/unknown denied for read-only. → **T4**
- **T-e** — Unit: handler returns SDK-shaped results, not `"approve"`/`"deny"` strings. → **T4**
- **T-f** — Security: denial `feedback` and emitted log contain no path even with a `fileName`. → **T4**
- **T-g** — Tests use fabricated `PermissionRequest` objects (no live `CopilotClient`); coverage >=80%. → **T3, T4, T7**

## Implementation Tasks (outline)

Ordered by dependency (detail in `02-task-breakdown.md`):

1. **T1 — Revise CORE-COMPONENT-0007** to document enforced read-only policy. *(done in Plan; verify in Implement)*
2. **T2 — Update DECISION-LOG.md** (date 2026-06-20; refresh #11; add #14–#16). *(done in Plan; verify in Implement)*
3. **T3 — Implement pure `toPermissionRequestContext` mapper** (10-way switch + fail-closed default) + table-driven tests.
4. **T4 — Implement `createPermissionHandler`** (translate→delegate, SDK-shaped results, log, never throw) + handler & security tests.
5. **T5 — Wire handler into `CopilotSessionFactory`**, remove `approveAll`, inject `logger` (+ optional factory test).
6. **T6 — Export new module from `src/index.ts`** and add the `LLM.txt` row.
7. **T7 — Validate via `./harness verify`** (lint + test + build) and confirm coverage >=80%; `policy.test.ts` unchanged & green.

## Validation Surface (harness-first)

- `./harness lint` — wraps `eslint . && prettier --check && tsc --noEmit` (catches the unused
  `approveAll` import and any type errors).
- `./harness test` — wraps `vitest run` (unit/security/regression; coverage thresholds 80%).
- `./harness build` — wraps `tsc -p tsconfig.json`.
- `./harness verify` — lint + test + build; baseline is **pass** (5 files / 18 tests).
- Direct commands only if the harness lacks a verb or reports `unknown`/`degraded`; record
  any bypass with `./harness friction add`.

## Risks Carried Into Implement

- **ESM/NodeNext:** import specifiers use `.js` extensions (`./permission-handler.js`).
- **vitest env is globally `node`** — **no** `// @vitest-environment node` pragma needed.
- **Coverage gate:** the new file is included in coverage; the mapper's 10 branches +
  memory variants + `default`, and the handler's approve/deny + logger-present/absent
  branches must all be exercised. Add the optional factory test only if a metric drops <80%.
- **Single-sourcing:** the handler must delegate to `policy.ts`, never re-implement the check.
