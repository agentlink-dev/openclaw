import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// A2A Markdown Log Writer
// ---------------------------------------------------------------------------
// Writes human-readable markdown log files per contact per day.
// The agent reads these when the human asks "what did you talk about?"
// Used by the relay summary to build full conversation context.
// ---------------------------------------------------------------------------

export interface A2ALogWriter {
  /** Append an outbound message to the log */
  logOutbound(contactAgentId: string, contactName: string, text: string): void;
  /** Append an inbound message to the log */
  logInbound(contactAgentId: string, contactName: string, text: string): void;
  /** Read the full log for a contact (today's file). Returns null if no log exists. */
  readLog(contactAgentId: string): string | null;
  /** Get the log file path for a contact (today). */
  getLogPath(contactAgentId: string): string;
}

export function createA2ALogWriter(
  dataDir: string,
  localAgentId: string,
  localHumanName: string,
): A2ALogWriter {
  const logsDir = path.join(dataDir, "logs");

  function ensureLogsDir(): void {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  function todayStr(): string {
    return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  }

  function timeStr(): string {
    return new Date().toISOString().split("T")[1].split(".")[0]; // HH:MM:SS
  }

  function logFilePath(contactAgentId: string): string {
    // Sanitize agent ID for filename (replace non-alphanumeric with dash)
    const safe = contactAgentId.replace(/[^a-z0-9-]/gi, "-");
    return path.join(logsDir, `${safe}-${todayStr()}.md`);
  }

  function appendEntry(
    contactAgentId: string,
    contactName: string,
    direction: "outbound" | "inbound",
    text: string,
  ): void {
    ensureLogsDir();
    const filePath = logFilePath(contactAgentId);
    const isNew = !fs.existsSync(filePath);

    let entry = "";
    if (isNew) {
      entry += `# Conversation with ${contactName} (${contactAgentId}) — ${todayStr()}\n\n`;
    }

    const fromLabel =
      direction === "outbound"
        ? `${localHumanName}'s agent (${localAgentId})`
        : `${contactName}'s agent (${contactAgentId})`;

    const toLabel =
      direction === "outbound"
        ? `${contactName}'s agent (${contactAgentId})`
        : `${localHumanName}'s agent (${localAgentId})`;

    entry += `**${timeStr()}** ${fromLabel} → ${toLabel}:\n${text}\n\n`;

    fs.appendFileSync(filePath, entry);
  }

  return {
    logOutbound(contactAgentId, contactName, text) {
      appendEntry(contactAgentId, contactName, "outbound", text);
    },

    logInbound(contactAgentId, contactName, text) {
      appendEntry(contactAgentId, contactName, "inbound", text);
    },

    readLog(contactAgentId) {
      const filePath = logFilePath(contactAgentId);
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
    },

    getLogPath(contactAgentId) {
      return logFilePath(contactAgentId);
    },
  };
}
