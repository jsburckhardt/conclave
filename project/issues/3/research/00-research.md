# Research Brief: feat(cli) — implement `council continue` to resume a persisted council

## GitHub Issue
- **Issue:** #3
- **Title:** feat(cli): implement `council continue` to resume a persisted council
- **State:** OPEN
- **Labels:** `enhancement`
- **Branch:** `feat/3-council-continue` (worktree at `.trees/issue-3`)

## Scope Classification
- **Scope Type:** `issue`

**Justification.** This is a feature that composes **already-merged** building blocks
(session factory, runtime, stores, config loader, typed errors, logger) into a new CLI
verb. Every seam it needs already exists and is already governed by an adopted
architectural artifact, so it introduces **no new technology choice and no new runtime
topology**:

- one stable SDK session per member behind a `SessionFactory`/`MemberSession` seam,
  keyed `"<councilId>/<memberId>"`, explicitly described as the resumability foundation —
  **ADR-0002** + **CORE-COMPONENT-0004** (CC-0004 line 42 already states *"Stable session
  ids are durable across process restarts to support `council continue`"*);
- file-based transcript/artifacts as the authoritative source of truth, all writes routed
  through dedicated stores under `src/store/` — **CORE-COMPONENT-0006**;
- typed `CouncilError` taxonomy with stable codes + preserved `cause` — **CORE-COMPONENT-0008**;
- slug-based, traversal-guarded on-disk council layout `council/<council>/…` —
  **CORE-COMPONENT-0003** (DECISION-LOG #26–#28);
- structured one-JSON-line-per-event logging — **CORE-COMPONENT-0005**;
- strict ESM/NodeNext TypeScript + vitest (Node env) + ≥80% coverage, **no new runtime
  deps** — **ADR-0002** / **CORE-COMPONENT-0009**.

ADR-0002 itself anticipated this work: its CLI surface is `council init|add-member|run|continue`
(ADR-0002 line 14) and its Consequences note that *"orchestration phases remain to be designed
and implemented in subsequent issues."* The only governance touch-ups are **documentation
updates to existing components** — registering a new `StateError` in CC-0008 and documenting
the run-state store + resume contract in CC-0006/CC-0004, each with a DECISION-LOG row. This is
exactly the pattern issue #5 (`council run`) followed when it added `OrchestrationError`
(DECISION-LOG #17–#18, commit `5677769`). Therefore scope is an ordinary feature **`issue`**,
not an `architecture_decision` or a `core_component`.

**Decision-bearing items the Plan stage must ratify (researcher proposes, does not decide):**
1. The **`state.json` schema** (`schemaVersion`, `status`, `lastPhase`, `lastRound`, members,
   `configHash`, timestamps) becomes a durable on-disk contract → likely a DECISION-LOG row and
   wording in CC-0006 (or a new component — see *Proposed Core-Components*).
2. A new **`StateError`** (`code: "STATE_ERROR"`) → requires a CC-0008 edit + DECISION-LOG row.
3. The **resume semantics** of the fixed phase/round flow (how much of `runBacklogCouncil` must
   be refactored to checkpoint/resume) → wording in CC-0004.

## Problem Statement

`council continue <council>` is a **stub**: in `src/cli-program.ts` (lines 148–155) the action
logs `council.continue` then calls `notImplemented("continue")` (line 154 → lines 27–31), which
writes a plain-text notice to stderr and sets `process.exitCode = 1`. A council can be run but
never resumed.

The PRD makes resumability a first-class v0 capability (`prd.md` lines 201–231): each member has
a stable session id (`council/<councilId>/<memberId>`) so `council continue <name>` can pick up
prior context, while *"the file artifacts [remain] the source of truth … Do not rely only on
session memory."* The session-keying foundation already exists
(`CopilotSessionFactory.createSession` keys `${councilId}/${member.id}`), but two pieces are
missing:

1. **Durable run state** — there is currently **no** record on disk of *where a run got to*
   (which phase/round, which member session ids, when). Verified: a repo-wide search for
   `state.json` / `CouncilState` / `StateError` / `state-store` returns **nothing** in `src/`
   or `project/`. `council run` persists only the transcript and final artifacts; it does not
   emit any progress/state file.
2. **The CLI/runtime resume logic** — load that state, recreate the same sessions, and continue
   the phase/round flow from the persisted point, re-persisting after each step.

Without (1) and (2), an interrupted or long-running council cannot be resumed: users must re-run
from scratch and lose orchestration progress (even though transcript/artifacts survive).

## Existing Context

### Harness baseline (operating surface)
`./harness orient` → `Verdict: pass` (Node v24.17.0, npm, vitest, tsc). `./harness status` →
`Deps installed: false, Built: false, Contract: true` (fresh worktree; `node_modules` absent —
expected for the research stage, no build/test required here). Verbs available:
`orient | doctor | lint | test | build | boot | verify | status | clean | friction`.

### The stub to replace and the CLI wiring contract
- `src/cli.ts` (lines 1–5) is only the 4-line bin entry (`void main(process.argv)`); **all
  command wiring lives in `src/cli-program.ts`** (`buildProgram`/`main`). The issue's AC says
  *"implemented in `src/cli.ts`"*, but the stub and every sibling command are actually in
  `src/cli-program.ts` — and `vitest.config.ts` **excludes `src/cli.ts` from coverage**. The
  implementation must land in `src/cli-program.ts` to be covered and unit-testable in-process.
- `main()` (cli-program.ts:171–190) already maps thrown `CouncilError`s to a `council.error`
  log (including `code`) + non-zero exit, and honors `CommanderError` exit codes. New `continue`
  failures need only `throw` a typed error — the top-level handler does the rest (CC-0008).
- `program.exitOverride()` (cli-program.ts:50) keeps in-process tests alive on parse errors.
- The `run` command (cli-program.ts:94–146) is the structural template for `continue`'s option
  set and runtime lifecycle: `-c/--config` option (default `"council.yaml"`), `loadCouncilConfig`,
  `new CouncilRuntime({...})`, `start()` → orchestrate → `stop()` in a guarded `finally`.

### Session resume foundation already works (verified signatures)
- `CopilotSessionFactory.createSession(member, councilId)` builds `sessionId:
  \`${councilId}/${member.id}\`` (copilot-session-factory.ts:27–39).
- `CouncilRuntime` (council-runtime.ts) uses `councilId = config.name` (line 50–53) and
  `start()` **already recreates one session per member with those stable ids** (lines 47–57).
  → "Recreate sessions with identical ids" is **already satisfied by the existing
  `start()`/`createSession` path**. Resume needs an entry point that starts the runtime (reusing
  this path) and then *skips already-completed phases* — it does **not** need new session-id
  logic. `CouncilRuntime` exposes `start` / `askMember` / `stop`; there is **no** `resume()`
  method today (the issue proposes adding one — exact name deferred to Plan).

### The fixed phase/round model `continue` must resume within (`src/runtime/council-phases.ts`)
`runBacklogCouncil(runtime, config, { artifacts, logger })` (lines 295–409) drives a
deterministic sequence and is the **owner of the phase/round model** (the issue says `continue`
must not redefine it):

```
context → draft → [ validation? → refinement ] × maxRounds → [ artifacts? ]
```

- `recordPhase()` names: `context`, `draft`, `validation`, `refinement`, `artifacts`
  (candidate `lastPhase` values). `rounds` counts completed refinement rounds, `0..maxRounds`
  (candidate `lastRound` values). Policy defaults `writeArtifacts:true`,
  `requireProjectValidation:true`, `maxRounds:1` (normalizePolicy, lines 73–97).
- **Critical gap for resume:** `runBacklogCouncil` is monolithic. The intermediate working
  products (`summary`, the evolving `working` backlog) live **only in memory**; `artifacts/backlog.md`
  is written **only in the final `artifacts` phase** (lines 365–394). The function **accepts no
  resume checkpoint and persists no per-step progress markers**. So "continue from
  `lastPhase`/`lastRound`" cannot work mid-flow today without either (a) refactoring
  `runBacklogCouncil` to checkpoint intermediate products durably and accept a start point, or
  (b) defining coarse resume granularity. This is the central design tension (see Risks).

### Stores, errors, logging, and the closest precedent
- **Atomic write already exists** — `atomicWriteFile` in `src/config/add-member.ts` (lines
  140–152): write a uniquely-named temp file *in the same directory* (`.<base>.<pid>.<uuid>.tmp`)
  then `rename` over the target, `rm` temp on error. The new state store should **reuse this exact
  idiom** (the AC's "temp file + `rename`"). `ArtifactStore.write` (artifact-store.ts:14–25) is
  **not** atomic but contributes the traversal guard (`resolve`+`relative`) + `mkdir -p`.
- **`add-member` is the closest end-to-end precedent for `continue`**: validate slug → resolve
  via `resolveCouncilConfigPath(council, baseDir)` (traversal-guarded; council-config.ts:180–191;
  DECISION-LOG #26–#28) → read → mutate → **atomic** persist → emit
  `entry / succeeded / failed { …, code }` logs (add-member.ts:183–end). Follow its
  testable-function shape (a `continueCouncil(options)` function the CLI action delegates to).
- **Errors** (`src/errors.ts`): `CouncilError` → `ConfigError` (CONFIG_ERROR), `SessionError`
  (SESSION_ERROR), `OrchestrationError` (ORCHESTRATION_ERROR). **No `StateError` exists.** CC-0008
  requires a new category to extend `CouncilError` with a new stable `code` and be exported from
  `src/index.ts`.
- **Logging** (`src/logging/logger.ts`): `createLogger()` emits one JSON object per line;
  `info`/`debug` → stdout, `warn`/`error` → stderr. Dotted event names are the convention
  (`council.run`, `phase.*.start`, `session.created`). `continue` already logs `council.continue`
  (cli-program.ts:153); add `state.read`, `state.write`, `session.resumed`, `config.drift`,
  `council.continue.completed`.
- **No lock / file-locking and no config-hash utility exist yet** (grep clean). `node:crypto` is
  already used (`randomUUID` in add-member.ts:3), so `createHash("sha256")` for `configHash` adds
  **no new dependency**. The concurrency guard and drift detection are net-new but built only from
  Node built-ins + the existing stores.

### Path-resolution inconsistency `continue` must reconcile (verified)
- `add-member` resolves the council dir from the **CLI slug**: `resolveCouncilConfigPath(council,
  baseDir)` → `council/<council>/council.yaml`, slug validated + traversal-guarded.
- `run` instead loads `loadCouncilConfig(options.config)` (default literal `"council.yaml"`) and
  derives the on-disk base from the **YAML's `config.name`**: `join("council", config.name)`
  (cli-program.ts:110–113). Sessions are also keyed on `config.name`.
- These usually coincide but can diverge (slug ≠ `name` inside the YAML). The issue wants
  `state.json` resolved from the **slug** and traversal-safe, yet sessions/artifacts key on
  `config.name`. Plan must pick one home for `state.json` and cross-check `config.name === slug`
  (see Open Questions).

### Acceptance-criterion → module / governing contract map
| AC theme | Primary module(s) | Governing contract |
|---|---|---|
| New decoupled state store (read/write `state.json`, atomic, mkdir -p) | new `src/store/council-state-store.ts` (+ `src/index.ts` export) | CC-0006, CC-0003 (slug/traversal), reuse `atomicWriteFile` idiom |
| Throw on missing / corrupt / schema-mismatch state | state store + `StateError` | CC-0008 |
| Resume reuses exact `${councilId}/${memberId}` ids | reuse `CouncilRuntime.start()`/`createSession` | CC-0004 |
| Continue phase/round flow, re-persist each step | `runBacklogCouncil` (refactor) + runtime resume entry | CC-0004, CC-0006 |
| Member-set vs non-structural config drift policy | new drift check (configHash + member set) | CC-0003, CC-0008 |
| Concurrency guard + stale-lock `--force` | new lock/status marker under `council/<council>/` | CC-0006 (file-based), CC-0008 |
| CLI wiring, `-c/--config`, `--force`, typed exit codes, logs | `src/cli-program.ts` (+ `continueCouncil` fn) | CC-0005, CC-0008 |
| Tests co-located, real temp dirs, ≥80% coverage | `*.test.ts` siblings | CC-0009, `vitest.config.ts` |

## Proposed ADRs

**None required.** This issue introduces no new technology, runtime topology, or cross-cutting
architectural decision. Resumability, the stable-session-id convention, file-as-source-of-truth,
the typed-error taxonomy, and the ESM/no-new-deps constraints are all already decided in
**ADR-0002** and the adopted core-components, and ADR-0002 explicitly anticipates the `continue`
verb and "subsequent issues" implementing orchestration. The work builds *within* the accepted
architecture; no ADR should be authored for it.

## Proposed Core-Components

**No NEW core-component is strictly required.** The feature fits the existing components, but it
**does require documentation updates to three adopted components plus DECISION-LOG rows** (these
are authored in the Implement stage, not by Research; the Plan stage decides the exact wording):

1. **CORE-COMPONENT-0008 (Error Handling)** — register a new `StateError`
   (`code: "STATE_ERROR"`) for "no prior run / missing state", "corrupt/invalid state", and
   "schema/`schemaVersion` mismatch"; export it from `src/index.ts`. Reuse `SessionError` for SDK
   resume failures and `ConfigError` for config-drift/path problems. (Precedent: `OrchestrationError`
   added under issue #5.)
2. **CORE-COMPONENT-0006 (Artifact and Transcript Store)** — document the new run-**state** store
   (`CouncilStateStore`, `council/<council>/state.json`), its atomic temp+`rename` write, slug
   resolution, and that `state.json` joins transcript+artifacts as authoritative.
3. **CORE-COMPONENT-0004 (Session Lifecycle and Persistence)** — document the resume entry point
   (e.g. `CouncilRuntime.resume(state)`) and the rule that resume recreates sessions via the same
   stable-id path and continues from `lastPhase`/`lastRound`.

Each change adds a row to `project/architecture/ADR/DECISION-LOG.md`.

**Conditional proposal (Plan decides, researcher does not):** if Plan judges run-state
persistence + resume to be a distinct enough concern from transcript/artifacts to warrant its own
component rather than extending CC-0006/CC-0004, the proposed title is:

> **CORE-COMPONENT-00XX: Run-State Persistence and Resume Lifecycle** — owns the `state.json`
> schema/`schemaVersion`, atomic state writes, the resume entry point, the config-drift policy,
> and the concurrency guard.

Recommendation (non-binding): prefer **extending CC-0006/CC-0004 + CC-0008** over a new component,
to match how `OrchestrationError`/phase work was governed for issue #5.

## Acceptance Criteria (from issue)

> Extracted verbatim from the issue body between the
> `<!-- ACCEPTANCE_CRITERIA_START -->` / `<!-- ACCEPTANCE_CRITERIA_END -->` markers.

**Core**
- [ ] `council continue <council>` is implemented in `src/cli.ts` (the `notImplemented("continue")` stub is removed).
- [ ] Running `continue` loads the council's `council.yaml` (honoring `-c/--config`) and reads `state.json` through a dedicated, decoupled state store.
- [ ] A new state store (e.g. `src/store/council-state-store.ts`) reads/writes `state.json` (councilId, status, lastPhase, lastRound, member session ids, timestamps, configHash, schemaVersion) with no orchestration logic, and is exported from `src/index.ts`.
- [ ] `state.json` writes create the parent dir (`mkdir -p` semantics) and are atomic (temp file + `rename`).
- [ ] Resume recreates member sessions through `SessionFactory.createSession(member, councilId)`, reusing the identical stable `${councilId}/${memberId}` session ids from the original run.
- [ ] The phase/round flow continues from the persisted `lastPhase`/`lastRound`, and updated state is re-persisted after each completed phase/round.
- [ ] File artifacts, transcript, and `state.json` are treated as authoritative; SDK session memory is best-effort and a failed SDK resume does not discard persisted state.
- [ ] All `continue` activity is logged via the structured `createLogger` (resume start, state read/write, sessions resumed, completion).
- [ ] Failures surface as typed `CouncilError` subclasses with stable codes and a non-zero exit code via the existing top-level CLI handler.

**Edge Cases**
- [ ] Missing `state.json` (council never run) -> typed error with an actionable message (e.g. "run `council run <council>` first"); no silent fresh-start.
- [ ] Corrupt or partially-written `state.json` (invalid JSON / failed schema check) -> typed error is thrown; state is never silently treated as empty.
- [ ] Unknown or newer `schemaVersion` in `state.json` -> typed error (no silent best-effort parse).
- [ ] Member-set drift in `council.yaml` since the last run -> command aborts with a typed error unless `--force`; non-structural drift warns and continues; both are logged.
- [ ] SDK session resume failure -> wrapped in a typed `SessionError`; persisted state is preserved so the run remains retryable.
- [ ] Concurrent `continue`/`run` of the same council -> a concurrency guard prevents state corruption (typed error / refusal), with a documented stale-lock escape hatch.
- [ ] Resuming an already-completed council (`status: "completed"`) is a safe no-op with a clear message (idempotent).
- [ ] The `<council>` argument and any config path are validated and cannot traverse outside the council directory.

**Testing**
- [ ] Unit test: resume reads persisted state and continues from the correct `lastPhase`/`lastRound`.
- [ ] Unit test: resume reuses the exact stable `${councilId}/${memberId}` session ids (asserted via a fake `SessionFactory`; no real SDK calls).
- [ ] Unit test: missing `state.json` raises the typed "no prior run" error.
- [ ] Unit test: corrupt/partial `state.json` raises a typed error (not an empty/fresh state).
- [ ] Unit test: unknown/newer `schemaVersion` raises a typed error.
- [ ] Unit test: state is re-persisted (updated `lastPhase`/`lastRound`/`updatedAt`) after progress, written atomically.
- [ ] Unit test: member-set drift aborts (typed error) without `--force` and is allowed with `--force`.
- [ ] Unit test: concurrent-continue guard rejects a second invocation while one is in progress.
- [ ] Tests are co-located as `*.test.ts`, use real temp dirs (`mkdtemp(tmpdir())`), and overall coverage stays >= 80%.

## Risks and Open Questions

### Risks
- **R1 — No producer of `state.json` exists today (highest-impact).** Verified: nothing in the
  repo writes `state.json`, and `council run` persists only transcript/artifacts. `continue` is
  inert until a run emits resumable state. The issue scopes this issue as the **state-contract
  definer + `continue` consumer** and says the **producer hook "lands with the `council run`
  work" (reference by command name, not issue number)**. Risk: if the producer hook is not also
  delivered, `continue` can be fully built and tested (against fixtures/fakes) but will always
  hit the "missing state.json → typed error" path in real use. Plan must decide whether to
  include the minimal `run` producer hook in this issue's scope or defer it (see Q1).
- **R2 — `runBacklogCouncil` is not checkpoint/resume-capable.** It keeps `summary` and the
  evolving backlog only in memory and writes `artifacts/backlog.md` only in the final phase
  (council-phases.ts:365–394); it takes no resume input and emits no progress. Genuine mid-flow
  resume requires refactoring it to (a) persist intermediate working products durably and (b)
  accept a `lastPhase`/`lastRound` start point — a larger change than wiring a CLI command. Risk
  of scope creep / partial resume. Plan must choose the resume granularity (Q2).
- **R3 — Path/identity divergence.** `state.json` keyed on the CLI **slug** vs sessions/artifacts
  keyed on YAML **`config.name`** can address different directories/ids if they differ. Could
  silently read/write the wrong council or request mismatched session ids. Mitigation: resolve via
  the `resolveCouncilConfigPath` pattern and assert `config.name === slug` (or `state.councilId`)
  before resuming (Q3).
- **R4 — "Throw on corrupt persisted data, never silently return empty" is the central trap.** A
  corrupt/partial/older/newer `state.json` must raise a typed error, never a fresh run. Equally,
  trusting stored `sessionId` strings blindly is unsafe — re-derive from `councilId/memberId` and
  treat stored ids as a cross-check (per issue Known Pitfalls).
- **R5 — Concurrency guard is net-new and easy to get subtly wrong.** No locking primitive exists.
  A status marker / lock file must release on success *and* failure, survive crashes (stale-lock
  `--force` escape hatch), and avoid TOCTOU. The proposed `status` enum is `"in-progress" |
  "completed"`, which is not by itself a concurrency lock — a distinct running/lock signal is
  needed (Q4).
- **R6 — Existing test asserts the *current* stub behavior.** `cli-program.test.ts` "TP-19"
  (lines 103–131) asserts `continue` exits 1 and reports not-implemented. Implementing the command
  **must update that test**; otherwise the suite breaks. Coverage must stay ≥80% (CC-0009,
  `vitest.config.ts`).
- **R7 — `atomicWriteFile` is currently a private helper in `add-member.ts`.** Reusing it for the
  state store means either extracting/sharing it (preferred, single source of truth) or
  duplicating the idiom. Avoid divergence.

### Open Questions (for the Plan stage to resolve — researcher does not decide)
- **Q1 — Producer scope:** Does this issue include the minimal `council run` hook that emits/updates
  `state.json` (init on start, update `lastPhase`/`lastRound`/`updatedAt` per step, `status:
  "completed"` at end), or is that strictly deferred to the `council run` work and `continue`
  validated against fixtures only?
- **Q2 — Resume granularity:** Coarse (only an already-`completed` council is a no-op; otherwise
  refuse / restart cleanly) vs fine-grained mid-phase resume (requires R2's refactor + durable
  intermediate products)? What is `lastPhase`/`lastRound` semantics exactly against the fixed
  sequence, and what intermediate artifacts must be persisted to make resume correct from each
  boundary?
- **Q3 — `state.json` home & identity:** `council/<slug>/state.json` (slug-based, like
  `add-member`) or `council/<config.name>/state.json` (name-based, like `run`'s artifacts/sessions)?
  How are `config.name`, the `<council>` slug, and `state.councilId` cross-validated before resume?
  Should `run` be aligned to `resolveCouncilConfigPath` for consistency?
- **Q4 — Concurrency mechanism:** Separate lock file vs a `status: "running"`/lock field in
  `state.json`; exact stale-lock detection and whether `--force` covers both stale locks and
  member-set drift or needs separate flags.
- **Q5 — Error taxonomy:** Confirm `StateError` (`STATE_ERROR`) as the new subclass and whether
  "no prior run", "corrupt state", and "schema mismatch" share one code or need distinct codes;
  confirm `SessionError` for SDK resume failure and `ConfigError` for drift. (CC-0008 + DECISION-LOG
  update required either way.)
- **Q6 — `.gitignore` policy:** `council/` is currently **not** git-ignored, so `state.json` and any
  lock file would be tracked. Decide whether `state.json` / lock files are committed (diffable
  metadata) or ignored.
- **Q7 — Resume entry-point name/shape:** `CouncilRuntime.resume(state)` vs a free function vs
  reusing `start()` + a resumable `runBacklogCouncil(start, …)` parameter — the AC names
  `resume(state)` "exact name decided in Plan".

### Out of scope (per issue)
- Redefining the phase sequence / round semantics (owned by `council run`).
- The MCP "council bus", orchestrator-as-session, streaming UI, dynamic phases (ADR-0002 deferrals).
- Any new runtime dependency (keep the state store dependency-free and file-based).
