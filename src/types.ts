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
  const match = topic.match(/^agentlink\/agents\/([^/]+)\/from\/([^/]+)$/);
  return match ? match[2] : null;
}

// ---------------------------------------------------------------------------
// Message Envelope
// ---------------------------------------------------------------------------

export type MessageType = "message" | "contact_exchange";

export interface MessageEnvelope {
  type: MessageType;
  from: string;
  from_name: string;
  to: string;
  text?: string; // Message body
  capabilities?: string[]; // Agent capabilities (for contact_exchange)
  origin?: "tool" | "auto"; // Differentiate human-initiated vs auto-respond
  context?: "ask" | "tell"; // Message context: 'ask' = expect response, 'tell' = one-way
  ack?: boolean; // Contact exchange acknowledgment
  timestamp: number;
}

export function createEnvelope(
  type: MessageType,
  from: string,
  fromName: string,
  to: string,
  text?: string,
  origin?: "tool" | "auto",
  context?: "ask" | "tell",
  capabilities?: string[],
): MessageEnvelope {
  return {
    type,
    from,
    from_name: fromName,
    to,
    text,
    origin,
    context,
    capabilities,
    timestamp: Date.now(),
  };
}

export function parseEnvelope(payload: string): MessageEnvelope | null {
  try {
    const data = JSON.parse(payload);
    if (!data.type || !data.from || !data.to) return null;
    return data as MessageEnvelope;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent Status
// ---------------------------------------------------------------------------

export interface AgentStatus {
  agent_id: string;
  human_name: string;
  online: boolean;
  timestamp: number;
}

export function createStatusPayload(
  agentId: string,
  humanName: string,
  online: boolean,
): AgentStatus {
  return { agent_id: agentId, human_name: humanName, online, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Invite Payload
// ---------------------------------------------------------------------------

export interface InvitePayload {
  code: string;
  agent_id: string;
  human_name: string;
  created: string; // ISO 8601
  expires: string; // ISO 8601
}

export function createInvitePayload(
  agentId: string,
  humanName: string,
): InvitePayload {
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
  return {
    code: generateInviteCode(),
    agent_id: agentId,
    human_name: humanName,
    created: now.toISOString(),
    expires: expires.toISOString(),
  };
}

export function isInviteExpired(invite: InvitePayload): boolean {
  return new Date(invite.expires) < new Date();
}

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No confusing chars (0,O,I,1)
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ---------------------------------------------------------------------------
// Origin Context (for relay routing)
// ---------------------------------------------------------------------------

export interface OriginContext {
  sessionKey: string;
  channel: string;
  agentId: string;
  timestamp: number;
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
  landingPageUrl?: string; // Base URL for invite landing page (default: https://website-agentlink.vercel.app)
  capabilities?: string[]; // Agent's capabilities (plugins, skills, tools)
}

// ---------------------------------------------------------------------------
// OpenClaw Plugin API Types
// ---------------------------------------------------------------------------

export type OpenClawPluginToolContext = {
  config?: unknown;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  sandboxed?: boolean;
};

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
};

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext
) => ToolDefinition | ToolDefinition[] | null | undefined;
