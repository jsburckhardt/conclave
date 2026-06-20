import {
  CopilotClient,
  approveAll,
  type CopilotSession,
  type SessionConfig,
} from "@github/copilot-sdk";
import type { MemberConfig } from "../config/council-config.js";
import type { MemberSession, SessionFactory } from "./council-runtime.js";
import { SessionError } from "../errors.js";

/**
 * Copilot SDK-backed {@link SessionFactory}. Creates one persistent session per
 * council member, keyed by a stable `<councilId>/<memberId>` session id so
 * councils can be resumed later.
 */
export class CopilotSessionFactory implements SessionFactory {
  private readonly client: CopilotClient;

  constructor(client?: CopilotClient) {
    this.client = client ?? new CopilotClient();
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
      // v0 keeps approval simple; read-only enforcement is layered on later.
      onPermissionRequest: approveAll,
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
