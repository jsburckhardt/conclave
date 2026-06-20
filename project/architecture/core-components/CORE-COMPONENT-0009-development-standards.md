# CORE-COMPONENT-0009: Development Standards

## Status

Adopted

## Purpose

Define the coding, commit, and testing conventions every contributor (human or agent) follows, so the Conclave codebase stays consistent, reviewable, and verifiable.

## Scope

Affects all TypeScript source, tests, and commits in this repository. Boundaries: this component defines conventions and the commands that enforce them; per-feature design lives in issues, ADRs, and other core-components.

## Definition

### Rules

**Coding conventions**
- Use TypeScript `strict` mode; provide explicit types on exported function signatures.
- Prefer named exports over default exports.
- Use `async/await` over raw Promise chains.
- Use ESM with NodeNext resolution; intra-project imports include the `.js` extension.
- Lint with ESLint + typescript-eslint; format with Prettier (config in `.prettierrc.json`).

**Commit standards**
- Follow Conventional Commits v1.0.0 (see CORE-COMPONENT-0002), with a scope where applicable.
- Include a `Co-authored-by` trailer on AI-authored commits.

**Testing practices**
- Use `vitest`; co-locate test files as `*.test.ts` next to the code they cover.
- Organize tests with `describe`/`it`.
- Write unit tests for all exported functions and classes; target ≥80% coverage.

### Interfaces
- `npm run build` — type-check and emit (`tsc`).
- `npm run lint` — ESLint.
- `npm run format` / `npm run format:check` — Prettier (scoped to `src/**` and root config).
- `npm test` / `npm run test:coverage` — vitest.
- `npm run typecheck` — `tsc --noEmit`.

### Expectations
- All verification commands pass before a PR is opened (see `.github/soft-factory/verification.yml`).
- New modules ship with matching tests.

## Rationale

These are mainstream TypeScript/Node conventions backed by tooling that runs locally and in verification, minimizing review friction and bikeshedding.

## Usage Examples

```bash
npm run lint && npm run typecheck && npm test && npm run format:check
```

## Integration Guidelines

- Wire new checks into both `package.json` scripts and `.github/soft-factory/verification.yml`.
- Keep Prettier scoped to owned source/config; do not reformat pre-existing repository documentation.

## Exceptions

- Generated code and third-party vendored files are exempt from formatting/lint.

## Enforcement

- [x] Automated checks (lint, typecheck, test, format:check)
- [x] Code review checklist
- [x] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
