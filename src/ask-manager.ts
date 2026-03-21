import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AskDecision =
  | "allow-once"
  | "allow-always-contact"
  | "allow-always-everyone"
  | "deny"
  | "timeout";

export interface AskRecord {
  id: string;
  scope: string;
  contactAgentId: string;
  contactName: string;
  description: string;
  createdAt: string;
  status: "pending" | "resolved" | "timeout";
  decision?: AskDecision;
  resolvedAt?: string;
}

interface PendingEntry {
  record: AskRecord;
  resolve: (decision: AskDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// AskManager
// ---------------------------------------------------------------------------

export class AskManager {
  private pending = new Map<string, PendingEntry>();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Register a new ask. Writes the pending file, returns a Promise
   * that resolves when the human decides or timeout is reached.
   */
  register(record: AskRecord, timeoutMs = 120_000): Promise<AskDecision> {
    record.createdAt = new Date().toISOString();
    record.status = "pending";

    this.writeFile(record);

    return new Promise<AskDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id);
        record.status = "timeout";
        record.decision = "timeout";
        record.resolvedAt = new Date().toISOString();
        this.writeFile(record);
        resolve("timeout");
      }, timeoutMs);

      this.pending.set(record.id, { record, resolve, timer });
    });
  }

  /**
   * Resolve a pending ask. Returns true if the ask was still pending
   * in-memory (instant wake-up). Returns false if already timed out
   * (file is still updated for late replies).
   */
  resolve(askId: string, decision: AskDecision): boolean {
    // Update the file regardless
    const record = this.readFile(askId);
    if (record) {
      record.status = "resolved";
      record.decision = decision;
      record.resolvedAt = new Date().toISOString();
      this.writeFile(record);
    }

    // Wake up the waiting Promise if still pending
    const entry = this.pending.get(askId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(askId);
      entry.resolve(decision);
      return true;
    }

    return false;
  }

  /** Check if there's a pending ask for a given contact. */
  hasPendingForContact(contactAgentId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.record.contactAgentId === contactAgentId) return true;
    }
    return false;
  }

  /** Get a pending record by ID (from Map or falls back to file). */
  getPending(askId: string): AskRecord | null {
    return this.pending.get(askId)?.record ?? this.readFile(askId);
  }

  // --- File I/O (private) ---

  private filePath(askId: string): string {
    return path.join(this.dataDir, "pending-asks", `${askId}.json`);
  }

  private writeFile(record: AskRecord): void {
    const dir = path.join(this.dataDir, "pending-asks");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath(record.id) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, this.filePath(record.id));
  }

  private readFile(askId: string): AskRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath(askId), "utf-8"));
    } catch {
      return null;
    }
  }
}
