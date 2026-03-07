import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { v4 as uuid } from "uuid";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface AgentLinkConfig {
  brokerUrl: string;
  brokerUsername?: string;
  brokerPassword?: string;
  agent: {
    id: string;
    description?: string;
    capabilities: Capability[];
  };
  outputMode: "user" | "debug";
  jobTimeoutMs: number;
  dataDir: string;
}

export interface Capability {
  name: string;
  tool: string;
  description?: string;
  input_hint?: string;
}

export function resolveConfig(rawConfig: Record<string, unknown>): AgentLinkConfig {
  const cfg = rawConfig as Record<string, unknown>;
  const agent = cfg.agent as Record<string, unknown> | undefined;
  const capabilities = (agent?.capabilities as Capability[] | undefined) ?? [];

  // Resolve dataDir first — needed for persistent agent ID lookup
  const dataDir = (cfg.data_dir as string) ?? path.join(os.homedir(), ".agentlink");

  // 3-tier agent ID resolution:
  // 1. Explicit agent.id from config (user-configured)
  // 2. Persistent agent_id from <dataDir>/state.json (set by CLI setup)
  // 3. Temp fallback agent-HOSTNAME-PID (dev without setup)
  let agentId = agent?.id as string | undefined;
  if (!agentId) {
    try {
      const stateFile = path.join(dataDir, "state.json");
      if (fs.existsSync(stateFile)) {
        const stateData = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        if (stateData.agent_id && typeof stateData.agent_id === "string") {
          agentId = stateData.agent_id;
        }
      }
    } catch {
      // state.json unreadable — fall through to temp ID
    }
  }
  if (!agentId) {
    agentId = `agent-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "")}-${process.pid}`;
  }

  return {
    brokerUrl: (cfg.brokerUrl as string) ?? "mqtt://broker.emqx.io:1883",
    brokerUsername: cfg.brokerUsername as string | undefined,
    brokerPassword: cfg.brokerPassword as string | undefined,
    agent: {
      id: agentId,
      description: agent?.description as string | undefined,
      capabilities,
    },
    outputMode: (cfg.output_mode as "user" | "debug") ?? "user",
    jobTimeoutMs: (cfg.job_timeout_ms as number) ?? 60_000,
    dataDir,
  };
}

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export type MessageType = "chat" | "job_request" | "job_response" | "join" | "leave";

export type JobStatus = "requested" | "completed" | "failed" | "awaiting_approval";

export interface CoordinationHeader {
  driver_agent_id: string;
  goal: string;
  done_when: string;
}

export interface ProposalPayload {
  summary: string;
  requires_approval: boolean;
}

export interface MessagePayload {
  text?: string;
  capability?: string;
  status?: JobStatus;
  result?: string;
  proposal?: ProposalPayload;
  [key: string]: unknown;
}

export interface MessageEnvelope {
  v: 1;
  id: string;
  group_id: string;
  intent_id: string;
  from: string;
  to: "group" | string;
  type: MessageType;
  correlation_id?: string;
  coordination?: CoordinationHeader;
  payload: MessagePayload;
  ts: string;
}

// ---------------------------------------------------------------------------
// Agent status (retained message)
// ---------------------------------------------------------------------------

export interface CapabilityAdvertisement {
  name: string;
  description: string;
  input_hint: string;
}

export interface AgentStatus {
  agent_id: string;
  owner: string;
  status: "online" | "offline";
  capabilities: CapabilityAdvertisement[];
  description?: string;
  ts: string;
}

// ---------------------------------------------------------------------------
// Invite types
// ---------------------------------------------------------------------------

export interface InviteMessage {
  type: "invite";
  group_id: string;
  from: string;
  goal: string;
  done_when: string;
  ts: string;
}

export interface InviteCodePayload {
  group_id: string;
  from: string;
  goal: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface GroupState {
  group_id: string;
  driver: string;
  goal: string;
  done_when: string;
  intent_id: string;
  participants: string[];
  participant_capabilities?: Record<string, Array<{ name: string; description: string }>>;
  status: "active" | "closing";
  idle_turns: number;
  created_at: string;
}

export interface PendingJob {
  correlation_id: string;
  group_id: string;
  target: string;
  capability: string;
  status: JobStatus;
  sent_at: string;
  text?: string;
}

export interface TimedOutJob extends PendingJob {
  timed_out: true;
}

// ---------------------------------------------------------------------------
// Helper: message construction
// ---------------------------------------------------------------------------

export function createEnvelope(
  from: string,
  overrides: Partial<MessageEnvelope> & Pick<MessageEnvelope, "group_id" | "to" | "type" | "payload">,
): MessageEnvelope {
  return {
    v: 1,
    id: uuid(),
    intent_id: overrides.intent_id ?? uuid(),
    from,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Topic helpers
// ---------------------------------------------------------------------------

export const TOPICS = {
  inbox: (agentId: string) =>
    `agentlink/agents/${agentId}/inbox`,

  groupMessages: (groupId: string, agentId: string) =>
    `agentlink/${groupId}/messages/${agentId}`,

  groupMessagesWildcard: (groupId: string) =>
    `agentlink/${groupId}/messages/+`,

  groupStatus: (groupId: string, agentId: string) =>
    `agentlink/${groupId}/status/${agentId}`,

  groupStatusWildcard: (groupId: string) =>
    `agentlink/${groupId}/status/+`,

  groupSystem: (groupId: string) =>
    `agentlink/${groupId}/system`,

  groupAll: (groupId: string) =>
    `agentlink/${groupId}/#`,

  inviteCode: (code: string) =>
    `agentlink/invites/${code}`,
} as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isInviteMessage(msg: unknown): msg is InviteMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "invite" &&
    typeof (msg as Record<string, unknown>).group_id === "string" &&
    typeof (msg as Record<string, unknown>).from === "string"
  );
}

export function isMessageEnvelope(msg: unknown): msg is MessageEnvelope {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.v === 1 &&
    typeof m.id === "string" &&
    typeof m.from === "string" &&
    typeof m.type === "string"
  );
}
