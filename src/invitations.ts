import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Invitation tracking types
// ---------------------------------------------------------------------------

export type InvitationStatus = "pending" | "accepted" | "expired";

export interface SentInvite {
  code: string;
  to_name?: string;  // Optional name of invitee for reference
  created: string;
  expires: string;
  status: InvitationStatus;
  accepted_by?: string;  // agent_id of who accepted
  accepted_at?: string;
}

export interface ReceivedInvite {
  code: string;
  from_agent_id: string;
  from_human_name: string;
  received_at: string;
  accepted: boolean;
}

export interface InvitationHistory {
  sent: SentInvite[];
  received: ReceivedInvite[];
}

// ---------------------------------------------------------------------------
// InvitationsStore interface
// ---------------------------------------------------------------------------

export interface InvitationsStore {
  /** Add a sent invite to the history */
  addSent(code: string, toName: string | undefined, expires: string): void;

  /** Update status of a sent invite when accepted */
  updateSentStatus(code: string, status: InvitationStatus, acceptedBy?: string): void;

  /** Add a received invite to the history */
  addReceived(code: string, fromAgentId: string, fromHumanName: string): void;

  /** Get all sent invites */
  getSent(): SentInvite[];

  /** Get all received invites */
  getReceived(): ReceivedInvite[];

  /** Get full history */
  getAll(): InvitationHistory;

  /** Find a sent invite by code */
  findSentByCode(code: string): SentInvite | null;
}

// ---------------------------------------------------------------------------
// InvitationsStore implementation
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".agentlink");

export function createInvitationsStore(dataDir: string = DEFAULT_DATA_DIR): InvitationsStore {
  const filePath = path.join(dataDir, "invitations.json");

  function load(): InvitationHistory {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return {
        sent: raw.sent ?? [],
        received: raw.received ?? [],
      };
    } catch {
      return { sent: [], received: [] };
    }
  }

  function save(history: InvitationHistory): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2) + "\n");
  }

  return {
    addSent(code, toName, expires) {
      const history = load();

      // Check if invite already exists (shouldn't happen, but handle it)
      const existing = history.sent.find(inv => inv.code === code);
      if (existing) return;

      history.sent.push({
        code,
        to_name: toName,
        created: new Date().toISOString(),
        expires,
        status: "pending",
      });

      save(history);
    },

    updateSentStatus(code, status, acceptedBy) {
      const history = load();
      const invite = history.sent.find(inv => inv.code === code);

      if (!invite) return;

      invite.status = status;
      if (acceptedBy) {
        invite.accepted_by = acceptedBy;
        invite.accepted_at = new Date().toISOString();
      }

      save(history);
    },

    addReceived(code, fromAgentId, fromHumanName) {
      const history = load();

      // Check if we already have this invite
      const existing = history.received.find(
        inv => inv.code === code && inv.from_agent_id === fromAgentId
      );
      if (existing) return;

      history.received.push({
        code,
        from_agent_id: fromAgentId,
        from_human_name: fromHumanName,
        received_at: new Date().toISOString(),
        accepted: true,  // If we're adding it, we accepted it
      });

      save(history);
    },

    getSent() {
      return [...load().sent];
    },

    getReceived() {
      return [...load().received];
    },

    getAll() {
      const history = load();
      return {
        sent: [...history.sent],
        received: [...history.received],
      };
    },

    findSentByCode(code) {
      const history = load();
      return history.sent.find(inv => inv.code === code) ?? null;
    },
  };
}
