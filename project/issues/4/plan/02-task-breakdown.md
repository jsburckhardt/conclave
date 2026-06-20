# Task Breakdown: Issue #4 — Enforce read-only member permissions in Copilot sessions

Tasks are ordered by dependency. Each references the governing ADR/core-components and maps
back to the issue acceptance criteria (`C#`/`E#`/`T#` from `01-action-plan.md`). Full test
detail lives in `03-test-plan.md`.

**Global references:** `ADR-0002` (SDK runtime + `SessionFactory` seam),
`CORE-COMPONENT-0007` (Permission Policy — governing), `CORE-COMPONENT-0005` (Logging),
`CORE-COMPONENT-0003` (Configuration — `tools` default), `CORE-COMPONENT-0009`
(Development Standards — strict TS, lint, vitest >=80%).

---

## Task T1: Revise CORE-COMPONENT-0007 to document enforced read-only policy

- **Status:** Done (Plan stage) — verify unchanged in Implement
- **Complexity:** Low
- **Dependencies:** none
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007, CORE-COMPONENT-0005, CORE-COMPONENT-0003

### Description
Update `project/architecture/core-components/CORE-COMPONENT-0007-permission-policy.md` **in
place** (it is an existing concrete doc, not a template — AGENTS.md forbids editing templates
only). Replace the "v0 wires a permissive handler / read-only is the documented target"
language with the reality that the policy is now **enforced** in member sessions. Document
the SDK `PermissionRequest` → `writes` mapping table (10 kinds + fail-closed default), the
memory decision (all `memory` → write), the no-path feedback/logging rule, and the SDK
result shapes (`approve-once` / `reject`). Keep API names matching the planned code
(`toPermissionRequestContext`, `createPermissionHandler`). Cross-link CORE-COMPONENT-0005.

### Acceptance Criteria
- [ ] Permissive-handler / "documented target" language is removed; enforcement is described.
- [ ] The 10-kind `writes` mapping table and the fail-closed `default` are present.
- [ ] The memory note documents that `action`/`direction` are not read/write and all
      `memory` is `writes: true`.
- [ ] The no-path rule (feedback + logs carry only `member`/`kind`/`decision`, plus `toolName`
      hint) is stated.
- [ ] SDK result shapes (`{ kind: "approve-once" }`, `{ kind: "reject"; feedback? }`) are listed.
- [ ] Enforcement checklist marks test-coverage requirements; doc cross-links CC-0005/CC-0003.
- [ ] The template (CORE-COMPONENT-0001) is **not** modified.

### Test Coverage
- Documentation task — no automated unit tests.
- **Verification:** `./harness lint` still passes (no code change); manual review that API
  names in the doc exactly match the symbols implemented in T3/T4. Markdown renders (table
  well-formed).

---

## Task T2: Update DECISION-LOG.md for the enforcement change (date 2026-06-20)

- **Status:** Done (Plan stage) — verify unchanged in Implement
- **Complexity:** Low
- **Dependencies:** T1
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007

### Description
Refresh `project/architecture/ADR/DECISION-LOG.md`: set the CORE-COMPONENT-0007 row date to
`2026-06-20`; refresh Decision #11 to reflect enforcement; and add decision records #14–#16
derived from the revised core-component's new enforceable rules. Every core-component change
must yield at least one decision record and update the log.

### Acceptance Criteria
- [ ] CORE-COMPONENT-0007 Core-Components row date is `2026-06-20`.
- [ ] Decision #11 reflects enforcement (not just "default"), dated `2026-06-20`.
- [ ] New decision records exist for: handler-from-policy-not-`approveAll` (#14),
      fail-closed classification incl. memory (#15), no-path feedback/logs (#16) — each
      imperative, verifiable, sourced to CORE-COMPONENT-0007, dated `2026-06-20`.
- [ ] No duplicate or renumbered existing rows; table formatting intact.

### Test Coverage
- Documentation task — no automated unit tests.
- **Verification:** manual review of the table; dates are `2026-06-20`; decision statements
  start with an imperative verb and are PR-verifiable.

---

## Task T3: Implement the pure `toPermissionRequestContext` SDK→policy mapper

- **Status:** To Do
- **Complexity:** Medium
- **Dependencies:** T1
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007, CORE-COMPONENT-0005

### Description
Create `src/runtime/permission-handler.ts` and export a pure, side-effect-free
`toPermissionRequestContext(request: PermissionRequest): PermissionRequestContext`. Implement
a 10-way `switch (request.kind)` with a **fail-closed `default`**:
- `read`, `url` → `{ writes: false, tool: request.kind }`
- `write`, `shell`, `extension-management`, `extension-permission-access`, `memory` →
  `{ writes: true, tool: request.kind }`
- `mcp`, `custom-tool`, `hook` → `{ writes: true, tool: request.toolName }`
- `default` (unknown/future/malformed) → `{ writes: true, tool: <kind ?? "unknown"> }`

Import `PermissionRequest` and `PermissionRequestContext` as types only (from
`@github/copilot-sdk` and `../permissions/policy.js`). **Never** read or copy `fileName`,
`path`, `diff`, `newFileContents`, `args`/`toolArgs`, `fullCommandText`, `possiblePaths`,
`url`, `fact`, `subject`, or `citations`. Use `.js` import specifiers (NodeNext). Do not
re-implement the read-only check here (that is T4's delegation to `policy.ts`).

### Acceptance Criteria
- [ ] `toPermissionRequestContext` is exported, pure, and side-effect free (**C3, E6**).
- [ ] Returns `{ writes: false }` for `read` and `url` (**C5**).
- [ ] Returns `{ writes: true }` for `write`, `shell`, `extension-management`,
      `extension-permission-access`, `memory`, `mcp`, `custom-tool`, `hook` (**C4, E3**).
- [ ] `default` branch returns `{ writes: true }` for unknown/future kinds (**E1**) and for
      malformed requests with missing/absent `kind` (**E2**).
- [ ] `tool` is `toolName` for `mcp`/`custom-tool`/`hook`, else `request.kind` (or `"unknown"`),
      and never contains a path, diff, args, URL, or memory fact (**C7**).
- [ ] No SDK objects are mutated; same input → same output (deterministic) (**E6**).
- [ ] Compiles under strict TS; passes `eslint`/`prettier`.

### Test Coverage
*(Co-located `src/runtime/permission-handler.test.ts`; vitest env is globally `node` — no
per-file pragma. Detail: tests TP-01…TP-03 in `03-test-plan.md`.)*
- [ ] **Required — table-driven** over all 10 kinds + an unknown kind + a malformed `{}`
      request, asserting the exact `{ writes }` value and that `tool` equals the expected
      hint and contains **no** path/args substring (covers **T-a**, and every `switch`
      branch incl. `default` and the `kind ?? "unknown"` nullish branch).
- [ ] **Required — memory invariance:** feed `memory` with `action: "store"`,
      `action: "vote"`, `direction: "upvote"`, `direction: "downvote"`, and absent
      action/direction → all assert `writes: true` (documents Decision 1) (**E3**).
- [ ] **Required — purity:** same request twice → deep-equal contexts; input object is not
      mutated (**E6**).
- [ ] Coverage: this file reaches 100% of mapper branches; contributes to the global >=80%.

---

## Task T4: Implement `createPermissionHandler` (fail-closed, single-sourced, logged)

- **Status:** To Do
- **Complexity:** Medium
- **Dependencies:** T3
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007, CORE-COMPONENT-0005, CORE-COMPONENT-0003

### Description
In `src/runtime/permission-handler.ts`, export
`createPermissionHandler(member: MemberConfig, logger?: Logger): PermissionHandler`. It must:
1. Build `const decide = createMemberPermissionPolicy(member)` (single-sourced rule —
   **translate then delegate**, do not re-implement).
2. Return a handler `(request) => PermissionRequestResult` that:
   - maps via `toPermissionRequestContext(request)`,
   - computes `decision = decide(context)`,
   - logs `logger?.info("permission.decision", { member: member.id, kind: request.kind, decision })`
     — **only** those three fields,
   - returns `{ kind: "reject", feedback: "Denied: member is read-only" }` when `decision === "deny"`,
     else `{ kind: "approve-once" }`.
3. Never throw, never return `undefined`, never return `{ kind: "no-result" }`.

Type the return against the SDK `PermissionHandler` / `PermissionRequestResult`. The
feedback string is a constant (no interpolation of request fields). The optional `logger`
must be safe when omitted (optional chaining).

### Acceptance Criteria
- [ ] Read-only member → `write`/`shell`/`memory`(any)/`extension-management` yield
      `{ kind: "reject", feedback: "Denied: member is read-only" }` (**C4, E3**).
- [ ] Read-only member → `read`/`url` yield `{ kind: "approve-once" }` (**C5**).
- [ ] `read-write` member → `write` yields `{ kind: "approve-once" }`; not over-locked (**C6, E4**).
- [ ] Read-only member → unknown/future kind and malformed request yield `{ kind: "reject" }`
      (**E1, E2**).
- [ ] Results are SDK-shaped (`approve-once`/`reject`) — never `"approve"`/`"deny"` strings (**T-e**).
- [ ] Each decision logs `permission.decision` with exactly `{ member, kind, decision }`
      through the injected `Logger`; no log when `logger` is omitted (no throw) (**C8**).
- [ ] `feedback` and the logged fields contain **no** filesystem path even when the request
      carries an absolute `fileName` (**C7**).
- [ ] Delegates to `createMemberPermissionPolicy` (the read-only check is not duplicated) (**E5**).
- [ ] Handler returns a valid SDK result for **every** `kind`; never throws / never
      `undefined` (**E7**); sequential calls on one handler are independent/deterministic (**E5**).

### Test Coverage
*(Co-located `src/runtime/permission-handler.test.ts`; detail TP-04…TP-09, TP-11 in
`03-test-plan.md`.)*
- [ ] **Required:** read-only denies a `write` and approves a `read` through the handler (**T-b**).
- [ ] **Required:** `read-write` approves a `write` (**T-c**).
- [ ] **Required:** read-only denies an ambiguous/unknown request (**T-d**).
- [ ] **Required:** assert returned objects equal `{ kind: "approve-once" }` /
      `{ kind: "reject", feedback: "Denied: member is read-only" }` (SDK-shaped) (**T-e**).
- [ ] **Required — security:** build a `write` request with an absolute `fileName`
      (e.g. `/home/user/secret/.env`); assert the reject `feedback` **and** the captured log
      fields (via an injected capturing fake `Logger`) contain no path substring (**T-f, C7**).
- [ ] **Required — logging:** with an injected capturing `Logger`, assert one
      `permission.decision` record per call with fields `{ member, kind, decision }` and
      nothing else; and a separate call with `logger` omitted does not throw (covers the
      `logger?` optional-chain both ways) (**C8**).
- [ ] **Required — robustness:** iterate all 10 kinds (+ unknown) asserting a valid SDK
      result is returned and nothing throws (**E7**); two sequential differing requests on
      the same handler return independent results (**E5**).
- [ ] Coverage: handler approve/deny + logger-present/absent branches fully exercised.

---

## Task T5: Wire the handler into `CopilotSessionFactory` and remove `approveAll`

- **Status:** To Do
- **Complexity:** Low
- **Dependencies:** T4
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007, CORE-COMPONENT-0005, CORE-COMPONENT-0004

### Description
Edit `src/runtime/copilot-session-factory.ts`:
- Remove `approveAll` from the `@github/copilot-sdk` import (it becomes unused; `eslint`
  `no-unused-vars` + `tsc` would otherwise fail).
- Inject a logger: add `logger?: Logger` as a second optional constructor param and store
  `this.logger = logger ?? createLogger()` (matches `CouncilRuntime`'s convention; the CLI
  does not construct this factory, so this is backward-compatible).
- In `createSession`, set `onPermissionRequest: createPermissionHandler(member, this.logger)`
  and update/remove the stale "v0 keeps approval simple" comment.
- Import `createPermissionHandler` from `./permission-handler.js` and `Logger`/`createLogger`
  from `../logging/logger.js` (`.js` specifiers).

### Acceptance Criteria
- [ ] `createSession` builds `onPermissionRequest` from `createPermissionHandler(member, this.logger)`;
      `approveAll` is no longer referenced (**C1**).
- [ ] The `approveAll` import is removed; `./harness lint` (eslint + tsc) passes with no
      unused-import/type errors (**C2**).
- [ ] The factory obtains its logger consistently with the rest of the runtime
      (constructor injection, default `createLogger()`).
- [ ] No behavioral change to `start`/`stop`/`sendAndWait`; stable `<councilId>/<memberId>`
      session id preserved (CORE-COMPONENT-0004).

### Test Coverage
*(Detail TP-12 in `03-test-plan.md`.)*
- [ ] **Lint/type gate (required):** `./harness lint` proves `approveAll` is gone and types
      are sound (primary evidence for **C1/C2**).
- [ ] **Optional — factory unit test:** only if any coverage metric drops below 80%, add a
      test with a fake `CopilotClient` that captures the `SessionConfig`, asserting
      `onPermissionRequest` is present, is **not** `approveAll`, and that invoking it with a
      read-only member + `write` request returns `{ kind: "reject" }`. Decide during T7.

---

## Task T6: Export the new module and update the repo map

- **Status:** To Do
- **Complexity:** Low
- **Dependencies:** T3, T4
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007, CORE-COMPONENT-0009

### Description
Add `export * from "./runtime/permission-handler.js";` to `src/index.ts` (parity with the
other modules) and add an `LLM.txt` row for `src/runtime/permission-handler.ts` describing it
(e.g. "SDK→policy permission mapping and fail-closed handler"). Keep ordering/style
consistent with existing entries.

### Acceptance Criteria
- [ ] `src/index.ts` re-exports `permission-handler.js` (public surface parity).
- [ ] `LLM.txt` lists `src/runtime/permission-handler.ts` with a one-line description
      (issue requirement #5; prevents repo-map drift).
- [ ] `./harness build` and `./harness lint` pass (export resolves; no duplicate symbols).

### Test Coverage
- No new unit test (re-export/docs).
- **Verification:** `./harness build` (tsc) confirms the re-export compiles; importing
  `createPermissionHandler`/`toPermissionRequestContext` from the package root resolves.

---

## Task T7: Validate the full suite, coverage, and harness verdict

- **Status:** To Do
- **Complexity:** Low
- **Dependencies:** T3, T4, T5, T6
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0007, CORE-COMPONENT-0009, CORE-COMPONENT-0005

### Description
Run the harness-first validation surface and confirm the read-only enforcement is green
end-to-end without regressing the existing suite. Decide whether the optional factory test
from T5 is needed to hold the 80% gate.

### Acceptance Criteria
- [ ] `./harness lint` = pass (eslint + prettier + tsc; no unused `approveAll`).
- [ ] `./harness test` = pass; coverage **>=80%** on lines/functions/branches/statements
      (**T-g**).
- [ ] `./harness build` = pass; `./harness verify` = pass.
- [ ] `src/permissions/policy.test.ts` is unchanged and still green (rule stays
      single-sourced) (**E5**).
- [ ] All issue acceptance criteria (C1–C8, E1–E7, T-a–T-g) are demonstrably satisfied by the
      tests in `03-test-plan.md`.

### Test Coverage
- [ ] Full `vitest run` via `./harness test` (unit + security + regression).
- [ ] Coverage report inspected; if any metric <80%, implement the optional factory test
      (T5) and re-run. Record any harness bypass with `./harness friction add`.
