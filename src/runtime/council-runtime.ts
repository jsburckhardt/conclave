import type { CouncilConfig, MemberConfig } from "../config/council-config.js";
import type { Logger } from "../logging/logger.js";
import { createLogger } from "../logging/logger.js";
import type { TranscriptStore } from "../store/transcript-store.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import { SessionError } from "../errors.js";

/**
 * A single council member's session, abstracted from the concrete Copilot SDK so
 * the runtime can be unit-tested with fakes.
 */
export interface MemberSession {
  sendAndWait(prompt: string): Promise<string>;
}

/**
 * Creates and tears down member sessions. The Copilot SDK adapter is one
 * implementation; tests provide an in-memory fake.
 */
export interface SessionFactory {
  start(): Promise<void>;
  createSession(member: MemberConfig, councilId: string): Promise<MemberSession>;
  stop(): Promise<void>;
}

export interface CouncilRuntimeOptions {
  config: CouncilConfig;
  sessionFactory: SessionFactory;
  transcript: TranscriptStore;
  artifacts: ArtifactStore;
  logger?: Logger;
}

/**
 * Orchestrates a council of Copilot-backed member sessions. v0 focuses on the
 * foundational lifecycle (start, ask, persist transcript, stop); concrete
 * council phases are layered on top via the issue pipeline.
 */
export class CouncilRuntime {
  private readonly sessions = new Map<string, MemberSession>();
  private readonly logger: Logger;

  constructor(private readonly options: CouncilRuntimeOptions) {
    this.logger = options.logger ?? createLogger();
  }

  async start(): Promise<void> {
    await this.options.sessionFactory.start();
    for (const member of this.options.config.members) {
      const session = await this.options.sessionFactory.createSession(
        member,
        this.options.config.name,
      );
      this.sessions.set(member.id, session);
      this.logger.info("session.created", { member: member.id, cwd: member.cwd });
    }
  }

  async askMember(memberId: string, prompt: string): Promise<string> {
    const session = this.sessions.get(memberId);
    if (!session) {
      throw new SessionError(`Unknown council member: ${memberId}`);
    }
    const response = await session.sendAndWait(prompt);
    await this.options.transcript.append({ member: memberId, prompt, response });
    return response;
  }

  async stop(): Promise<void> {
    await this.options.sessionFactory.stop();
    this.sessions.clear();
  }
}
