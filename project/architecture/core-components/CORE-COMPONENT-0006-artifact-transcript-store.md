# CORE-COMPONENT-0006: Artifact and Transcript Store

## Status

Adopted (amended 2026-06-22 — added the run-state store (`CouncilStateStore`/`state.json`), its atomic write, and the concurrency lock; see DECISION-LOG decisions #32–#35)

## Purpose

File artifacts are the durable source of truth for a council — not session memory. Every exchange is appended to a transcript, and final outputs (backlog, decisions, open questions) are written as artifacts. A council's **run state** (which phase/round it reached, the member session ids, when) is persisted alongside them as `state.json` so an interrupted council can be resumed. Centralizing all three guarantees councils remain auditable and resumable even if session state is lost.

## Scope

Affects code that persists council memory, outputs, and run state (`src/store/`). Boundaries: these stores handle file IO and formatting only; they do not decide what to write or when. The run-state store also owns the on-disk concurrency lock that protects `state.json` from concurrent `run`/`continue`.

## Definition

### Rules
- All council exchanges are appended via `TranscriptStore.append` (`src/store/transcript-store.ts`).
- Final outputs are written via `ArtifactStore.write` (`src/store/artifact-store.ts`).
- Stores create parent directories as needed (`mkdir -p` semantics).
- Transcript entries are append-only Markdown blocks containing member, timestamp, prompt, and response.
- Across council re-runs the transcript is strictly append-only (never truncated) — one block per member exchange — while artifacts are overwritten in place.
- File-based memory is authoritative; SDK session memory is a convenience, not the source of truth.

**Run-state persistence and concurrency**

- Resumable run state is persisted as `state.json` at `council/<council>/state.json`, written and read **only** through `CouncilStateStore` (`src/store/council-state-store.ts`); no orchestration logic lives in the store.
- `state.json` holds `schemaVersion`, `councilId`, `status` (`in-progress` | `completed`), `lastPhase`, `lastRound`, the member session registry (`{ id, sessionId }`), `configHash`, `createdAt`/`updatedAt`, and a `products` checkpoint (the intermediate `summary`/`backlog`/`validation` needed to resume mid-flow).
- `CouncilStateStore.write` creates the parent dir (`mkdir -p`) and is **atomic** (unique temp file in the same directory, then `rename`), reusing the shared `atomicWriteFile` helper; a `state.json` is never left half-written.
- `CouncilStateStore.read` validates `schemaVersion` before use and raises `StateError` (CORE-COMPONENT-0008) for a missing, corrupt, or version-incompatible file; it never returns a fresh/empty state.
- `state.json` joins the transcript and artifacts as authoritative run state and is committed to source control; the concurrency lock file is not.
- Concurrent `run`/`continue` of the same council is prevented by an exclusive lock file `council/<council>/.council.lock`, acquired by an atomic create (`wx`) and released on every exit path; a stale lock is overridable via `--force`. A lock conflict raises `StateError`.

### Interfaces
- `class TranscriptStore { append(turn: TranscriptTurn): Promise<void> }`
- `class ArtifactStore { write(relativePath: string, content: string): Promise<string> }`
- `class CouncilStateStore { read(): Promise<CouncilState>; write(state: CouncilState): Promise<void>; exists(): Promise<boolean> }`
- `class CouncilLock { acquire(force?: boolean): Promise<void>; release(): Promise<void> }`
- `atomicWriteFile(targetPath, content)` — shared internal helper (temp file + `rename`) used by `CouncilStateStore` and `add-member`.

### Expectations
- `append` never truncates existing transcript content.
- `write` resolves relative paths against the store's base directory and returns the absolute path written.
- `write` throws a plain `Error` on path traversal; callers (e.g. `runBacklogCouncil`) wrap such failures in a typed `OrchestrationError` (CORE-COMPONENT-0008) with the cause preserved, and a failed artifact write never discards already-appended transcript content.
- `CouncilStateStore.write` is atomic and creates the parent directory; a reader never observes a partially written `state.json`.
- `CouncilStateStore.read` raises `StateError` (not a silent empty state) for a missing, corrupt, or `schemaVersion`-incompatible file.
- `CouncilLock.release` runs on every exit path (success or failure); `acquire` is TOCTOU-safe via an atomic `wx` create and only an explicit `--force` clears a pre-existing lock.

## Rationale

Plain Markdown files are diffable, reviewable, and portable. Keeping the stores tiny and dependency-free matches the PRD's "keep it boring and file-based for v0" guidance.

## Usage Examples

```ts
import { TranscriptStore, ArtifactStore } from "conclave";

const transcript = new TranscriptStore("council/scrum-project-x/transcript/full.md");
await transcript.append({ member: "scrum-sme", prompt: "Draft backlog", response: "..." });

const artifacts = new ArtifactStore("council/scrum-project-x");
await artifacts.write("artifacts/backlog.md", "# Backlog\n...");

const state = new CouncilStateStore("council/scrum-project-x/state.json");
await state.write({ schemaVersion: 1, councilId: "scrum-project-x", status: "in-progress", lastPhase: "draft", lastRound: 0, members: [{ id: "proj", sessionId: "scrum-project-x/proj" }], configHash: "…", createdAt: "…", updatedAt: "…", products: { backlog: "…" } });
const resumed = await state.read(); // throws StateError if missing/corrupt/incompatible
```

## Integration Guidelines

- Route all council persistence through these stores; never write transcript/artifact files directly.
- Use relative paths with `ArtifactStore`; let the store own the base directory.

## Exceptions

- Tests may write to OS temp directories.

## Enforcement

- [x] Automated checks (`src/runtime/council-runtime.test.ts` exercises the transcript store)
- [x] Code review checklist
- [x] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
