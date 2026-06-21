# Implementation Notes: Issue #4 — Enforce read-only member permissions in Copilot sessions

**Branch:** `feat/4-readonly-permissions`
**Stage:** Implement (RPIV) — tasks **T3–T7** (T1/T2 were completed in the Plan stage and verified unchanged here).
**Final verdict:** `./harness verify` = **pass** (lint + test + build). Coverage gate (`npm run test:coverage`) = **pass**, ≥80% on all four metrics.

---

## Summary

The read-only default already existed as a pure, unit-tested decision function
(`createMemberPermissionPolicy` in `src/permissions/policy.ts`) but was **not wired into live
sessions** — `CopilotSessionFactory` passed `onPermissionRequest: approveAll`. This change closes
that least-privilege gap by adding a small **pure SDK→policy mapper** and a **fail-closed handler**,
then wiring it into the session factory, while keeping the approve/deny rule **single-sourced** in
`policy.ts` (never re-implemented).

All work stays inside the architectural boundaries of **ADR-0002** (the `SessionFactory` seam) and
**CORE-COMPONENT-0007 / 0005 / 0003**. No ADR or core-component deviation was required, so no return
to Plan was triggered.

---

## Files created / changed

### Created
| File | Purpose |
|------|---------|
| `src/runtime/permission-handler.ts` | **T3+T4.** Pure `toPermissionRequestContext` mapper (10-way `switch` + fail-closed `default`) and `createPermissionHandler` (translate→delegate, logged, SDK-shaped, total). |
| `src/runtime/permission-handler.test.ts` | **T3+T4.** 34 tests — table-driven mapper, memory invariance, purity, handler approve/deny, SDK-shaped results, logging, security (no path leak), robustness (TP-01…TP-11). |
| `src/runtime/copilot-session-factory.test.ts` | **T5 (TP-12).** 2 tests — fake `CopilotClient` captures `SessionConfig`; asserts handler is present, is **not** `approveAll`, rejects a read-only write, approves a read; covers `stop()` success + `SessionError` paths. |

### Changed
| File | Change |
|------|--------|
| `src/runtime/copilot-session-factory.ts` | **T5.** Replaced `onPermissionRequest: approveAll` with `createPermissionHandler(member, this.logger)`; **removed** the unused `approveAll` import; injected `logger?: Logger` (2nd ctor param) defaulting to `createLogger()` (matches `CouncilRuntime`). |
| `src/index.ts` | **T6.** Added `export * from "./runtime/permission-handler.js";` (public-surface parity). |
| `LLM.txt` | **T6.** Added the `src/runtime/permission-handler.ts` repo-map row. |
| `.harness/friction.jsonl` | **T7.** Recorded the coverage-verb gap (see Deviations). |

### Verified unchanged (Plan-stage T1/T2, plus the single-sourced rule)
- `project/architecture/core-components/CORE-COMPONENT-0007-permission-policy.md` — already documents the enforced policy, the 10-kind `writes` table, fail-closed `default`, the memory note, the no-path rule, the SDK result shapes (`approve-once`/`reject`), and the planned API names (`toPermissionRequestContext`, `createPermissionHandler`). **Matches the implemented symbols.**
- `project/architecture/ADR/DECISION-LOG.md` — CORE-COMPONENT-0007 row + Decision #11 dated `2026-06-20`; decisions **#14/#15/#16** present and dated.
- `src/permissions/policy.ts` and `src/permissions/policy.test.ts` — **untouched** (rule stays single-sourced; the 5 policy tests pass unmodified).

---

## Key decisions honored

- **Single-sourced rule.** `createPermissionHandler` builds `createMemberPermissionPolicy(member)` and
  **delegates**; the read-only check is never duplicated. `toPermissionRequestContext` only *translates*
  the SDK request into the existing `PermissionRequestContext` (imported from `../permissions/policy.js`,
  not redefined).
- **Memory = fail-closed write (Plan Decision 1).** Every `memory` request → `{ writes: true }` regardless
  of `action` (`store`/`vote`/absent) or `direction` (`upvote`/`downvote`/absent), because the installed
  `@github/copilot-sdk@1.0.2` has no read/write memory direction (`direction` is vote sentiment). Verified
  against `session-events.d.ts`. Denied for read-only members.
- **Fail-closed `default`.** Unknown/future/malformed kinds → `{ writes: true, tool: kind ?? "unknown" }`,
  so a new SDK kind can never silently bypass read-only.
- **No-path logging / feedback.** The mapper copies only path-free hints (`toolName` for
  `mcp`/`custom-tool`/`hook`, else `kind`) — never `fileName`, `path`, `diff`, `newFileContents`,
  `args`/`toolArgs`, `fullCommandText`, `possiblePaths`, `url`, `fact`, `subject`, `citations`, or
  `workingDirectory`. The deny `feedback` is the **constant** `"Denied: member is read-only"`. The log emits
  exactly `{ member, kind, decision }`.
- **SDK-shaped, total handler.** Returns `{ kind: "approve-once" }` or
  `{ kind: "reject", feedback: "Denied: member is read-only" }`; never `"approve"`/`"deny"` strings, never
  `{ kind: "no-result" }`, never `undefined`, never throws. Signature matches SDK
  `PermissionHandler = (request, invocation: { sessionId }) => PermissionRequestResult | Promise<…>`
  (`dist/types.d.ts:726-728`).

---

## Issue acceptance criteria → tests

| AC | How satisfied | Evidence (test) |
|----|---------------|-----------------|
| **C1** factory derives handler, not `approveAll` | `onPermissionRequest: createPermissionHandler(member, this.logger)` | TP-12 + `./harness lint` |
| **C2** unused `approveAll` import removed | import deleted; eslint `no-unused-vars` + tsc green | `./harness lint` (pass) |
| **C3** pure exported mapping, no side effects | `toPermissionRequestContext` | TP-01, TP-03 |
| **C4** read-only denies write/shell/memory/ext-mgmt | mapper `writes:true` → policy `deny` → `reject` | TP-01, TP-04, TP-07 |
| **C5** read-only approves read/url | mapper `writes:false` → `approve-once` | TP-01, TP-05 |
| **C6** read-write approves write | policy approves; handler `approve-once` | TP-06 |
| **C7** no paths in feedback/logs | constant feedback; only `{member,kind,decision}` logged | TP-01, TP-09, **TP-10 (security)** |
| **C8** log member/kind/decision | `logger?.info("permission.decision", {member,kind,decision})` | TP-09 |
| **E1** unknown kind → write, deny | fail-closed `default` | TP-01, TP-07, TP-11 |
| **E2** missing mutation signal → write | malformed `{}` → `default` | TP-01, TP-07, TP-11 |
| **E3** memory denied (re-expressed) | all `memory` → `writes:true` | TP-02, TP-07 |
| **E4** read-write not over-locked | write+shell approved | TP-06 |
| **E5** sequential independent/deterministic | pure mapper + stateless handler | TP-03, TP-11 |
| **E6** concurrent-safe (pure/stateless) | no mutation, stable output | TP-03 |
| **E7** never undefined/throws; valid SDK result | total over all kinds | TP-11 |
| **T-a** mapping per kind (+ memory) | table-driven | TP-01, TP-02 |
| **T-b** read-only deny write / approve read | handler | TP-04, TP-05 |
| **T-c** read-write approves write | handler | TP-06 |
| **T-d** ambiguous/unknown denied | handler | TP-07 |
| **T-e** SDK-shaped results | object `kind`, not strings | TP-08 |
| **T-f** security: no path leak | feedback + log serialized, asserted path-free | TP-10 |
| **T-g** fabricated objects; coverage ≥80% | no live `CopilotClient`; v8 gate | TP-01…TP-13 |

---

## Validation (harness-first)

| Verb | Result |
|------|--------|
| `./harness lint` (eslint + prettier + tsc) | **pass** |
| `./harness test` (`vitest run`) | **pass** — 7 files / 54 tests |
| `./harness build` (`tsc -p tsconfig.json`) | **pass** |
| `./harness verify` (lint + test + build) | **pass** — evidence `.harness/evidence/verify-20260620T085102Z.json` |
| `npm run test:coverage` (coverage gate, direct) | **pass** — see numbers below |

### Test inventory (7 files / 54 tests; +36 new)
```
✓ src/runtime/permission-handler.test.ts        (34 tests)   NEW  (T3+T4, TP-01…TP-11)
✓ src/runtime/copilot-session-factory.test.ts   ( 2 tests)   NEW  (T5,    TP-12)
✓ src/permissions/policy.test.ts                ( 5 tests)   unchanged (single-sourced rule)
✓ src/config/council-config.test.ts             ( 5 tests)   unchanged
✓ src/store/artifact-store.test.ts              ( 3 tests)   unchanged
✓ src/errors.test.ts                            ( 3 tests)   unchanged
✓ src/runtime/council-runtime.test.ts           ( 2 tests)   unchanged
```

### Coverage (v8, thresholds 80% on all metrics) — **PASS**
```
File                         | % Stmts | % Branch | % Funcs | % Lines
-----------------------------|---------|----------|---------|--------
All files                    |   84.40 |   87.64  |   87.50 |  84.40   ✅ all ≥ 80
 src/runtime/permission-handler.ts |  100  |   100   |   100  |   100    (new — fully covered)
 src/runtime/copilot-session-factory.ts | 100 | 75 |  100  |   100    (now covered by TP-12)
 src/permissions/policy.ts   |   100   |   100    |   100   |   100
```
The new `permission-handler.ts` is **100%** on every metric. Wiring + the TP-12 factory test lifted the
previously-untested `copilot-session-factory.ts` from 0% and pushed the **global** gate from a
pre-existing ~74% up to **84.40%** statements / **87.64%** branches / **87.50%** functions / **84.40%**
lines.

---

## Deviations from the plan (called out explicitly)

1. **Coverage is not enforced by the harness.** The plan/test-plan state `./harness test` enforces the 80%
   thresholds, but the harness contract wraps `npm test` = `vitest run` **without `--coverage`**, and there
   is **no `harness coverage` verb**. Per the "harness lacks the needed verb" rule I proved the gate with the
   direct `npm run test:coverage` and recorded a **friction note** (`.harness/friction.jsonl`). Net effect:
   none on correctness — the gate passes either way; the new file is 100% covered.

2. **Optional TP-12 factory test was implemented (not skipped).** The plan made it conditional on a coverage
   metric dropping below 80%. Because the global gate was already failing at **~74%** due to **pre-existing**
   untested files (`copilot-session-factory.ts` 0%, `index.ts` 0%, `logger.ts` 61%, `council-config.ts` 58%)
   — a shortfall **not introduced by this issue** — I added TP-12 to cover the factory file this change
   actually touches. That was sufficient to bring the global gate to ≥80% **without** modifying any
   out-of-scope file. `logger.ts` and `council-config.ts` remain below 80% individually (pre-existing, out of
   scope), but the global thresholds (which is what vitest enforces) now pass.

No ADR or core-component boundary was crossed, so no return to Plan was required.

---

## Per-task status

## Task T3: Implement the pure `toPermissionRequestContext` SDK→policy mapper

- **Status:** Done
- **Files Changed:** `src/runtime/permission-handler.ts`, `src/runtime/permission-handler.test.ts`
- **Tests Passed:** 26 (mapper subset at T3 time; part of the 34 in the file)
- **Tests Failed:** 0

### Changes Summary
Pure 10-way `switch (request.kind)` with fail-closed `default`. `read`/`url` → `{writes:false}`; `write`,
`shell`, `extension-management`, `extension-permission-access`, `memory`, `mcp`, `custom-tool`, `hook` →
`{writes:true}`; unknown/malformed → `{writes:true, tool: kind ?? "unknown"}`. `tool` hint = `toolName` for
`mcp`/`custom-tool`/`hook`, else `kind`. Imports `PermissionRequestContext` from `../permissions/policy.js`.

### Test Results
TP-01 (table over 10 kinds + unknown + malformed; no path/secret in `tool`), TP-02 (memory invariance across
`action`/`direction`), TP-03 (purity / no mutation) — all green.

### Notes
`default` branch casts `request as unknown as { kind?: string }` (it is `never` after exhaustive cases) to
read a fallback kind safely while exercising the `?? "unknown"` branch.

## Task T4: Implement `createPermissionHandler` (fail-closed, single-sourced, logged)

- **Status:** Done
- **Files Changed:** `src/runtime/permission-handler.ts`, `src/runtime/permission-handler.test.ts`
- **Tests Passed:** 34 (file total)
- **Tests Failed:** 0

### Changes Summary
`createPermissionHandler(member, logger?)` builds `createMemberPermissionPolicy(member)`, maps each request,
logs `permission.decision` with exactly `{member, kind, decision}`, and returns `{kind:"approve-once"}` or
`{kind:"reject", feedback:"Denied: member is read-only"}`. Never throws/undefined/`no-result`. Logger is
optional-chained.

### Test Results
TP-04…TP-11 green: deny write / approve read+url / read-write approves write+shell / deny unknown+malformed+
memory / SDK-shaped results / log exactly 3 fields + no-logger safe / **security no-path leak** (write, shell,
mcp, memory) / total over all kinds + sequential independence.

### Notes
Logger interface and import path matched exactly (`Logger`/`LogFields` from `../logging/logger.js`); call
shape `info(message, fields)` mirrors existing `session.created` call sites.

## Task T5: Wire the handler into `CopilotSessionFactory` and remove `approveAll`

- **Status:** Done
- **Files Changed:** `src/runtime/copilot-session-factory.ts`, `src/runtime/copilot-session-factory.test.ts`
- **Tests Passed:** 2 (factory) + lint gate
- **Tests Failed:** 0

### Changes Summary
`onPermissionRequest: createPermissionHandler(member, this.logger)`; `approveAll` import removed; added
`logger?: Logger` ctor param defaulting to `createLogger()`. `start`/`stop`/`sendAndWait` and the stable
`<councilId>/<memberId>` session id are unchanged.

### Test Results
`./harness lint` proves `approveAll` is gone + types sound. TP-12 confirms the installed handler is not
`approveAll` and rejects a read-only write / approves a read at runtime.

### Notes
Injection convention mirrors `CouncilRuntime` (`options.logger ?? createLogger()`).

## Task T6: Export the new module and update the repo map

- **Status:** Done
- **Files Changed:** `src/index.ts`, `LLM.txt`
- **Tests Passed:** build gate
- **Tests Failed:** 0

### Changes Summary
Re-export parity in `src/index.ts`; `LLM.txt` row for `src/runtime/permission-handler.ts`.

### Test Results
`./harness build` (tsc) confirms the re-export resolves with no duplicate symbols.

### Notes
`createPermissionHandler`/`toPermissionRequestContext` resolve from the package root.

## Task T7: Validate the full suite, coverage, and harness verdict

- **Status:** Done
- **Files Changed:** `.harness/friction.jsonl`
- **Tests Passed:** 54 (7 files)
- **Tests Failed:** 0

### Changes Summary
Ran the harness-first surface (lint/test/build/verify = pass) and the direct coverage gate
(`npm run test:coverage` = pass at ≥80% on all metrics). `policy.test.ts` unchanged + green.

### Test Results
`./harness verify` = **pass**. Coverage: 84.40 / 87.64 / 87.50 / 84.40 (stmts/branch/funcs/lines).

### Notes
Recorded a friction note that the harness does not pass `--coverage`; gate proven via the direct command.
