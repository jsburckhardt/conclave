import { CopilotClient, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import type { MemberConfig } from "../config/council-config.js";
import type { Logger } from "../logging/logger.js";
import { createLogger } from "../logging/logger.js";
import type { MemberSession, SessionFactory } from "./council-runtime.js";
import { createPermissionHandler } from "./permission-handler.js";
import { SessionError } from "../errors.js";

/**
 * Copilot SDK-backed {@link SessionFactory}. Creates one persistent session per
 * council member, keyed by a stable `<councilId>/<memberId>` session id so
 * councils can be resumed later.
 */
export class CopilotSessionFactory implements SessionFactory {
  private readonly client: CopilotClient;
  private readonly logger: Logger;

  constructor(client?: CopilotClient, logger?: Logger) {
    this.client = client ?? new CopilotClient();
    this.logger = logger ?? createLogger();
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async createSession(member: MemberConfig, councilId: string): Promise<MemberSession> {
    const config: SessionConfig = {
      sessionId: `${councilId}/${member.id}`,
      workingDirectory: member.cwd,
      agent: member.agent,
      streaming: true,
      // Enforce the read-only policy on every live session via a fail-closed,
      // single-sourced handler (CORE-COMPONENT-0007); never approveAll.
      onPermissionRequest: createPermissionHandler(member, this.logger),
    };
    const session = await this.client.createSession(config);
    return new CopilotMemberSession(session);
  }

  async stop(): Promise<void> {
    const errors = await this.client.stop();
    if (errors.length > 0) {
      throw new SessionError(`Copilot client stopped with ${errors.length} error(s)`, {
        cause: errors[0],
      });
    }
  }
}

class CopilotMemberSession implements MemberSession {
  constructor(private readonly session: CopilotSession) {}

  async sendAndWait(prompt: string): Promise<string> {
    const result = await this.session.sendAndWait({ prompt });
    return result?.data?.content ?? "";
  }
}
