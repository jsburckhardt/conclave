import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface TranscriptTurn {
  member: string;
  prompt: string;
  response: string;
  timestamp?: string;
}

/**
 * Append-only, file-based transcript of every council exchange. File artifacts
 * are the source of truth for council memory (independent of SDK session state).
 */
export class TranscriptStore {
  constructor(private readonly filePath: string) {}

  async append(turn: TranscriptTurn): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const timestamp = turn.timestamp ?? new Date().toISOString();
    const block = [
      `## ${turn.member} — ${timestamp}`,
      "",
      "**Prompt**",
      "",
      turn.prompt.trim(),
      "",
      "**Response**",
      "",
      turn.response.trim(),
      "",
      "---",
      "",
    ].join("\n");
    await appendFile(this.filePath, block, "utf8");
  }
}
