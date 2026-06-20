# CORE-COMPONENT-0006: Artifact and Transcript Store

## Status

Adopted

## Purpose

File artifacts are the durable source of truth for a council — not session memory. Every exchange is appended to a transcript, and final outputs (backlog, decisions, open questions) are written as artifacts. Centralizing this guarantees councils remain auditable and resumable even if session state is lost.

## Scope

Affects code that persists council memory and outputs (`src/store/`). Boundaries: these stores handle file IO and formatting only; they do not decide what to write or when.

## Definition

### Rules
- All council exchanges are appended via `TranscriptStore.append` (`src/store/transcript-store.ts`).
- Final outputs are written via `ArtifactStore.write` (`src/store/artifact-store.ts`).
- Stores create parent directories as needed (`mkdir -p` semantics).
- Transcript entries are append-only Markdown blocks containing member, timestamp, prompt, and response.
- File-based memory is authoritative; SDK session memory is a convenience, not the source of truth.

### Interfaces
- `class TranscriptStore { append(turn: TranscriptTurn): Promise<void> }`
- `class ArtifactStore { write(relativePath: string, content: string): Promise<string> }`

### Expectations
- `append` never truncates existing transcript content.
- `write` resolves relative paths against the store's base directory and returns the absolute path written.

## Rationale

Plain Markdown files are diffable, reviewable, and portable. Keeping the stores tiny and dependency-free matches the PRD's "keep it boring and file-based for v0" guidance.

## Usage Examples

```ts
import { TranscriptStore, ArtifactStore } from "conclave";

const transcript = new TranscriptStore("council/scrum-project-x/transcript/full.md");
await transcript.append({ member: "scrum-sme", prompt: "Draft backlog", response: "..." });

const artifacts = new ArtifactStore("council/scrum-project-x");
await artifacts.write("artifacts/backlog.md", "# Backlog\n...");
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
