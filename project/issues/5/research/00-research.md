# Research Brief: feat(runtime) — implement `council run` fixed backlog phases and artifact generation

## GitHub Issue
- **Issue:** #5
- **Title:** feat(runtime): implement `council run` fixed backlog phases and artifact generation
- **State:** OPEN
- **Labels:** `enhancement`
- **Branch:** `feat/5-council-run` (worktree at `.trees/issue-5`)

## Scope Classification
- **Scope Type:** `issue`

**Justification.** This is a feature that orchestrates **already-merged** building
blocks into a fixed v0 council flow and wires it to the `council run` CLI verb. Every
foundational seam it depends on already exists and is already governed by an adopted
architectural artifact:

- runtime topology (one SDK session per member, behind a `SessionFactory`/`MemberSession`
  seam, decoupled from `@github/copilot-sdk`) — **ADR-0002** + **CORE-COMPONENT-0004**;
- `CouncilRuntime.start()/askMember()/stop()` — **CORE-COMPONENT-0004** (already implemented,
  `src/runtime/council-runtime.ts`);
- file-based transcript + artifacts as the source of truth, all writes via the stores —
  **CORE-COMPONENT-0006** (`src/store/{transcript,artifact}-store.ts`);
- structured dotted-event logging — **CORE-COMPONENT-0005** (`src/logging/logger.ts`);
- typed `CouncilError` taxonomy with stable codes + preserved `cause` — **CORE-COMPONENT-0008**
  (`src/errors.ts`);
- normalized `CouncilConfig` consumption + read-only members — **CORE-COMPONENT-0003** /
  **CORE-COMPONENT-0007**;
- ESM/NodeNext + commander + vitest `node` env + ≥80% coverage — **ADR-0002** /
  **CORE-COMPONENT-0009**.

The work introduces **no new technology choice and no new runtime topology**. It composes
existing contracts behind a new, fake-testable function (`runBacklogCouncil`) and adds one
error subclass (`OrchestrationError`) whose **code must be registered** in the existing
CORE-COMPONENT-0008 (a doc update, not a new component). ADR-0002's own Consequences note
explicitly anticipates this: *"The orchestration phases remain to be designed and implemented
in subsequent issues."* Therefore scope is an ordinary feature **`issue`**, not an
`architecture_decision` or `core_component`.

**Two decision-bearing items the Plan stage must ratify** (researcher proposes, does not
decide) — these are the *only* reasons a DECISION-LOG row and/or a core-component edit may be
required (detailed in **Proposed Core-Components**):
1. **Policy semantics, defaults, and precedence** (§8 of the issue) + the **role-resolution
   heuristic** are new, durable behavioral contracts → likely a **DECISION-LOG** row (and
   wording in CORE-COMPONENT-0004/0006).
2. The optional **`orchestrator.roles` config mapping** is **dropped by the current
   `validateCouncilConfig`** (verified below) → supporting it requires a **CORE-COMPONENT-0003**
   schema/validator change. The Plan must choose: extend CC-0003, or ship **heuristic-only** in
   v0 (keeping the orchestrator a pure consumer).

## Problem Statement

`council run <name>` is the heart of the Conclave v0 MVP but is currently a **stub**.
In `src/cli.ts` (lines 40–49) the `run` action loads + validates `council.yaml`, logs
`council.run`, then calls `notImplemented("run")` (lines 9–12) which writes to stderr and
sets `process.exitCode = 1`. Nothing orchestrates members into a council, and no durable
artifacts are produced.

The foundational runtime is merged and working:
- `CouncilRuntime` exposes `start()` (creates one session per member), `askMember(id, prompt)`
  (sends a prompt, appends the exchange to the transcript, returns the response string), and
  `stop()` (`src/runtime/council-runtime.ts:47–72`).
- The `SessionFactory`/`MemberSession` seam (`council-runtime.ts:12–24`) keeps orchestration
  decoupled from the SDK and unit-testable with an in-memory fake.
- `TranscriptStore.append` and `ArtifactStore.write` provide append-only transcript and
  path-guarded artifact persistence (`src/store/`).

What is missing is the **decoupled phase orchestrator**: a fixed v0 flow
(project/context summary → backlog draft → optional project validation → refinement →
artifact generation) that drives `CouncilRuntime`, honors orchestrator policy
(`writeArtifacts`, `requireProjectValidation`, `maxRounds`), resolves logical member roles
(context source + backlog author) **without hardcoding member ids**, writes durable
artifacts via `ArtifactStore.write`, and raises **typed errors** instead of returning silent
empties. The PRD describes exactly this (`prd.md` "MVP", "Internally" steps 1–10, and the
`runBacklogCouncil` pseudo-code lines 359–414).

**Goal of this issue:** add `src/runtime/council-phases.ts` exporting
`runBacklogCouncil(runtime, config, options?)` (pure, fake-testable, **no SDK import**),
add `OrchestrationError`, and replace the `notImplemented("run")` stub with a real run that
builds the stores + factory + runtime, runs the phases, maps `CouncilError` → a non-zero exit,
and always calls `runtime.stop()` in a `finally` block.

This brief is **research only**. It inspects the codebase, classifies scope, maps each
acceptance criterion to an existing module/contract, empirically verifies three correctness
traps, and *proposes* (does not decide) ADR/core-component work. The implementation seam below
is a recommendation for the Plan stage.

## Existing Context

### Harness baseline (operating surface)
`./harness orient` → Verdict **pass**; Node `v24.17.0`; package manager npm; test runner
vitest; bundler `tsc`. The contract (`.harness/contract.yml`) exposes
`help | orient | doctor | lint | test | build | boot | verify | status | clean |
friction_add | friction_list`. The issue's final gate is `./harness verify`
(= `lint + test + build`, incl. the 80% coverage thresholds). Researcher used only read-only
harness/`gh`/`node --import tsx` probes; **no source, ADRs, or core-components were modified.**

### The stub to replace and the CLI wiring contract
| Location | Detail |
|---|---|
| `src/cli.ts:40–49` | `run` command. Loads config via `loadCouncilConfig(options.config)`, logs `council.run` `{ council, members, goal }`, then `notImplemented("run")`. **This action body is what the issue replaces.** |
| `src/cli.ts:9–12` | `notImplemented(command)` → stderr + `exitCode = 1`. To be removed for `run`. |
| `src/cli.ts:60–65` | Top-level `program.parseAsync(...).catch(...)` logs `council.error` with **`{ error: message }` only (no `code`)** and sets `exitCode = 1`. The issue wants the `run` path to log a structured **`code` + message** record → the run action should catch `CouncilError` itself (or the top-level catch must be enhanced). **Flag for Plan.** |
| `vitest.config.ts:10` | Coverage **excludes `src/cli.ts`**. → Keep `cli.ts` thin; **all** orchestration logic lives in the covered `council-phases.ts`. |

### Runtime / store / error seams the orchestrator must use (verified signatures)
| File:line | Signature / fact the orchestrator depends on |
|---|---|
| `src/runtime/council-runtime.ts:12–14` | `interface MemberSession { sendAndWait(prompt: string): Promise<string> }` |
| `council-runtime.ts:20–24` | `interface SessionFactory { start(); createSession(member, councilId); stop(); }` — fake target for unit tests. |
| `council-runtime.ts:59–67` | `askMember(memberId, prompt)`: `this.sessions.get(memberId)`; **throws `SessionError("Unknown council member: …")`** if missing; awaits `session.sendAndWait(prompt)`; **then** `await transcript.append({ member, prompt, response })`; returns `response`. **Two consequences:** (a) transcript append is automatic per turn — the orchestrator must **not** double-append; (b) if `sendAndWait` throws, the append is skipped for that turn but **all prior turns persist** (satisfies the "member throws mid-phase → transcript preserved" AC). |
| `council-runtime.ts:69–72` | `stop()` → `sessionFactory.stop()` then clears the map. Orchestrator/CLI must call this in `finally`. |
| `src/store/transcript-store.ts:18–36` | `append(turn)`: `mkdir -p`, then **`appendFile`** an `## member — ISO-timestamp` block (prompt + response, each `.trim()`ed) ending in `---`. Append-only across re-runs (never truncates). |
| `src/store/artifact-store.ts:14–25` | `write(relativePath, content): Promise<string>` — resolves under `baseDir`, **rejects traversal**, `mkdir -p`, `writeFile` (overwrite-in-place), returns the absolute path. **Throws a plain `Error` on traversal, NOT a `CouncilError`** (verified — see Empirical findings #2). |
| `src/errors.ts:5–27` | `CouncilError { readonly code; constructor(message, code, { cause? }) }`; `ConfigError` (`CONFIG_ERROR`); `SessionError` (`SESSION_ERROR`). `OrchestrationError` (`ORCHESTRATION_ERROR`) must be **added here** and exported via `src/index.ts`. |
| `src/config/council-config.ts:15–33` | `OrchestratorPolicy { maxRounds?: number; requireProjectValidation?: boolean; writeArtifacts?: boolean }` (**camelCase**); `OrchestratorConfig { cwd; model?; policy? }` (**no `roles` field**); `CouncilConfig { name; goal; members[]; orchestrator; artifacts: string[] }`; `MemberConfig { id; cwd; role; agent?; tools }`. |
| `src/logging/logger.ts:5–10,23` | `createLogger(minLevel?)` → `Logger { debug/info/warn/error(message, fields?) }`; line-delimited JSON; **`info`/`debug` → stdout, `warn`/`error` → stderr.** |
| `src/index.ts:1–10` | Re-exports every module. Add `export * from "./runtime/council-phases.js"`; `OrchestrationError` is re-exported via the existing `export * from "./errors.js"`. |

### Empirical findings (verified against the live code, not just asserted)
Run with `node --import tsx --input-type=module` against the real modules:

1. **`validateCouncilConfig` does NOT validate policy field types/ranges.** Input
   `policy: { maxRounds: -3.5, requireProjectValidation: "yes", writeArtifacts: 0 }` returned
   **unchanged** (`maxRounds` stayed `number -3.5`; the non-boolean values passed straight
   through). The policy is cast `as OrchestratorPolicy` with no per-field checks
   (`council-config.ts:92–95`). **Implication:** the issue's §8 rule *"a non-integer/negative
   `maxRounds` raises `ConfigError`"* and the contradiction rule **cannot rely on the config
   loader** — the orchestrator (or a dedicated policy-normalization step) must validate
   `maxRounds` (integer, `>= 0`) and defensively coerce the booleans. This **reconciles** the
   issue's two statements: *"consume the already-normalized config; do not re-validate"* refers
   to **structural** validation (name/members/cwd), while §8 adds **policy-semantic** checks the
   loader never performed.
2. **`ArtifactStore.write` throws a plain `Error` on traversal**, not a `CouncilError`
   (`e instanceof CouncilError === false`, class `Error`). **Implication:** to satisfy *"an
   artifact write failure raises a typed error wrapping the cause"* and *"validate `config.artifacts`
   paths … return a typed error on traversal,"* the orchestrator must **catch and wrap**
   every `ArtifactStore.write` failure in `OrchestrationError` (preserving `cause`). It cannot
   assume the store throws a typed error.
3. **`validateCouncilConfig` DROPS `orchestrator.roles`.** Input
   `orchestrator: { cwd: ".", roles: { context: "m1", backlog: "m2" }, policy: {} }` normalized
   to `{ cwd: ".", policy: {} }` — `roles` is **gone**, because the validator reconstructs the
   orchestrator object with **only** `cwd`/`model`/`policy` (`council-config.ts:89–96`). The
   top-level "unknown keys are ignored" forward-compat rule (CC-0003) does **not** apply here
   because the nested object is rebuilt field-by-field. **Implication:** the proposed explicit
   `orchestrator.roles: { context, backlog }` mapping is **not reachable** by the orchestrator
   today. Supporting it requires extending CC-0003's `OrchestratorConfig` type **and**
   `validateCouncilConfig` to parse/preserve `roles` — a contract change. This is the single
   biggest core-component decision for the Plan (see Proposed Core-Components).

### Cross-issue interaction: what `council init` (#6, merged) actually scaffolds
`src/commands/init.ts:107–131` generates a `council.yaml` with:
- **a single member** (`id: project-x`, role *"Source of truth for the target project"*,
  `agent: project-architect`, `tools: read-only`), and
- `artifacts: ["artifacts/backlog.md", "artifacts/epics.md"]` (**no `open-questions.md`**),
- `policy: { maxRounds: 5, requireProjectValidation: true, writeArtifacts: true }`.

Two consequences for #5:
- **Out-of-the-box `init` → `run` will (correctly) fail role resolution.** A single-member
  council cannot yield **both** a context source and a backlog author, so `runBacklogCouncil`
  **must** raise a typed error (per the AC *"a council lacking both required roles (e.g. a
  single-member council) raises a typed error"*). The user must add a backlog-author member
  first (via `council add-member`, a separate stubbed verb). This is expected fail-closed
  behavior, but the **error message must be actionable** (name the missing role) and is worth
  noting as a known end-to-end UX gap until `add-member` lands.
- **The artifacts-list default matters in practice.** Because the scaffolded list omits
  `open-questions.md`, the orchestrator's *"paths taken from `config.artifacts` (matched by
  filename), defaulting to backlog/epics/open-questions"* logic must supply a **default path**
  for any of the three not present in `config.artifacts`. Test this explicitly.

### Acceptance-criterion → module / governing contract map
| AC theme | Where it lands | Governing contract |
|---|---|---|
| Replace `notImplemented("run")`; thin action delegates to `runBacklogCouncil` | `src/cli.ts` (action) + new `src/runtime/council-phases.ts` (logic) | ADR-0002; coverage rule (`cli.ts` excluded) |
| `council-phases.ts` depends only on runtime/stores; **no `@github/copilot-sdk` import**; fake-`SessionFactory` runnable | new module | ADR-0002 (Decision #5/#7); CC-0004 |
| Phases in order: context → draft → (validation) → refinement via `CouncilRuntime.askMember` | new module sequencing | CC-0004; PRD steps 4–7 |
| Role ids resolved from config (explicit `orchestrator.roles` or documented heuristic); no hardcoded `project-x`/`scrum-sme` | new module resolver | CC-0003 (config shape); **decision-bearing** |
| `writeArtifacts` → `artifacts/{backlog,epics,open-questions}.md` via `ArtifactStore.write`, paths derived from `config.artifacts` | new module + `ArtifactStore` | CC-0006 |
| Every exchange appended to transcript, append-only across re-runs | automatic inside `askMember` → `TranscriptStore.append` | CC-0006 |
| Policy honored (`requireProjectValidation`, `writeArtifacts`, `maxRounds`) w/ documented defaults/precedence | new module policy gate | CC-0003 consumption; **decision-bearing** (§8) |
| `runtime.stop()` in `finally` on every path; `stop()` failure doesn't mask original error | new module + CLI `try/finally` | CC-0004 |
| Add `OrchestrationError` (`ORCHESTRATION_ERROR`), export from `index.ts`, register in CC-0008 | `src/errors.ts` + `src/index.ts` + CC-0008 doc | CC-0008 |
| Re-run overwrites artifacts in place, appends (not truncate) transcript | `ArtifactStore.write` (overwrite) + `TranscriptStore.append` | CC-0006 |
| Typed errors: unknown/unresolved/ambiguous role, blank response, contradictory policy, artifact write failure | new module raises `OrchestrationError`/`ConfigError`; wraps `cause` | CC-0008 |
| Stable dotted log events (`phase.*.start`, `phase.validation.skipped`, `phase.artifacts.written/skipped`), no prompt/response bodies | new module via injected logger | CC-0005 |
| Unit tests w/ fake factory, temp dirs, `.js` specifiers, `node` env, ≥80% coverage | co-located `src/runtime/council-phases.test.ts` | CC-0009 |
| `./harness lint`/`test`/`build` (or `verify`) pass | gate | CC-0009 / harness |

### Reference patterns already in the tree (reuse, don't reinvent)
- **Fake `SessionFactory` + temp-dir harness:** `src/runtime/council-runtime.test.ts:11–63` —
  `fakeFactory()` returns `{ start, createSession, stop }`; `mkdtemp(join(tmpdir(), "council-"))`;
  `.js` import specifiers; reads the transcript file back and asserts content. **This is the
  template** for the new test. The fake must be upgraded to a *recording/scripting* fake that
  (a) records the ordered `(memberId, prompt)` calls, (b) can be told to return a scripted
  response, a **blank** response, or **throw** for a specific call.
- **Path-traversal/temp-dir artifact tests:** `src/store/artifact-store.test.ts` — `mkdtemp`,
  `readFile` assert, `rm(dir, { recursive: true })` cleanup.
- **Typed-error construction:** `src/errors.ts` — `new SessionError(msg, { cause })`; mirror for
  `OrchestrationError(msg, { cause })` with `code: "ORCHESTRATION_ERROR"`.
- **Structured logging:** `logger.info("dotted.event", { field })`; never `console.log`; never
  log prompt/response bodies — log **sizes/ids/counts** only (CC-0005, security pitfall).
- **Fix-history signal (`35d0781` "fix: address PR review feedback"):** retrofitted the
  **path-traversal guard** onto `ArtifactStore.write`, added **80% coverage thresholds**, and
  added the **missing unit tests** for new modules. The lesson for #5: route **all** writes
  through `ArtifactStore.write`, **co-locate tests for the new module from the start**, and
  **cover every policy branch + error path** (coverage is computed over `council-phases.ts`).

### Recommended implementation seam (proposal for Plan, not a decision)
A pure, injectable entry point in a new covered module; keep the commander action thin:

```ts
// src/runtime/council-phases.ts  (NO `@github/copilot-sdk` import)
export interface BacklogCouncilResult {
  contextMemberId: string;
  backlogMemberId: string;
  phases: string[];                 // e.g. ["context","draft","validation","refinement","artifacts"]
  artifacts: string[];              // absolute paths written (empty when writeArtifacts:false)
  validationSkipped: boolean;
  artifactsSkipped: boolean;
}

export async function runBacklogCouncil(
  runtime: CouncilRuntime,
  config: CouncilConfig,
  options?: { logger?: Logger },
): Promise<BacklogCouncilResult>;
```

Suggested internal flow: **(0)** normalize+validate policy (defaults: `writeArtifacts=true`,
`requireProjectValidation=true`, `maxRounds=1`; reject non-integer/negative `maxRounds` →
`ConfigError`; reject `requireProjectValidation===true && maxRounds===0` → typed error) →
**(1)** resolve `{ context, backlog }` member ids (explicit mapping *iff* CC-0003 extended,
else heuristic), raising a typed error on unresolved/ambiguous/missing-both → **(2)** context
ask → **(3)** draft ask → **(4)** validation ask (gated) → **(5)** refinement ask → **(6)**
artifact writes (gated, via `ArtifactStore.write`, paths from `config.artifacts` by filename
with the 3 defaults). After **every** ask, assert `response.trim()` is non-empty or throw
`OrchestrationError`. The `cli.ts` `run` action only builds the `TranscriptStore`
(`council/<name>/transcript/full.md`), `ArtifactStore` (base `council/<name>`),
`CopilotSessionFactory`, and `CouncilRuntime`; calls `runtime.start()`, `runBacklogCouncil(...)`,
and `runtime.stop()` in `finally`; logs a structured summary; and maps `CouncilError` → non-zero
exit.

## Proposed ADRs

**ADRs required: NO.**

No new architectural decision is introduced. ADR-0002 already ratifies the runtime topology
(Model A, one SDK session per member behind a `SessionFactory` seam), the SDK-decoupling
principle (Decisions #5/#7), the ESM/NodeNext/commander/vitest stack, and explicitly defers
"the orchestration phases … to subsequent issues." `runBacklogCouncil` is a **consumer** of
those decisions; it does not introduce or revise any. **No ADR titles are proposed.**

*(For the Plan's awareness only — not required here:)* if a future iteration makes phases
**dynamic** (PRD v2), introduces an **orchestrator-as-session**, or adds the **MCP council
bus**, those would warrant a new ADR. The issue scopes a **fixed** v0 flow, so no ADR is
needed now.

## Proposed Core-Components

**No NEW core-component required.** `council-phases.ts` is an *implementation that composes*
CC-0003/0004/0005/0006/0007/0008 — not a new cross-cutting contract. However, the Plan stage
must make **explicit choices** and apply the following **doc updates** (researcher flags the
edits; Plan decides exact wording and whether a DECISION-LOG row is warranted):

1. **CORE-COMPONENT-0008 — Error Handling (UPDATE, required by AC).** Register the new
   `OrchestrationError` (`code: "ORCHESTRATION_ERROR"`) in the Rules/Interfaces (alongside
   `ConfigError`/`SessionError`). The AC explicitly requires this registration. **No new
   *decision* is strictly needed** (it extends the existing "typed `CouncilError` subclasses
   with stable codes" decision, #12), but the DECISION-LOG **ADR/CC table date** for CC-0008
   may be refreshed per docs hygiene.

2. **Policy semantics + role-resolution = a new durable behavioral contract → propose a
   DECISION-LOG row (decision-bearing).** §8's defaults/precedence (`writeArtifacts` default
   true; `requireProjectValidation` default true; `maxRounds` default 1, integer `>=0`;
   the **contradiction rule** `requireProjectValidation && maxRounds===0` → error) and the
   **role-resolution model** (explicit mapping *or* the documented `/scrum|backlog|story/i`
   and `/project|product|architect|context/i` heuristic, fail-closed on ambiguity) are
   contracts future code (`council continue`) will depend on. The Plan should decide whether to:
   - (a) add a **DECISION-LOG row** such as *"Fixed v0 backlog phases with deterministic policy
     precedence and fail-closed member-role resolution"* (sourced to CC-0004 and/or CC-0006),
     and add a short **"Phase orchestration & policy"** section to **CORE-COMPONENT-0004**
     (session/runtime layer) or **CORE-COMPONENT-0006**; **or**
   - (b) treat it as issue-local behavior documented only in the plan + `LLM.txt`.
   **Researcher recommendation:** record at least one DECISION-LOG row, because the policy
   precedence and role model are cross-run contracts, not one-off implementation details.

3. **CORE-COMPONENT-0003 — Configuration (CONDITIONAL UPDATE, the key decision).** The explicit
   `orchestrator.roles: { context, backlog }` mapping proposed by the issue is **currently
   dropped** by `validateCouncilConfig` (verified — Empirical finding #3). The Plan must choose:
   - **Option A (extend CC-0003):** add `roles?: { context?: string; backlog?: string }` to
     `OrchestratorConfig` and parse/preserve it (validating that referenced ids exist in
     `members[]`). This is a **contract change** → update CC-0003 + **add a DECISION-LOG row**.
     Enables explicit mapping as the issue envisions.
   - **Option B (heuristic-only v0, recommended for minimal scope):** ship **only** the
     documented heuristic now; defer `orchestrator.roles` to a follow-up. Keeps the orchestrator
     a pure consumer with **no CC-0003 change**. The issue's AC phrases explicit mapping as
     *"explicit `orchestrator.roles` **or** a documented heuristic,"* so heuristic-only still
     satisfies the criteria, provided the heuristic + its ambiguity/missing-role errors are
     fully tested.
   **Researcher recommendation:** **Option B** unless the Plan wants determinism for
   multi-member councils, in which case **Option A** (and accept the CC-0003 change + DECISION
   row). Either way, **document the chosen default mapping in code and `LLM.txt`** (AC).

4. **CORE-COMPONENT-0006 — Artifact/Transcript Store (UPDATE, doc-only).** Document the
   **idempotency model** the issue calls out: transcript is **append-only across re-runs**;
   artifacts are **overwritten in place**. (Behavior already holds; the doc should state it.)
   Optionally note that artifact-write failures are surfaced as typed `OrchestrationError`
   (wrapping the store's plain `Error`), since the store itself throws a plain `Error`.

5. **`LLM.txt` (UPDATE, required by convention).** Add a row for `src/runtime/council-phases.ts`
   and note the new `OrchestrationError` export + the documented default role mapping.

6. **`docs/` (OPTIONAL).** `docs/README.md` already anticipates "CLI usage … `run`" and a
   "`council.yaml` reference." A short runbook for `council run` (phases, policy fields, the
   `council/<name>/` layout) would be welcome but is not required by the AC.

## Acceptance Criteria (from issue)
Extracted **verbatim** from the issue body, between the `<!-- ACCEPTANCE_CRITERIA_START -->`
and `<!-- ACCEPTANCE_CRITERIA_END -->` markers:

**Core**
- [ ] `council run <name>` loads `council.yaml`, runs the council, and exits 0 on success (no more `notImplemented`).
- [ ] A new `src/runtime/council-phases.ts` exposes a phase orchestrator that depends only on `CouncilRuntime`/stores (no `@github/copilot-sdk` import) and is runnable with a fake `SessionFactory`.
- [ ] Phases execute in order: context summary → backlog draft → (validation) → refinement, using `CouncilRuntime.askMember`.
- [ ] Context/backlog member ids are resolved from config (explicit `orchestrator.roles` or a documented heuristic) — `"project-x"`/`"scrum-sme"` are NOT hardcoded.
- [ ] When `writeArtifacts` is enabled, `artifacts/backlog.md`, `artifacts/epics.md`, and `artifacts/open-questions.md` are written via `ArtifactStore.write` to paths derived from `config.artifacts`.
- [ ] Every member exchange is appended to the `TranscriptStore` (one block per turn), append-only across re-runs.
- [ ] Policy is honored: `requireProjectValidation`, `writeArtifacts`, and `maxRounds` behave per the documented semantics/defaults (§8).
- [ ] `runtime.stop()` runs in a `finally` block on every path (success or failure), and a `stop()` failure does not mask the original error.
- [ ] `OrchestrationError` (`ORCHESTRATION_ERROR`) is added, exported from `src/index.ts`, and registered in CORE-COMPONENT-0008.
- [ ] Re-running `council run` overwrites artifacts in place and appends (does not truncate) the transcript.

**Edge Cases**
- [ ] A phase referencing a member id not in config raises a typed error (no silent skip).
- [ ] A required role that cannot be resolved, is ambiguous, or a council lacking both required roles (e.g. a single-member council) raises a typed error with an actionable message.
- [ ] A member that throws mid-phase propagates a typed error, preserves all previously appended transcript turns, and still triggers cleanup/`stop()`.
- [ ] A blank member response (empty or whitespace-only after `trim()`) in any phase raises `OrchestrationError` — never written/returned as empty.
- [ ] An artifact write failure raises a typed error wrapping the cause; the failure is logged and does not lose already-written transcript content.
- [ ] `writeArtifacts: false` runs all phases + transcript but writes **no** artifact files.
- [ ] `requireProjectValidation: false` skips the validation phase and refines directly from the draft.
- [ ] `requireProjectValidation: true` with `maxRounds: 0` raises a typed error (contradictory policy); a negative/non-integer `maxRounds` raises `ConfigError`.

**Testing**
- [ ] A unit test drives the full flow with a fake `SessionFactory` and asserts the exact order of `(memberId, prompt)` calls (context → draft → validation → refinement).
- [ ] Tests assert artifacts are written to the expected relative paths under the `ArtifactStore` base, with non-blank content.
- [ ] Tests assert the transcript file contains one appended block per exchange.
- [ ] Tests assert policy gating: validation skipped when disabled; **no files written** when `writeArtifacts: false` (while the transcript is still written); rounds bounded by `maxRounds`; contradictory policy throws.
- [ ] Tests assert typed-error propagation for: unknown/unresolved/ambiguous member, member throw mid-phase (transcript preserved + `stop()` called), blank response, and artifact write failure.
- [ ] `./harness test` passes with coverage ≥ 80% (lines/functions/branches/statements); `./harness lint` and `./harness build` pass.

## Risks and Open Questions

### Risks
- **R1 — Policy is unvalidated by the loader (verified).** `validateCouncilConfig` passes
  `policy` through untyped (`maxRounds: -3.5` survived; non-boolean booleans survived). If the
  orchestrator assumes the loader already rejected bad policy, the `maxRounds`/contradiction
  ACs fail. *Mitigation:* validate `maxRounds` (integer `>=0` → else `ConfigError`) and coerce
  the booleans **inside** the orchestrator; test with non-integer/negative/`undefined` inputs.
- **R2 — `ArtifactStore.write` throws a plain `Error`, not a `CouncilError` (verified).** A naive
  `await store.write(...)` lets a non-typed error escape, failing *"artifact write failure raises
  a typed error wrapping the cause."* *Mitigation:* wrap every write in
  `try { … } catch (cause) { throw new OrchestrationError(msg, { cause }) }`; validate
  `config.artifacts` entries for traversal up-front and wrap the same way.
- **R3 — `orchestrator.roles` is silently dropped (verified).** Implementing reads of
  `config.orchestrator.roles` without first extending CC-0003 would resolve to `undefined`,
  silently falling back to the heuristic and giving a false sense of "explicit mapping works."
  *Mitigation:* Plan decides Option A (extend CC-0003) vs Option B (heuristic-only); if A, add a
  test that the explicit mapping actually survives `loadCouncilConfig`.
- **R4 — Double transcript append.** `askMember` already appends each turn. If the orchestrator
  also appends, every exchange is duplicated, breaking *"one block per turn."* *Mitigation:*
  never append directly; rely on `askMember`; assert block count == number of asks.
- **R5 — `stop()` masking the original error.** If `stop()` throws inside `finally` it can
  overwrite the in-flight error. *Mitigation:* in the CLI, `await runtime.stop()` in `finally`
  but catch/log its failure as a separate event so it does not replace the primary `CouncilError`
  (the AC explicitly requires this).
- **R6 — Coverage gate over the new module.** `council-phases.ts` is **included** in coverage
  (only `cli.ts` is excluded); every policy branch and every error path must be exercised or CI
  fails at the 80% threshold. *Mitigation:* the recording/throwing/blank fake enumerated in the
  Testing AC; one test per branch (validation on/off, `writeArtifacts` on/off, `maxRounds`
  0/1/≥1, contradiction, each error class). Note `src/store/transcript-store.ts` currently has
  **no co-located test** (only indirect coverage) — adding phase tests that read the transcript
  keeps it covered.
- **R7 — Logging sensitive content.** Member responses may contain private repo content; logging
  full prompt/response bodies leaks it and bloats logs. *Mitigation:* log only dotted events with
  sizes/ids/counts (CC-0005); never the bodies. The transcript (local file) is the place for full
  content, by design.
- **R8 — Single-member scaffold can't run end-to-end (cross-issue).** `council init` emits one
  member, so `init` → `run` fails role resolution until `add-member` lands. *Mitigation:* this is
  correct fail-closed behavior; ensure the error message is actionable (names the missing role)
  and document the prerequisite. Not a blocker for #5.
- **R9 — Epics/open-questions derivation is underspecified.** The issue allows either targeted
  asks **or** parsing delimited sections of the refined backlog, but requires the chosen approach
  to be tested and to produce **non-blank** content. *Mitigation:* Plan picks one approach
  explicitly; if parsing, define the delimiter contract and a fallback when a section is absent
  (must still write non-blank content or raise a typed error — never write empty).

### Open questions (for the Planner to resolve — researcher does not decide)
- **Q1 (decision-bearing, core-component impact):** `orchestrator.roles` **Option A** (extend
  CORE-COMPONENT-0003 + DECISION-LOG row) vs **Option B** (heuristic-only v0, no CC change)?
  This is the one choice that determines whether a CC-0003 contract change is needed.
- **Q2 (decision-bearing):** Record the **policy precedence + role-resolution** model as a
  DECISION-LOG row (recommended) and/or a section in CC-0004/0006, or keep it issue-local?
- **Q3:** Where does `maxRounds`/contradiction validation live — inline in `runBacklogCouncil`,
  or a small exported `normalizePolicy(config)` helper (more directly unit-testable)? And does it
  throw `ConfigError` (as the AC says for bad `maxRounds`) vs `OrchestrationError` (for the
  *contradiction*)? The AC distinguishes them: **`ConfigError`** for non-integer/negative
  `maxRounds`; a **typed error** (likely `OrchestrationError`) for the contradiction — confirm.
- **Q4:** Epics/open-questions via **targeted asks** (more model round-trips/cost, cleaner
  content) vs **parsing delimited sections** of the refined backlog (cheaper, brittler)? Define
  the section/delimiter contract if parsing. (Interacts with R9 and `maxRounds` cost.)
- **Q5:** Exact **prompt text** for each phase (the PRD pseudo-code gives drafts at
  `prd.md:359–414`). Note `CouncilRuntime.askMember` passes the prompt through **verbatim** (no
  wrapper) — unlike the PRD's `runBacklogCouncil` sketch which wrapped prompts with a
  "You are council member …" preamble. Decide whether the orchestrator adds any framing.
- **Q6:** Should the `run` action **catch `CouncilError` itself** to emit a `{ code, message }`
  record (the top-level catch logs message only), or should the top-level catch be enhanced to
  include `code` when the error is a `CouncilError`? (Affects the "structured error record with
  code" AC.)
- **Q7:** Default artifact filenames + how `config.artifacts` is "matched by filename" — exact
  set is `{backlog.md, epics.md, open-questions.md}`; confirm matching is by **basename** so the
  scaffolded `artifacts/backlog.md` maps correctly and absent `open-questions.md` falls back to a
  default relative path under the same `artifacts/` dir.
- **Q8:** `BacklogCouncilResult` exact shape (the issue describes "resolved member ids, phases
  executed, artifact paths, skip flags") — finalize fields so the CLI summary log and tests agree.
- **Q9:** Is the council base path `council/<name>/` derived from the CLI `<name>` arg or from
  `config.name`? The issue says the CLI builds `council/<name>/transcript/full.md` and base
  `council/<name>`; confirm which `name` wins if they differ (recommend `config.name` for
  session-id consistency, since sessions are keyed `<config.name>/<memberId>` in
  `council-runtime.ts:52`).

### Out of scope (per issue)
The MCP "council bus", orchestrator-as-session, streaming UI, dynamic phases, voting/disagreement
tracking, and issue/PR generation (PRD v1/v2). `council add-member` and `council continue` remain
separate verbs (the latter will reuse this orchestrator later). Members stay **read-only** in v0;
the council writes artifacts itself (CC-0007).

---
*Researcher stage complete. No source code, ADRs, or core-components were modified. Three
correctness traps were **empirically re-verified** against the live modules (policy is
unvalidated by the loader; `ArtifactStore.write` throws a plain `Error`; `orchestrator.roles`
is dropped by `validateCouncilConfig`). Handoff to Plan: resolve **Q1** (the only choice that may
require a CORE-COMPONENT-0003 change + DECISION-LOG entry) and **Q2** (record the policy/role
contract), register `OrchestrationError` in CORE-COMPONENT-0008, then proceed with the
fake-testable `runBacklogCouncil` seam above.*
