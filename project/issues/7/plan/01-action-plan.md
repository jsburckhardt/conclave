# Action Plan: feat(cli) — implement `council add-member` to add a validated member to a council

## Feature
- **ID:** 7
- **Research Brief:** `project/issues/7/research/00-research.md`

---

## Scope & Architecture Conclusion (the planner's call)

Research classified this as an ordinary feature **issue**: it composes already-adopted
contracts (ADR-0002 + CORE-COMPONENT-0003/0004/0005/0006/0007/0008/0009) behind a new,
unit-testable module. **No ADR is created.** One small cross-command path convention
(`resolveCouncilConfigPath`) is a reusable, cross-cutting locator, so — per AGENTS.md ("no
reusable cross-cutting behavior exists unless it is a core-component") — it is committed by
**amending CORE-COMPONENT-0003 (Configuration)** rather than left as a bare DECISION-LOG line.

### Architecture decisions committed by this plan

1. **Amend CORE-COMPONENT-0003 (done).** Added `resolveCouncilConfigPath(council, baseDir?)`
   to its Interfaces, plus Rules/Expectations fixing the canonical on-disk layout
   `council/<council>/council.yaml`, the "resolve only via the helper" rule, the traversal
   guard, and the "persist the edited document, not the normalized output" rule. Resolves
   **OQ3** (amend the component, do not just log a line). The component is global —
   `project/architecture/core-components/CORE-COMPONENT-0003-configuration.md` — not scoped to
   this issue, and the template file was not touched.
2. **Atomic write stays a private, single-use helper for v0 (OQ4).** `atomicWriteFile` lives
   **inside** `src/config/add-member.ts`, is **not** exported from `src/index.ts`, and is used
   exactly once (writing `council.yaml`). It is therefore *not yet* reusable cross-cutting
   behavior and needs no core-component. **Promotion trigger (documented):** if/when
   `run`/`continue` or the transcript/artifact stores need durable atomic writes, promote it to
   a new "Atomic File Write" core-component then, and record the decision at that point.

### Decision Log Impact

`project/architecture/ADR/DECISION-LOG.md` **was updated**: the CORE-COMPONENT-0003 registry
row date is bumped to `2026-06-21`, and four derived decision records were added:

| # | Decision | Source |
|---|----------|--------|
| 17 | Resolve every council's `council.yaml` path only through `resolveCouncilConfigPath(council, baseDir?)` | CORE-COMPONENT-0003 |
| 18 | Standardize the on-disk council layout as `council/<council>/council.yaml` | CORE-COMPONENT-0003 |
| 19 | Reject `<council>` path arguments that escape the council root with a traversal-guarded `ConfigError` | CORE-COMPONENT-0003 |
| 20 | Persist the edited YAML document (comments, key order, unknown keys), never the normalized validator output | CORE-COMPONENT-0003 |

## ADRs Created

None. No new technology choice or runtime topology is introduced; ADR-0002 already governs the
TypeScript/ESM/`commander`/`yaml`/`node:fs/promises` stack and the "logic behind a unit-testable
function seam" philosophy. (The issue itself states "no new ADR is expected.")

## Core-Components Created

None created. **CORE-COMPONENT-0003 (Configuration) was amended** (see above) — the only
architectural artifact change in this plan.

---

## Open-Question Resolutions (research OQ1–OQ7)

| OQ | Resolution |
|----|------------|
| **OQ1** — resolver signature & home | `resolveCouncilConfigPath(council: string, baseDir?: string): string` lives in `src/config/council-config.ts` (alongside the loader; the natural home for a configuration-location concern named by CORE-COMPONENT-0003). `baseDir` is optional and defaults to `process.cwd()`, mirroring `init`'s injectable base for hermetic tests. It returns `resolve(baseDir ?? process.cwd(), "council", council, "council.yaml")` **after** the traversal guard, performs **no** filesystem IO, and throws `ConfigError` on escape. It is re-exported from `src/index.ts`. |
| **OQ2** — which traversal-guard variant | Reuse **`init`'s refined guard** (reject when `rel.length === 0 \|\| rel === ".." \|\| rel.startsWith("../") \|\| rel.startsWith("..\\")`), **not** the bare `artifact-store` `startsWith("..")`. Chosen for cross-command consistency with `council init` and to avoid over-rejecting allowlisted segments. `init`'s `resolveCouncilPaths` is **not** refactored in this issue (keeps blast radius small); a DRY follow-up may extract one shared guard later. The two implementations must stay behaviorally identical. |
| **OQ3** — DECISION-LOG vs CC-0003 amendment | **Amend CORE-COMPONENT-0003** and record decision records #17–#20 (dated 2026-06-21). See above. |
| **OQ4** — atomic-write placement | **Private, single-use helper in `add-member.ts` for v0.** Not exported; promotion trigger documented above. |
| **OQ5** — top-level handler `error.code` | **Optional, low-priority.** The authoritative `code`-carrying failure record is `council.add-member.failed { council, memberId, code }`, emitted **inside** the covered module before re-throw (so it is unit-tested and counts toward coverage). Enhancing `cli`'s top-level `council.error` to also include `error.code` for `CouncilError`s is a harmless nice-to-have included as an **OPTIONAL** bullet in TASK-05; it is **not** required by any acceptance criterion and carries no test dependency (the entry/exit module lives in a covered file). |
| **OQ6** — log-event naming | **Keep the issue's explicit names**: entry `council.add-member` `{council, memberId}`, success `council.add-member.succeeded` `{council, memberId, tools}`, failure `council.add-member.failed` `{council, memberId, code}`. The divergence from `init`'s single `council.init.created` is acknowledged as a consistency note only; the issue is explicit and wins. |
| **OQ7** — follow-up tracking (R2) | **Track it.** `run`/`continue` still default `--config` to a flat `council.yaml` (`src/cli.ts:44`) and are **not** reconciled here (explicit out-of-scope). The single-writer concurrency limitation **and** the `run`/`continue` path-reconciliation follow-up are documented in `README.md` (TASK-06). Filing the tracked GitHub follow-up issue is recommended at Verify time (issue creation is outside the planner's role). |

---

## Chosen Approach (summary)

Replace the `notImplemented("add-member")` stub with a **thin** commander action that delegates
to a new, fully unit-tested module `src/config/add-member.ts`. All path resolution, input
validation, YAML-document editing, re-validation, atomic writing, and structured logging live in
that covered module (never in `src/cli.ts`, which `vitest.config.ts` excludes from coverage).
To make CLI behavior testable **and** counted toward coverage, the whole `commander` program is
moved into a new covered module `src/cli-program.ts` exporting `buildProgram(deps?)` /
`main(argv, deps?)`; `src/cli.ts` becomes a 2-line shim that keeps the shebang and calls `main`.

The flow is **validate-then-persist**: `resolveCouncilConfigPath` → read → `parseDocument` → edit
the Document → `validateCouncilConfig(doc.toJS())` → on success `atomicWriteFile(path,
String(doc))`. The file is **never** left invalid or partially written.

## Implementation Seam

New covered module — `src/config/add-member.ts`:

```ts
import { rename, rm, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument, type Document } from "yaml";
import { ConfigError } from "../errors.js";
import {
  resolveCouncilConfigPath,         // from council-config.ts (re-exported)
  validateCouncilConfig,
  type MemberConfig,
} from "./council-config.js";
import { createLogger, type Logger } from "../logging/logger.js";

export interface AddMemberOptions {
  council: string;            // <council> CLI arg → council/<council>/council.yaml
  memberId: string;           // <memberId> CLI arg
  cwd: string;                // --cwd  (member working dir; required, trimmed non-empty)
  role: string;               // --role (required, trimmed non-empty)
  agent?: string;             // --agent (optional string)
  tools?: "read-only" | "read-write"; // --tools (default "read-only"; reject anything else)
  baseDir?: string;           // defaults to process.cwd(); injected in tests
  logger?: Logger;            // defaults to createLogger(); injected in tests
}

// Pure edit: add a (pre-validated) member to a parsed Document's `members` seq.
// Throws ConfigError on a case-sensitive trimmed duplicate id. No IO.
export function applyAddMember(doc: Document, member: MemberConfig): void;

// IO wrapper: resolve → read → parseDocument → validate inputs → applyAddMember →
// validateCouncilConfig(doc.toJS()) → atomicWriteFile(String(doc)) → log. Throws ConfigError.
export async function addMember(options: AddMemberOptions): Promise<void>;
```

`resolveCouncilConfigPath` is added to `src/config/council-config.ts` (home per OQ1) and
re-exported by `src/index.ts` alongside `addMember`/`applyAddMember`/`AddMemberOptions`.

New covered module — `src/cli-program.ts` (CLI behavior, testable in-process):

```ts
export function buildProgram(deps?: { logger?: Logger; baseDir?: string }): Command;
export async function main(argv: string[], deps?: { logger?: Logger; baseDir?: string }): Promise<void>;
```

`buildProgram` wires **all four** subcommands (the existing `init`/`run`/`continue` actions move
verbatim; only `add-member` changes to `await addMember({...})`). `main` runs
`buildProgram(deps).parseAsync(argv)` inside the existing top-level `catch` that logs
`council.error` and sets `process.exitCode = 1`.

Thin shim — `src/cli.ts` (stays coverage-excluded):

```ts
#!/usr/bin/env node
import { main } from "./cli-program.js";
void main(process.argv);
```

## Order of operations in `addMember` (and which AC each step satisfies)

1. **Resolve** `path = resolveCouncilConfigPath(council, baseDir)` — traversal guard (**E8**, **C3**).
2. **Log entry** `council.add-member { council, memberId }` (**C9**).
3. **Validate scalar inputs before any IO** — `memberId` trimmed non-empty **and**
   `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `cwd`/`role` trimmed non-empty; `agent` optional string;
   `tools ∈ {read-only, read-write}`, default `read-only` (reject anything else). Field-naming
   `ConfigError` on failure (**C2**, **E3**, **E4**, **E5**).
4. **Read** the file → `ConfigError` if missing dir/file (**E1**).
5. **`parseDocument`** → `ConfigError` if unparseable (**E6**).
6. **`applyAddMember(doc, member)`** — case-sensitive trimmed duplicate check on existing ids →
   conflict `ConfigError`, no write (**E2**); else `members.add({...})` on the Document (**C3**, **C4**).
7. **Re-validate** `validateCouncilConfig(doc.toJS())` → `ConfigError` if the (now-edited) config
   is invalid, including a **pre-existing-invalid** parseable file (**E7**, **C5**). No write.
8. **Atomic write** `atomicWriteFile(path, String(doc))` — unique same-dir temp + `rename` +
   cleanup-on-error; persists `String(doc)`, never the normalized output (**C7**, **C8**).
9. **Log success** `council.add-member.succeeded { council, memberId, tools }` (**C9**).
10. **On any throw after step 2**: emit `council.add-member.failed { council, memberId, code }`
    (with `code = "CONFIG_ERROR"`), then re-throw so the top-level handler exits non-zero and the
    file is left byte-for-byte unchanged (**C9**, **C10**). Non-`CouncilError`s are wrapped in
    `ConfigError` (with `cause`) so a stable `code` is always present.

## `atomicWriteFile(targetPath, content)` (private helper)

1. `temp = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)`
   — **same directory** as the target (keeps `rename` same-filesystem, avoiding `EXDEV`).
2. `await writeFile(temp, content, "utf8")`.
3. `await rename(temp, targetPath)` — atomic replace on POSIX same-FS.
4. On **any** error in 2–3: `await rm(temp, { force: true })` (best-effort cleanup), then re-throw.
5. `fsync` is intentionally **omitted** for v0 (research R5); POSIX dev-container assumption is
   documented (research R4). Uniqueness of the temp name guarantees two concurrent writers cannot
   clobber each other's temp file; the final `rename` makes "last writer wins" cleanly (no
   corruption) — the documented single-writer limitation (research R1, **E9**).

## Logging Events (CORE-COMPONENT-0005)

| Event | When | Fields | Stream |
|-------|------|--------|--------|
| `council.add-member` | entry | `{ council, memberId }` | stdout |
| `council.add-member.succeeded` | after atomic write | `{ council, memberId, tools }` | stdout |
| `council.add-member.failed` | in catch, before re-throw | `{ council, memberId, code }` | stderr |

All three are emitted **inside the covered module** via the injected logger (default
`createLogger()`), so each is unit-testable and visible to the in-process CLI test. No
`console.log` anywhere.

## Security / Atomicity / Preservation Approach

1. **Traversal guard** on the `<council>` argument only (it builds the path); the refined `init`
   variant (OQ2). `memberId` is additionally constrained by `^[A-Za-z0-9][A-Za-z0-9._-]*$`
   (stricter than `init`'s name allowlist because it becomes a session-id path segment —
   CORE-COMPONENT-0004, Decision #8).
2. **Validate-then-persist**, never persist on failure (**C5**, **C10**).
3. **Document API** (`parseDocument`/`String(doc)`) preserves comments, key order, the
   orchestrator section, and unknown/forward-compat keys (**C4**, **C7**). `parse`+`stringify` is
   **not** used, so no comment-loss documentation is needed.
4. **Atomic same-dir temp + `rename` + cleanup-on-error** (**C8**, **E9**).
5. **No new dependencies**; `yaml`, `commander`, `node:fs/promises`, `node:crypto`, `node:path`
   are all already available. ESM/NodeNext `.js` import specifiers in source and tests.

## Documentation Surface

- **`LLM.txt`** — add rows for `src/config/add-member.ts` and `src/cli-program.ts`.
- **`README.md`** — expand the `add-member` CLI bullet (its `--cwd`/`--role`/`--agent`/`--tools`
  flags) and add a net-new **Limitations** subsection documenting the v0 single-writer
  concurrency limitation (unique-temp + atomic `rename` prevents corruption, not lost updates)
  and the pending `run`/`continue` path-reconciliation follow-up (research R2).
- **`--help`** — the new flag descriptions are surfaced by `commander` from the action options.

## Implementation Tasks (outline)

Ordered by dependency (full detail in `02-task-breakdown.md`):

1. **TASK-01** — `resolveCouncilConfigPath(council, baseDir?)` + refined traversal guard in
   `src/config/council-config.ts`; export via `src/index.ts`.
2. **TASK-02** — Input validation (trim/charset/enum) + pure `applyAddMember(doc, member)`
   (case-sensitive trimmed duplicate detection) in `src/config/add-member.ts`.
3. **TASK-03** — Private `atomicWriteFile` helper (unique same-dir temp + `rename` + cleanup).
4. **TASK-04** — `addMember(options)` IO orchestration (read → parseDocument → validate → apply →
   re-validate → atomic write → entry/success/failure logging + error mapping/preservation).
5. **TASK-05** — CLI wiring: new covered `src/cli-program.ts` (`buildProgram`/`main`); `src/cli.ts`
   shim; `add-member` action delegates to `addMember`. (Optional: top-level `error.code` log.)
6. **TASK-06** — Public exports (`src/index.ts`) + docs (`LLM.txt`, `README.md` Limitations, `--help`).
7. **TASK-07** — Verification gate: `./harness verify`, coverage ≥80% with `src/cli.ts` excluded.

## Acceptance-Criteria Coverage (summary)

All 30 issue criteria (10 Core `C1`–`C10`, 9 Edge `E1`–`E9`, 11 Testing `TS1`–`TS11`) map to ≥1
task and ≥1 test case. Full traceability matrices live in `02-task-breakdown.md` (AC→task) and
`03-test-plan.md` (AC→test).

## Governing ADRs & Core-Components

- **ADR-0002** — TypeScript + ESM/NodeNext, `commander`, `yaml`, `node:fs/promises`, function-seam philosophy.
- **CORE-COMPONENT-0003** (amended) — config validation **and** `resolveCouncilConfigPath` locator + on-disk layout + persist-the-document rule.
- **CORE-COMPONENT-0004** — stable `"<councilId>/<memberId>"` session id → motivates the strict `memberId` charset.
- **CORE-COMPONENT-0005** — structured logging via `createLogger`, dotted events, no `console.log`.
- **CORE-COMPONENT-0006** — `resolve`/`relative` traversal-guard pattern mirrored for the `<council>` arg.
- **CORE-COMPONENT-0007** — member `tools` read-only default.
- **CORE-COMPONENT-0008** — typed `ConfigError` (`CONFIG_ERROR`), `cause`, human-actionable messages.
- **CORE-COMPONENT-0009** — co-located `*.test.ts`, `.js` specifiers, `node` env, ≥80% coverage, named exports.
