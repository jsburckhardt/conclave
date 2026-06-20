#!/usr/bin/env node
import { Command } from "commander";
import { scaffoldCouncil } from "./commands/init.js";
import { loadCouncilConfig } from "./config/council-config.js";
import { createLogger } from "./logging/logger.js";

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
    notImplemented("run");
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
  logger.error("council.error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
