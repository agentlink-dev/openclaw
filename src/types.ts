import { v4 as uuid } from "uuid";

// ---------------------------------------------------------------------------
// Agent ID format: slug-XXXX (e.g., arya-7k3x)
// ---------------------------------------------------------------------------

const ID_SUFFIX_LENGTH = 4;
const ID_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateAgentId(humanName: string): string {
  const slug = humanName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "agent";
  const suffix = Array.from({ length: ID_SUFFIX_LENGTH }, () =>
    ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)]
  ).join("");
  return `${slug}-${suffix}`;
}

export function isValidAgentId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,30}$/.test(id);
}

// ---------------------------------------------------------------------------
// MQTT Topics
// ---------------------------------------------------------------------------

export const TOPICS = {
  /** Agent A's inbox from a specific sender */
  inbox(recipientId: string, senderId: string): string {
    return `agentlink/agents/${recipientId}/from/${senderId}`;
  },
  /** Wildcard subscription for all messages to an agent */
  inboxAll(agentId: string): string {
    return `agentlink/agents/${agentId}/from/#`;
  },
  /** Agent's online/offline status (retained) */
  status(agentId: string): string {
    return `agentlink/agents/${agentId}/status`;
  },
  /** Invite code topic (retained) */
  invite(code: string): string {
    return `agentlink/invites/${code}`;
  },
} as const;

/** Extract sender ID from an inbox topic */
export function parseSenderFromTopic(topic: string): string | null {
  const match = topic.match(/^agentlink\/agents\/[^/]+\/from\/(.+)$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Message Envelope
// ---------------------------------------------------------------------------

export type MessageType = "message" | "contact_exchange";

export type MessageOrigin = "tool" | "auto";

/**
 * Message context: semantic hint about the message's purpose
 * - "ask": Question expecting an answer
 * - "tell": Statement/update, no response needed
 */
export type MessageContext = "ask" | "tell";

export const MESSAGE_CONTEXTS = {
  ASK: "ask",
  TELL: "tell",
} as const;

export function isValidContext(ctx: string): ctx is MessageContext {
  return ctx === "ask" || ctx === "tell";
}

export interface MessageEnvelope {
  version: 1;
  type: MessageType;
  from: string;
  from_name: string;
  to: string;
  text?: string;
  origin?: MessageOrigin;
  context?: MessageContext;  // Optional: defaults to "ask"
  ts: string;
  message_id: string;
}

export function createEnvelope(
  type: MessageType,
  from: string,
  fromName: string,
  to: string,
  text?: string,
  origin?: MessageOrigin,
  context?: MessageContext,
): MessageEnvelope {
  return {
    version: 1,
    type,
    from,
    from_name: fromName,
    to,
    text,
    origin,
    context,
    ts: new Date().toISOString(),
    message_id: uuid(),
  };
}

export function parseEnvelope(raw: string): MessageEnvelope | null {
  try {
    const obj = JSON.parse(raw);
    if (obj.version !== 1) return null;
    if (!obj.type || !obj.from || !obj.to || !obj.message_id) return null;
    return obj as MessageEnvelope;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status payload (retained on status topic)
// ---------------------------------------------------------------------------

export interface AgentStatus {
  agent_id: string;
  human_name: string;
  online: boolean;
  last_seen: string;
}

export function createStatusPayload(agentId: string, humanName: string, online: boolean): AgentStatus {
  return {
    agent_id: agentId,
    human_name: humanName,
    online,
    last_seen: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Invite payload (retained on invite topic)
// ---------------------------------------------------------------------------

export interface InvitePayload {
  code: string;
  agent_id: string;
  human_name: string;
  created: string;
  expires: string;
}

const INVITE_CODE_LENGTH = 6;
const INVITE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 for readability
const INVITE_EXPIRY_DAYS = 7;

export function generateInviteCode(): string {
  return Array.from({ length: INVITE_CODE_LENGTH }, () =>
    INVITE_CHARSET[Math.floor(Math.random() * INVITE_CHARSET.length)]
  ).join("");
}

export function createInvitePayload(agentId: string, humanName: string): InvitePayload {
  const now = new Date();
  const expires = new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return {
    code: generateInviteCode(),
    agent_id: agentId,
    human_name: humanName,
    created: now.toISOString(),
    expires: expires.toISOString(),
  };
}

export function isInviteExpired(invite: InvitePayload): boolean {
  return new Date(invite.expires).getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLinkConfig {
  brokerUrl: string;
  brokerUsername?: string;
  brokerPassword?: string;
  agentId: string;
  humanName: string;
  dataDir: string;
}
