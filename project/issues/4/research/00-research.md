# Research Brief: feat(security): enforce read-only member permissions in Copilot sessions

## GitHub Issue
- **Issue:** #4
- **Title:** feat(security): enforce read-only member permissions in Copilot sessions
- **State:** OPEN
- **Labels:** `enhancement`
- **Assignees:** none
- **Milestone:** none
- **Branch:** `feat/4-readonly-permissions`

## Scope Classification
- **Scope Type:** `issue`

**Rationale.** This issue *realizes and enforces* an architectural decision that already
exists; it does not make a new one. The read-only default is already decided
(DECISION-LOG Decision #11 "Default council members to read-only permissions",
sourced from `CORE-COMPONENT-0007: Permission Policy`), and the runtime topology
(one SDK session per member behind a `SessionFactory` seam) is already fixed by
`ADR-0002`. The pure decision function (`createMemberPermissionPolicy`) is already
implemented and unit-tested. The work is to *wire* that existing policy into the
live session handler via a small, pure SDK→policy mapping. That is an
implementation/security task within existing architecture — scope **`issue`**, not
`architecture_decision` or `core_component`.

## Problem Statement
Conclave grounds each council member in a real repository / working directory, so an
unconstrained member can mutate a developer's files. The PRD requires members be
read-only by default in v0 (`prd.md` council.yaml example: `tools: read-only`,
lines ~256–262; v0 permission sketch lines ~320–329). `CORE-COMPONENT-0007` codifies
"default council members to read-only permissions" (Decision #11).

The decision logic already exists and is unit-tested: `src/permissions/policy.ts`
exposes `createMemberPermissionPolicy(member)` (lines 21–29), a pure function returning
`(request: PermissionRequestContext) => "approve" | "deny"` that denies writes for
read-only members. **However it is decoupled and NOT wired into real sessions.**
`src/runtime/copilot-session-factory.ts` still passes `onPermissionRequest: approveAll`
from `@github/copilot-sdk` when creating each member session (line 34, import line 3).
Result: the read-only guarantee is documented and tested but **NOT enforced** — a
least-privilege / default-deny security gap. `CORE-COMPONENT-0007` even acknowledges
this gap: "v0 wires the SDK adapter with a permissive handler" (line 21).

**Goal of this issue.** Replace `approveAll` with a fail-closed handler derived from the
existing policy, keeping the SDK→policy translation in a small, pure, unit-testable
mapping function (suggested home: a new `src/runtime/permission-handler.ts` exporting
`toPermissionRequestContext(...)` and `createPermissionHandler(member)`), while keeping
the approve/deny rule single-sourced in `policy.ts`.

## Existing Context

### Source code touchpoints (verified)
| File | Relevant detail |
|------|-----------------|
| `src/permissions/policy.ts` | `PermissionRequestContext { writes?: boolean; tool?: string }` (lines 5–10); `PermissionDecision = "approve" \| "deny"` (line 3); `createMemberPermissionPolicy(member)` — `readOnly = member.tools !== "read-write"`, denies when `readOnly && request.writes === true`, else approves (lines 21–29). **Pure, SDK-decoupled. Keep as the single source of the rule.** |
| `src/permissions/policy.test.ts` | 5 tests covering deny-write / approve-read / approve-missing-writes for read-only, and approve-write / approve-read for read-write. These remain valid and should not regress. |
| `src/runtime/copilot-session-factory.ts` | `import { ..., approveAll, ... }` (line 3); `createSession(member, councilId)` builds `SessionConfig` with `onPermissionRequest: approveAll` (line 34) and comment "v0 keeps approval simple; read-only enforcement is layered on later" (line 33). **This is the call site to change.** No co-located test exists for this file today. |
| `src/runtime/council-runtime.ts` | `SessionFactory` interface (lines 20–24); `CouncilRuntime.start()` calls `sessionFactory.createSession(member, name)` and logs `session.created` with `{ member, cwd }` (lines 50–56). Provides the in-memory fake pattern used by tests. |
| `src/logging/logger.ts` | `createLogger(minLevel?)` → `Logger { debug/info/warn/error(message, fields?) }` (lines 5–10, 23). Emits line-delimited JSON with `ts/level/message/...fields`. **Use this for the per-decision log; pass only `{ member, kind, decision }` — never paths** (CORE-COMPONENT-0005). |
| `src/config/council-config.ts` | `MemberTools = "read-only" \| "read-write"` (line 5); `MemberConfig { id; cwd; role; agent?; tools }` (lines 7–13); `validateMember` defaults `tools` to `read-only` unless explicitly `read-write` (line 58). |
| `src/index.ts` | Re-exports every module (`export * from "./permissions/policy.js"`, `"./runtime/copilot-session-factory.js"`, etc., lines 1–9). A new `permission-handler.ts` should be exported here for parity. |
| `LLM.txt` | Repo map; lists `src/permissions/policy.ts` (line 44) and `src/runtime/copilot-session-factory.ts` (line 42). **Must add a row if a new module file is created** (issue requirement #5). |

### SDK ground truth — `@github/copilot-sdk@1.0.2` (verified against installed `.d.ts` / `.js`)
The issue's plan is largely correct, but several details were verified against the real
SDK and **one assumption does not match the installed types** (see Risks #1).

**Handler + result shapes**
- `PermissionHandler = (request: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult> | PermissionRequestResult` — `dist/types.d.ts:726–728`. The second arg is `invocation`, and it carries **`sessionId`** (the issue's `invocation: { sessionId }` is correct).
- `approveAll` is declared `dist/types.d.ts:729`; its runtime impl is `const approveAll = () => ({ kind: "approve-once" });` — `dist/types.js:92`. So the current behavior is "approve every request once".
- `PermissionRequestResult = PermissionDecisionRequest["result"] | { kind: "no-result" }` — `dist/types.d.ts:723–725`. `PermissionDecisionRequest.result: PermissionDecision` — `dist/generated/rpc.d.ts:6569–6575`.
- `PermissionDecision` union — `dist/generated/rpc.d.ts:906`. The two members this issue uses:
  - **Approve:** `PermissionDecisionApproveOnce` → `{ kind: "approve-once" }` — `rpc.d.ts:6028–6033`.
  - **Deny:** `PermissionDecisionReject` → `{ kind: "reject"; feedback?: string }` — `rpc.d.ts:6384–6393`.
- **Do not return `{ kind: "no-result" }`** — README notes it is "only valid with protocol v1; rejected by protocol v2 servers" (`README.md:910`). Handler must always return `approve-once` or `reject`.
- Authoritative custom-handler pattern (switch on `request.kind`, return `{ kind: "reject", feedback }` / `{ kind: "approve-once" }`, "include a default case") — `README.md:863–896`; result-kind table `README.md:898–910`.
- `SessionConfig.onPermissionRequest?: PermissionHandler` — `dist/types.d.ts:1450`.

**`PermissionRequest` discriminated union (`dist/generated/session-events.d.ts:277`) — EXACTLY 10 variants.** Proposed `writes` mapping (per the issue's fail-closed intent) and the non-sensitive `tool` hint:

| `kind` | Interface (file:line) | Notable fields (verbatim from `.d.ts`) | Carries `toolName`? | Proposed `writes` | Path/secret fields to **NOT** copy |
|--------|-----------------------|----------------------------------------|---------------------|-------------------|------------------------------------|
| `read` | `PermissionRequestRead` 4723–4740 | `path`, `intention`, `toolCallId?` | no → hint = `kind` | `false` (inert) | `path` |
| `url` | `PermissionRequestUrl` 4779–4796 | `url`, `intention`, `toolCallId?` | no → `kind` | `false` (workspace not mutated; egress is a deliberate follow-up) | `url` |
| `write` | `PermissionRequestWrite` 4690–4719 | `fileName`, `diff`, `newFileContents?`, `intention`, `toolCallId?` | no → `kind` | `true` | `fileName`, `diff`, `newFileContents` |
| `shell` | `PermissionRequestShell` 4623–4664 | `fullCommandText`, `possiblePaths[]`, `possibleUrls[]`, `commands[]` (`{identifier, readOnly}`), `hasWriteFileRedirection`, `intention`, `warning?` | no → `kind` | `true` (least-privilege) | `fullCommandText`, `possiblePaths` |
| `extension-management` | `PermissionRequestExtensionManagement` 4885–4902 | `operation`, `extensionName?`, `toolCallId?` | no → `kind` | `true` | — (no path) |
| `extension-permission-access` | `PermissionRequestExtensionPermissionAccess` 4906–4923 | `capabilities[]`, `extensionName`, `toolCallId?` | no → `kind` | `true` (fail-closed) | — |
| `mcp` | `PermissionRequestMcp` 4744–4775 | `toolName`, `toolTitle`, `serverName`, `args?`, **`readOnly: boolean`**, `toolCallId?` | **yes** → `toolName` | `true` (fail-closed) | `args` |
| `custom-tool` | `PermissionRequestCustomTool` 4831–4854 | `toolName`, `toolDescription`, `args?`, `toolCallId?` | **yes** → `toolName` | `true` (fail-closed) | `args` |
| `hook` | `PermissionRequestHook` 4858–4881 | `toolName`, `hookMessage?`, `toolArgs?`, `toolCallId?` | **yes** → `toolName` | `true` (fail-closed) | `toolArgs` |
| `memory` | `PermissionRequestMemory` 4800–4827 | `action?`, `direction?`, `fact`, `subject?`, `citations?`, `reason?`, `toolCallId?` | no → `kind` | **see Risk #1** | `fact`, `subject`, `citations` |

- **`tool` hint rule:** use `request.toolName` for `mcp` / `custom-tool` / `hook`; otherwise use `request.kind`. Never copy `fileName` (write), `path` (read), `possiblePaths`/`fullCommandText` (shell), `url` (url), or `fact`/`subject` (memory) into the context, feedback, or logs (satisfies the "no absolute paths" AC and the security test).
- **Future-kind safety:** the union may grow; the mapper's `default` branch must return `{ writes: true }` (fail-closed), satisfying the "unrecognized/future kind" edge case.

### Conventions (verified against repo config)
- **Test runner:** `vitest`; `vitest.config.ts` sets `environment: "node"` **globally**, `include: ["src/**/*.test.ts"]`. ⇒ New SDK/node tests **do NOT need a `// @vitest-environment node` directive** — node is already the default. (See Risk #6: this corrects a common assumption.)
- **Coverage gate:** v8 provider, thresholds **80%** for lines/functions/branches/statements; `include: ["src/**/*.ts"]`, `exclude: ["src/**/*.test.ts", "src/cli.ts"]`. ⇒ Any new `src/runtime/permission-handler.ts` is **included** and must be exercised to ≥80% on all four metrics (the 10-way `kind` switch + memory sub-branches + default ⇒ tests must hit every branch).
- **Tests co-located** as `*.test.ts` next to source (e.g. `policy.test.ts`). Tests use fabricated objects / in-memory fakes — no live `CopilotClient` (see `council-runtime.test.ts`'s `fakeFactory`).
- **ESM + NodeNext:** import specifiers use `.js` extensions (`./policy.js`) — `ADR-0002` Negative consequence.
- **Logging:** structured only, dotted stable event names via `createLogger` (CORE-COMPONENT-0005); no `console.log`.
- **Baseline is green:** `./harness test` ⇒ 5 files / **18 tests passed**, verdict `pass`; `./harness orient` / `./harness verify` ⇒ `pass`.

### Related ADRs and Core-Components
- **`ADR-0002` — TypeScript + GitHub Copilot SDK Multi-Session Runtime** (Accepted): establishes the `@github/copilot-sdk` runtime, Model A (one session per member), and the `SessionFactory` seam this issue plugs into. No change needed.
- **`CORE-COMPONENT-0007` — Permission Policy** (Adopted): the governing component. Lines 19–21 currently say the policy is the "documented target" and "v0 wires the SDK adapter with a permissive handler … enforced as the orchestrator gains tool-routing (PRD v1)". **This issue closes that gap and the doc must be updated** (see Proposed Core-Components).
- **`CORE-COMPONENT-0005` — Logging and Observability** (Adopted): governs the per-decision structured log.
- **`CORE-COMPONENT-0003` — Configuration** (Adopted): source of `tools: read-only | read-write` and the read-only default (Decision #6).
- **DECISION-LOG Decision #11** ("Default council members to read-only permissions", source CORE-COMPONENT-0007, 2026-06-18): the decision being enforced.

## Proposed ADRs
**None required.** No new architectural decision is introduced. The runtime topology
(`ADR-0002`) and the read-only default (Decision #11 / CORE-COMPONENT-0007) already
exist; this issue only enforces them through existing seams. The `url` → not-denied
choice and the "fail-closed for ambiguous kinds" choice are *implementations* of the
already-adopted read-only/least-privilege posture, not new architecture.

*Listed for the Plan stage's consideration only — NOT required for this issue:* should
the team later decide to govern **network egress** (denying/allow-listing `url`/MCP
network access) as a first-class policy axis, that broader capability model would
warrant a future ADR (e.g. *"ADR-000X: Member network-egress and capability policy"*).
The issue explicitly defers egress as "a deliberate follow-up", so it is out of scope
here. The Plan stage owns any decision to open such an ADR.

## Proposed Core-Components
**No NEW core-component required.** The new `src/runtime/permission-handler.ts` module
is an *implementation* of the existing `CORE-COMPONENT-0007: Permission Policy`, not a
new component. Instead, this issue should **UPDATE existing docs** (the Plan stage
decides exact wording; this brief only flags the required edits):

1. **`CORE-COMPONENT-0007` — Permission Policy (UPDATE):**
   - Revise the "v0 wires the SDK adapter with a permissive handler … enforced … (PRD v1)"
     language (line 21) to state that enforcement is now wired into live sessions via a
     pure SDK→policy mapping (`toPermissionRequestContext`) and a fail-closed handler
     (`createPermissionHandler`), with the approve/deny rule still single-sourced in
     `policy.ts`.
   - Document the SDK→`writes` mapping table (the 10 `kind`s), the fail-closed default,
     the no-path/secret logging rule, and the SDK result shapes
     (`approve-once` / `reject`).
   - Cross-link `CORE-COMPONENT-0005` (logging) since each decision is now logged.
   - Tighten the Enforcement checklist (it can now claim test-coverage enforcement).
2. **`DECISION-LOG.md` (UPDATE):** the issue asks to "correct the date" of the relevant
   entry. Decision #11 and the CORE-COMPONENT-0007 row are currently dated `2026-06-18`;
   if CORE-COMPONENT-0007 is materially revised, refresh its row/Decision date to the
   update date (today is `2026-06-20`). **The exact date/row treatment is a docs-hygiene
   choice for the Plan/Implement stage — not decided here.** No *new* Decision row is
   needed (Decision #11 already states the rule).
3. **`LLM.txt` (UPDATE):** add a row for `src/runtime/permission-handler.ts` if that
   module is created (issue requirement #5), and optionally export it from `src/index.ts`
   for parity with the other modules.

## Acceptance Criteria (from issue)
<!-- Extracted verbatim from issue #4 (between the ACCEPTANCE_CRITERIA markers). -->

**Core**
- [ ] `CopilotSessionFactory.createSession` derives `onPermissionRequest` from `createMemberPermissionPolicy(member)` and no longer passes `approveAll`.
- [ ] The unused `approveAll` import is removed from `copilot-session-factory.ts`.
- [ ] A pure, exported mapping function translates the SDK `PermissionRequest` (discriminated by `kind`) into `PermissionRequestContext` (`{ writes?, tool? }`) without side effects.
- [ ] For a read-only member, write/mutating requests (`write`, `shell`, write-direction `memory`, `extension-management`) are denied via `{ kind: "reject" }`.
- [ ] For a read-only member, read/inert requests (`read`, `url`) are approved via `{ kind: "approve-once" }`.
- [ ] For a `read-write` member, write requests are approved.
- [ ] Denial feedback and any decision logs contain no absolute filesystem paths (no `fileName`/`workingDirectory`).
- [ ] Each permission decision is logged through the structured logger with `member`, request `kind`, and `decision`.

**Edge Cases**
- [ ] An unrecognized/future `kind` is treated as a write and denied for read-only members (fail-closed).
- [ ] A request lacking an explicit mutation signal / missing variant fields is treated conservatively as a write for read-only members.
- [ ] A read-direction `memory` request is approved for a read-only member; a write-direction or missing-direction `memory` request is denied.
- [ ] A `read-write` member is not over-locked: writes remain approved (functional override verified).
- [ ] Multiple sequential requests on the same session are each evaluated independently and deterministically.
- [ ] Concurrent/parallel permission evaluations are safe (mapper + policy are pure and stateless).
- [ ] The handler never returns `undefined` and never throws — every path returns a valid SDK `PermissionRequestResult`.

**Testing**
- [ ] Unit test: the mapping function returns the correct `{ writes }` for each known `kind` (read/url → false; write/shell/extension-management → true; mcp/custom-tool/hook/unknown → true; memory by direction).
- [ ] Unit test: a read-only member denies a write request and approves a read request through the built handler.
- [ ] Unit test: a `read-write` member approves a write request.
- [ ] Unit test: an ambiguous/unknown request is denied for a read-only member.
- [ ] Unit test: the handler returns SDK-shaped results (`{ kind: "approve-once" }` / `{ kind: "reject" }`), not internal `"approve"`/`"deny"` strings.
- [ ] Security test: a denial result's `feedback` and the emitted log contain no filesystem path even when the request carries a `fileName`.
- [ ] Tests use fabricated `PermissionRequest` objects (no live `CopilotClient`/session) and keep coverage ≥80%.

## Risks and Open Questions

1. **🔴 BLOCKER for Plan — `memory` has no read/write "direction" in the installed SDK.**
   The issue's mapping ("read-direction `memory` → approve; write/missing-direction →
   deny") and the matching AC assume a read-vs-write direction that **does not exist** in
   `@github/copilot-sdk@1.0.2`. The real `PermissionRequestMemory`
   (`session-events.d.ts:4800–4827`) carries:
   - `action?: "store" | "vote"` (`PermissionRequestMemoryAction`, `session-events.d.ts:281`)
   - `direction?: "upvote" | "downvote"` (`PermissionRequestMemoryDirection`, `session-events.d.ts:289`)

   `direction` is the **vote sentiment**, not read/write. The Plan stage must re-express
   the memory rule against real fields **without changing the AC's intent** (fail-closed,
   least-privilege). Candidate interpretations for Plan to choose among (do not decide
   here): (a) **strict fail-closed** — treat *all* `memory` as `writes: true` (deny for
   read-only), the safest reading since memory mutates persistent state and there is no
   provably-inert variant; (b) **semantic** — treat `action: "vote"` as inert
   (`writes: false`) and `action: "store"` / missing `action` as `writes: true`. Note the
   SDK README prose calls memory "storing or retrieving persistent session memory"
   (`README.md:880`), but the typed union models only `store`/`vote`. Recommendation to
   surface (not a decision): option (a) most cleanly satisfies "missing-direction memory
   denied" and the fail-closed AC; the AC wording may need a one-line clarification in
   Plan to map "read-direction" → the chosen inert case.

2. **`mcp.readOnly` (boolean) and shell hints exist but the issue chooses to ignore them.**
   `PermissionRequestMcp.readOnly` (`session-events.d.ts:4758`),
   `PermissionRequestShell.commands[].readOnly` (4676) and `.hasWriteFileRedirection`
   (4639) could *refine* the write classification. The issue deliberately treats `mcp`,
   `custom-tool`, `hook`, and `shell` as writes (fail-closed). Open question for Plan:
   stay strictly fail-closed (recommended by the AC) or honor `readOnly` hints as a
   future usability refinement? Default per the AC: **fail-closed (`writes: true`).**

3. **Path/secret leakage is the core security AC — enumerate every sink.** The mapper,
   the `feedback` string, and the log fields must exclude: `write.fileName`/`diff`/
   `newFileContents`, `read.path`, `shell.fullCommandText`/`possiblePaths`,
   `url.url`, `memory.fact`/`subject`/`citations`, `mcp/custom-tool/hook.args`/`toolArgs`,
   and the session `workingDirectory`. Safe-to-log fields: `kind`, `decision`, `member`,
   and (for mcp/custom-tool/hook) `toolName`. The security test should construct a
   `write` request with a real `fileName` and assert neither `feedback` nor the captured
   log line contains it. Consider injecting a capturing fake `Logger` in tests.

4. **Handler robustness (never throw / never `undefined`).** A malformed or partial
   `PermissionRequest` (missing variant fields) must still resolve deterministically —
   the mapper's `default`/missing-field paths return `{ writes: true }`, and the handler
   always returns `approve-once` or `reject`. Avoid returning `{ kind: "no-result" }`
   (rejected by protocol-v2 servers, `README.md:910`).

5. **Factory testability / coverage.** `copilot-session-factory.ts` has no co-located
   test today and is hard to unit-test directly (it builds a live `SessionConfig`). Keep
   `createSession` thin and put all logic in the pure `permission-handler.ts` so coverage
   is earned by fabricated-request unit tests (per the AC). The factory change is just
   "build handler from policy + log; drop `approveAll` import". If the suite ever
   approaches the 80% global gate, a tiny test asserting `createSession` wires a non-
   `approveAll` handler (via a fake `CopilotClient`) may be warranted — Plan's call.

6. **Convention correction — vitest env is `node`, not `jsdom`.** `vitest.config.ts`
   sets `environment: "node"` globally, so new SDK/node tests do **not** need a
   `// @vitest-environment node` directive (contrary to a common assumption). No
   per-file env pragma is required.

7. **Exports + repo map drift.** If `permission-handler.ts` is added, update `LLM.txt`
   and (for parity) `src/index.ts` re-exports; otherwise the public surface and repo map
   drift. The mapping function and `createPermissionHandler` are reasonable public
   exports for testing/reuse.

8. **Single-sourcing the rule.** Keep the approve/deny decision in
   `createMemberPermissionPolicy` (`policy.ts`). The new module must *translate then
   delegate* — it must not re-implement the read-only check — preserving the existing
   `policy.test.ts` as the rule's source of truth.

### Handoff note for the Plan stage
Recommended (proposed, not decided) shape, consistent with the issue and SDK:
`src/runtime/permission-handler.ts` exporting (1) pure
`toPermissionRequestContext(request: PermissionRequest): PermissionRequestContext`
(10-way `kind` switch + fail-closed `default`), and (2)
`createPermissionHandler(member, logger?): PermissionHandler` that maps → calls
`createMemberPermissionPolicy(member)` → returns `{ kind: "approve-once" }` or
`{ kind: "reject", feedback: "Denied: member is read-only" }` and logs
`{ member: member.id, kind: request.kind, decision }` via the structured logger. The
**memory mapping (Risk #1) and the date/doc edits (Proposed Core-Components) are the two
items Plan must resolve before Implement.**
