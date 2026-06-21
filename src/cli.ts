#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import { scaffoldCouncil } from "./commands/init.js";
import { loadCouncilConfig } from "./config/council-config.js";
import { createLogger } from "./logging/logger.js";
import { CouncilError } from "./errors.js";
import { TranscriptStore } from "./store/transcript-store.js";
import { ArtifactStore } from "./store/artifact-store.js";
import { CouncilRuntime } from "./runtime/council-runtime.js";
import { CopilotSessionFactory } from "./runtime/copilot-session-factory.js";
import { runBacklogCouncil, normalizePolicy, resolveRoles } from "./runtime/council-phases.js";

const logger = createLogger();

function notImplemented(command: string): void {
  process.stderr.write(`'council ${command}' is not implemented yet (see project backlog)\n`);
  process.exitCode = 1;
}

const program = new Command();

program
  .name("council")
  .description("Conclave — a programmable orchestration layer for Copilot-powered repo councils")
  .version("0.0.0");

program
  .command("init")
  .description("Scaffold a new council directory with a council.yaml")
  .argument("<name>", "council name")
  .action(async (name: string) => {
    logger.info("council.init", { name });
    await scaffoldCouncil({ name, logger });
  });

program
  .command("add-member")
  .description("Add a member to an existing council")
  .argument("<council>", "council name")
  .argument("<memberId>", "member id")
  .action((council: string, memberId: string) => {
    logger.info("council.add-member", { council, memberId });
    notImplemented("add-member");
  });

program
  .command("run")
  .description("Run the council phases to produce artifacts")
  .argument("<council>", "council name")
  .option("-c, --config <path>", "path to council.yaml", "council.yaml")
  .action(async (council: string, options: { config: string }) => {
    const config = await loadCouncilConfig(options.config);
    logger.info("council.run", { council, members: config.members.length, goal: config.goal });

    // Fail fast on contradictory policy / unresolvable roles BEFORE starting the
    // runtime, so invalid config surfaces as an actionable typed error without the
    // cost and side effects of creating real member sessions. These pure checks are
    // idempotent; runBacklogCouncil re-validates to stay self-contained.
    normalizePolicy(config.orchestrator.policy);
    resolveRoles(config);

    // Q9: durable paths key on config.name (consistent with runtime session ids).
    const base = join("council", config.name);
    const transcript = new TranscriptStore(join(base, "transcript", "full.md"));
    const artifacts = new ArtifactStore(base);
    const runtime = new CouncilRuntime({
      config,
      sessionFactory: new CopilotSessionFactory(),
      transcript,
      artifacts,
      logger,
    });

    try {
      await runtime.start();
      const result = await runBacklogCouncil(runtime, config, { artifacts, logger });
      logger.info("council.run.complete", {
        council: config.name,
        context: result.contextMemberId,
        backlog: result.backlogMemberId,
        phases: result.phases,
        rounds: result.rounds,
        artifacts: result.artifacts.length,
        validationSkipped: result.validationSkipped,
        artifactsSkipped: result.artifactsSkipped,
      });
    } finally {
      // stop() runs on every path; its failure is logged separately and must
      // never mask the primary error (CORE-COMPONENT-0004).
      try {
        await runtime.stop();
      } catch (stopErr) {
        logger.error("council.stop.error", {
          message: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    }
  });

program
  .command("continue")
  .description("Resume a previously persisted council")
  .argument("<council>", "council name")
  .action((council: string) => {
    logger.info("council.continue", { council });
    notImplemented("continue");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const fields =
    error instanceof CouncilError
      ? { code: error.code, error: error.message }
      : { error: error instanceof Error ? error.message : String(error) };
  logger.error("council.error", fields);
  process.exitCode = 1;
});
