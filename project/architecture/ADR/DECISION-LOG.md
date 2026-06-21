# Decision Log

This file is the single registry of all architectural decisions and core-components in the project. Every new or modified ADR or core-component **must** be recorded here.

## ADRs

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-0002 | TypeScript + GitHub Copilot SDK Multi-Session Runtime | Accepted | 2026-06-18 |

## Core-Components

| ID | Title | Status | Date |
|----|-------|--------|------|
| CORE-COMPONENT-0002 | Commit Standards | Adopted | 2026-05-05 |
| CORE-COMPONENT-0003 | Configuration | Adopted | 2026-06-21 |
| CORE-COMPONENT-0004 | Session Lifecycle and Persistence | Adopted | 2026-06-18 |
| CORE-COMPONENT-0005 | Logging and Observability | Adopted | 2026-06-18 |
| CORE-COMPONENT-0006 | Artifact and Transcript Store | Adopted | 2026-06-18 |
| CORE-COMPONENT-0007 | Permission Policy | Adopted | 2026-06-20 |
| CORE-COMPONENT-0008 | Error Handling | Adopted | 2026-06-18 |
| CORE-COMPONENT-0009 | Development Standards | Adopted | 2026-06-18 |

## Decisions

Short, actionable statements derived from ADRs and core-components. More than one decision can originate from a single source.

| # | Decision | Source | Date |
|---|----------|--------|------|
| 1 | Enforce Conventional Commits v1.0.0 on every commit message | CORE-COMPONENT-0002 | 2026-05-05 |
| 2 | Require Conventional Commits format on PR titles | CORE-COMPONENT-0002 | 2026-05-05 |
| 3 | Require Co-authored-by trailer on all AI-authored commits | CORE-COMPONENT-0002 | 2026-05-05 |
| 4 | Adopt TypeScript on Node.js (>=20, ESM) as the implementation stack | ADR-0002 | 2026-06-18 |
| 5 | Use @github/copilot-sdk with one persistent session per council member (Model A) | ADR-0002 | 2026-06-18 |
| 6 | Validate council.yaml centrally; members default to read-only | CORE-COMPONENT-0003 | 2026-06-18 |
| 7 | Decouple orchestration from the Copilot SDK via a SessionFactory abstraction | CORE-COMPONENT-0004 | 2026-06-18 |
| 8 | Key member sessions by stable "<councilId>/<memberId>" ids for resumability | CORE-COMPONENT-0004 | 2026-06-18 |
| 9 | Emit line-delimited JSON structured logs through a shared logger | CORE-COMPONENT-0005 | 2026-06-18 |
| 10 | Treat file-based transcript and artifacts as the council source of truth | CORE-COMPONENT-0006 | 2026-06-18 |
| 11 | Default council members to read-only and enforce it in live Copilot sessions | CORE-COMPONENT-0007 | 2026-06-20 |
| 12 | Use a typed CouncilError hierarchy with stable error codes | CORE-COMPONENT-0008 | 2026-06-18 |
| 13 | Enforce strict TypeScript, ESLint/Prettier, and vitest with >=80% coverage | CORE-COMPONENT-0009 | 2026-06-18 |
| 14 | Build each member session's permission handler from createMemberPermissionPolicy, never approveAll | CORE-COMPONENT-0007 | 2026-06-20 |
| 15 | Classify unknown, memory, MCP, tool, hook, and shell permission requests as writes (fail-closed) | CORE-COMPONENT-0007 | 2026-06-20 |
| 16 | Exclude filesystem paths and secrets from permission feedback and decision logs | CORE-COMPONENT-0007 | 2026-06-20 |
| 17 | Resolve every council's `council.yaml` path only through `resolveCouncilConfigPath(council, baseDir?)` | CORE-COMPONENT-0003 | 2026-06-21 |
| 18 | Standardize the on-disk council layout as `council/<council>/council.yaml` | CORE-COMPONENT-0003 | 2026-06-21 |
| 19 | Reject `<council>` path arguments that escape the council root with a traversal-guarded `ConfigError` | CORE-COMPONENT-0003 | 2026-06-21 |
| 20 | Persist the edited YAML document (comments, key order, unknown keys), never the normalized validator output | CORE-COMPONENT-0003 | 2026-06-21 |
