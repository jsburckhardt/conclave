import { dirname, join } from "node:path";
import { resolveCouncilConfigPath } from "../config/council-config.js";
import { ConfigError } from "../errors.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { TranscriptStore } from "../store/transcript-store.js";
import { ArtifactStore } from "../store/artifact-store.js";
import {
  CouncilStateStore,
  type CouncilState,
  type CouncilStateProducts,
} from "../store/council-state-store.js";
import { CouncilLock, councilConfigHash } from "../store/council-lock.js";
import { CouncilRuntime, type SessionFactory } from "../runtime/council-runtime.js";
import { CopilotSessionFactory } from "../runtime/copilot-session-factory.js";
import {
  runBacklogCouncil,
  type PhaseCheckpoint,
  type ResumePoint,
} from "../runtime/council-phases.js";
import {
  assertCouncilIdentity,
  loadConfigWithRaw,
  memberRegistry,
  resolveConfigPath,
  sessionIdFor,
  toCouncilError,
} from "./shared.js";

/**
 * Options for {@link continueCouncil}. `baseDir`, `logger`, and `sessionFactory`
 * are injectable so resume is unit-testable in-process with a fake
 * `SessionFactory` and a temp dir (the inline `CopilotSessionFactory` is never
 * constructed in tests).
 */
export interface ContinueCouncilOptions {
  /** Council slug → `council/<council>/`. */
  council: string;
  /** Optional `council.yaml` path override (`-c/--config`). */
  config?: string;
  /** Clear a stale `.council.lock` and override member-set drift (`--force`). */
  force?: boolean;
  /** Base directory; defaults to `process.cwd()`. Injected in tests. */
  baseDir?: string;
  /** Structured logger; defaults to {@link createLogger}. Injected in tests. */
  logger?: Logger;
  /** Session factory; defaults to {@link CopilotSessionFactory}. Injected in tests. */
  sessionFactory?: SessionFactory;
}

/**
 * True when the two id collections differ as **sets** (order- and
 * duplicate-insensitive). Compares distinct-id sets rather than using length as a
 * proxy for set size, so a config carrying duplicate ids (e.g. `["a","a"]`) cannot
 * masquerade as a different member set (e.g. `["a","b"]`) and weaken drift
 * protection (review thread #6).
 */
function memberSetDiffers(a: readonly string[], b: readonly string[]): boolean {
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size !== bSet.size) {
    return true;
  }
  for (const id of aSet) {
    if (!bSet.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * Resume a previously persisted council from its `state.json` checkpoint
 * (CORE-COMPONENT-0004). The flow validates **before** taking any side effect,
 * then re-drives {@link runBacklogCouncil} from the recorded phase/round:
 *
 * 1. Log `council.continue`; the whole body is wrapped so any failure logs
 *    `council.continue.failed { council, code }` and re-throws a typed
 *    {@link CouncilError} (the top-level handler logs `council.error`, exit 1).
 * 2. Resolve the canonical council dir (slug-validated, traversal-guarded);
 *    load the config + raw bytes; enforce the `config.name === <council>`
 *    identity invariant.
 * 3. Read `state.json` (`StateError` on missing/corrupt/incompatible schema —
 *    never a silent fresh start); cross-check `state.councilId === config.name`.
 * 4. An already-`completed` council is an idempotent no-op (no lock, no session).
 * 5. Member-set drift aborts with `ConfigError` unless `--force` (logged
 *    `config.drift { kind: "member-set" }`); otherwise a `configHash` change is a
 *    non-structural drift that warns and continues.
 * 6. Cross-check each derived `"<councilId>/<id>"` against the stored `sessionId`.
 * 7. Acquire the lock, `runtime.start()` (SDK failure → `SessionError`, persisted
 *    state untouched), then resume the phases with per-phase checkpoints and a
 *    terminal `completed` write. `finally`: guarded `stop()` then `release()`.
 */
export async function continueCouncil(options: ContinueCouncilOptions): Promise<void> {
  const { council } = options;
  const baseDir = options.baseDir ?? process.cwd();
  const logger = options.logger ?? createLogger();

  logger.info("council.continue", { council });

  try {
    // Canonical council dir (slug-validated + traversal-guarded, E8).
    const canonicalConfigPath = resolveCouncilConfigPath(council, baseDir);
    const councilDir = dirname(canonicalConfigPath);
    // A `--config` override must stay inside the council dir (review thread #4).
    const configPath = resolveConfigPath(councilDir, canonicalConfigPath, options.config);

    const { config, raw } = await loadConfigWithRaw(configPath);
    assertCouncilIdentity(config, council);

    const stateStore = new CouncilStateStore(join(councilDir, "state.json"));
    const state = await stateStore.read();
    logger.info("state.read", { council, lastPhase: state.lastPhase, lastRound: state.lastRound });

    // Defense-in-depth: the persisted councilId must match the resolved identity.
    if (state.councilId !== config.name) {
      throw new ConfigError(
        `state.json councilId '${state.councilId}' does not match council.yaml name ` +
          `'${config.name}' for council '${council}'.`,
      );
    }

    // E7: resuming a completed council is a safe, idempotent no-op — no lock taken,
    // no session started, state.json left untouched.
    if (state.status === "completed") {
      logger.info("council.continue.completed", { council, status: state.status });
      return;
    }

    // E4: structural (member-set) drift aborts unless forced; a pure configHash
    // change with an identical member set is non-structural and only warns.
    const configMemberIds = config.members.map((member) => member.id);
    const stateMemberIds = state.members.map((member) => member.id);
    if (memberSetDiffers(configMemberIds, stateMemberIds)) {
      if (!options.force) {
        throw new ConfigError(
          `Council member set changed since the last run (state: [${stateMemberIds.join(", ")}], ` +
            `config: [${configMemberIds.join(", ")}]). Re-run with --force to override.`,
        );
      }
      logger.warn("config.drift", { council, kind: "member-set" });
    } else if (councilConfigHash(raw) !== state.configHash) {
      logger.warn("config.drift", { council, kind: "non-structural" });
    }

    // C5/R4: stored session ids are cross-checked against the derived stable id,
    // never blindly trusted. (After a forced member-set change, ids not present in
    // the persisted registry are simply (re)created by start().)
    for (const member of config.members) {
      const stored = state.members.find((entry) => entry.id === member.id);
      const derived = sessionIdFor(config.name, member.id);
      if (stored && stored.sessionId !== derived) {
        throw new ConfigError(
          `Session id mismatch for member '${member.id}': persisted '${stored.sessionId}' ` +
            `but derived '${derived}'.`,
        );
      }
    }

    const transcript = new TranscriptStore(join(councilDir, "transcript", "full.md"));
    const artifacts = new ArtifactStore(councilDir);
    const lock = new CouncilLock(join(councilDir, ".council.lock"));
    const sessionFactory = options.sessionFactory ?? new CopilotSessionFactory();
    const runtime = new CouncilRuntime({ config, sessionFactory, transcript, artifacts, logger });

    if (options.force) {
      logger.info("lock.forced", { council });
    }
    await lock.acquire(options.force);
    logger.info("lock.acquired", { council });

    // The working state carries the persisted identity/createdAt forward while
    // refreshing the member registry + configHash (covers a forced drift).
    let current: CouncilState = {
      ...state,
      members: memberRegistry(config),
      configHash: councilConfigHash(raw),
      updatedAt: new Date().toISOString(),
    };

    try {
      const products: CouncilStateProducts = state.products ?? {};
      const resume: ResumePoint = {
        lastPhase: state.lastPhase,
        lastRound: state.lastRound,
        products,
      };

      const checkpoint = async (cp: PhaseCheckpoint): Promise<void> => {
        current = {
          ...current,
          lastPhase: cp.lastPhase,
          lastRound: cp.lastRound,
          products: cp.products,
          updatedAt: new Date().toISOString(),
        };
        await stateStore.write(current);
        logger.info("state.write", { council, lastPhase: cp.lastPhase, lastRound: cp.lastRound });
      };

      // E5/C7: an SDK resume failure throws out of start() BEFORE any write, so the
      // persisted checkpoint is preserved and the resume is retryable.
      await runtime.start();
      logger.info("council.continue.resumed", {
        council,
        members: config.members.length,
        fromPhase: state.lastPhase,
        fromRound: state.lastRound,
      });

      const result = await runBacklogCouncil(runtime, config, {
        artifacts,
        logger,
        resume,
        checkpoint,
      });

      current = { ...current, status: "completed", updatedAt: new Date().toISOString() };
      await stateStore.write(current);
      logger.info("state.write", {
        council,
        lastPhase: current.lastPhase,
        lastRound: current.lastRound,
      });

      logger.info("council.continue.completed", {
        council,
        phases: result.phases,
        rounds: result.rounds,
        artifacts: result.artifacts.length,
      });
    } finally {
      // stop() runs on every path; its failure is logged separately and must never
      // mask the primary error (CORE-COMPONENT-0004). The lock is then released.
      try {
        await runtime.stop();
      } catch (stopErr) {
        logger.error("council.stop.error", {
          message: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
      await lock.release();
      logger.info("lock.released", { council });
    }
  } catch (error) {
    const councilError = toCouncilError(error);
    logger.error("council.continue.failed", { council, code: councilError.code });
    throw councilError;
  }
}
