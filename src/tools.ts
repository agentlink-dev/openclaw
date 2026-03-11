import type { AgentLinkConfig, AgentStatus } from "./types.js";
import { createEnvelope, createInvitePayload, TOPICS } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";
import type { A2ASessionManager } from "./a2a-session.js";
import type { A2ALogWriter } from "./a2a-log.js";
import { resolveInviteCode } from "./invite.js";

// ---------------------------------------------------------------------------
// OC Tool types (minimal interface matching OpenClaw's tool API)
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Tool: agentlink_message
// ---------------------------------------------------------------------------

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export function createMessageTool(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
  a2aManager?: A2ASessionManager,
  onA2AStarted?: (agentId: string) => void,
): ToolDefinition {
  // Build dynamic description with current contacts
  const all = contacts.getAll();
  const contactEntries = Object.entries(all);
  let description =
    "Send a message to another agent via AgentLink. Use the contact's name or their agent ID. " +
    "The message will be delivered to their agent, who will respond automatically. " +
    "The conversation may continue for several exchanges autonomously.\n\n" +
    "IMPORTANT: When you use this tool, briefly tell your human what you're doing and what " +
    "you'll come back with BEFORE calling the tool. Example: \"Reaching out to Sarah's agent " +
    "to check her availability. I'll come back with times that work for both of you.\"\n\n" +
    "Do NOT mention tool names, agent IDs, MQTT, or AgentLink internals to the human.";
  if (contactEntries.length > 0) {
    const contactList = contactEntries
      .map(([name, entry]) => {
        const human = entry.human_name ? ` (${entry.human_name}'s agent)` : "";
        return `  - "${name}"${human}`;
      })
      .join("\n");
    description += `\n\nYour contacts:\n${contactList}`;
  }

  return {
    name: "agentlink_message",
    label: "AgentLink: Send Message",
    description,
    parameters: {
      type: "object",
      required: ["to", "text"],
      properties: {
        to: {
          type: "string",
          description: "Contact name or agent ID to send the message to",
        },
        text: {
          type: "string",
          description: "The message text to send",
        },
        context: {
          type: "string",
          enum: ["ask", "tell"],
          description: "Optional message context. Use 'tell' for one-way updates/confirmations (no response expected). " +
                       "Use 'ask' (or omit) when you need a response. Defaults to 'ask' if not specified.",
        },
      },
    },
    async execute(_id, params) {
      const to = params.to as string;
      const messageText = params.text as string;
      const context = params.context as "ask" | "tell" | undefined;

      if (!to || !messageText) {
        return text("Error: both 'to' and 'text' are required.");
      }

      // Resolve contact name to agent ID
      const agentId = contacts.resolve(to);
      if (!agentId) {
        return text(
          `I don't have "${to}" as a contact on AgentLink.\n\n` +
          `To connect with them, you can:\n` +
          `1. Use the agentlink_invite tool to generate an invite code to share with them\n` +
          `2. Ask your human for their agent ID and add them as a contact`
        );
      }

      // Reset exchange counter if conversation was paused — human is actively continuing
      if (a2aManager?.isPaused(agentId)) {
        a2aManager.reset(agentId);
      }

      // Build and send envelope — origin: "tool" tells receiver this is human-initiated
      const envelope = createEnvelope("message", config.agentId, config.humanName, agentId, messageText, "tool", context);
      const topic = TOPICS.inbox(agentId, config.agentId);

      try {
        await mqttClient.publish(topic, JSON.stringify(envelope));
        const contact = contacts.findByAgentId(agentId);
        const label = contact ? `${contact.name}'s agent (${agentId})` : agentId;
        logger.info(`[AgentLink] Message sent to ${label}`);

        // Stash origin context (which session the human is on) for relay
        if (a2aManager) {
          a2aManager.setOriginContext(agentId, {
            sessionKey: "main",
            channel: "webchat",
            agentId: config.agentId,
            timestamp: Date.now(),
          });
        }
        onA2AStarted?.(agentId);

        return text(
          `Message sent to ${label}. The conversation will run autonomously — I'll relay the results when it's done.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLink] Failed to send message: ${msg}`);
        return text(`Failed to send message: ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_whois
// ---------------------------------------------------------------------------

export function createWhoisTool(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
): ToolDefinition {
  return {
    name: "agentlink_whois",
    label: "AgentLink: Look Up Agent",
    description:
      "Look up an agent's profile and online status by their agent ID or contact name. Returns their human name and whether they're currently online.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: {
          type: "string",
          description: "Contact name or agent ID to look up",
        },
      },
    },
    async execute(_id, params) {
      const agent = params.agent as string;
      if (!agent) return text("Error: 'agent' parameter is required.");

      // Resolve to agent ID
      const agentId = contacts.resolve(agent) ?? agent;

      // Read the status topic (subscribe, wait for retained message, unsubscribe)
      const statusTopic = TOPICS.status(agentId);

      try {
        const status = await readRetainedMessage<AgentStatus>(mqttClient, statusTopic, 5000);
        if (!status) {
          return text(
            `No status found for agent "${agentId}". They may not be on AgentLink, or they haven't come online yet.`
          );
        }

        const localContact = contacts.findByAgentId(agentId);
        const lines = [
          `Agent: ${status.agent_id}`,
          `Human: ${status.human_name}`,
          `Status: ${status.online ? "Online" : "Offline"}`,
          `Last seen: ${status.last_seen}`,
        ];
        if (localContact) {
          lines.push(`Your contact name: ${localContact.name}`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(`Failed to look up agent: ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_invite
// ---------------------------------------------------------------------------

export function createInviteTool(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  logger: Logger,
): ToolDefinition {
  return {
    name: "agentlink_invite",
    label: "AgentLink: Generate Invite",
    description:
      "Generate a 6-character invite code that someone can use to connect their agent to yours. Share the code with them so they can add you as a contact.",
    parameters: {
      type: "object",
      required: [],
      properties: {
        name: {
          type: "string",
          description: "Optional: the name of the person you're inviting (for your reference)",
        },
      },
    },
    async execute(_id, params) {
      const inviteName = params.name as string | undefined;

      const invite = createInvitePayload(config.agentId, config.humanName);
      const topic = TOPICS.invite(invite.code);

      try {
        await mqttClient.publish(topic, JSON.stringify(invite), { retain: true, qos: 1 });
        logger.info(`[AgentLink] Invite code generated: ${invite.code}`);

        const shareMessage = [
          `Hey! I set up my AI agent to coordinate with yours — schedules, dinner plans, the works.`,
          `Get started in 30 seconds: agent.lk/j/${invite.code}`,
          ``,
          `(Developer? npx @agentlinkdev/agentlink setup --join ${invite.code})`,
        ].join("\n");

        const lines = [
          `Invite code generated: **${invite.code}**`,
          `Expires: ${new Date(invite.expires).toLocaleDateString()}`,
          ``,
          `Share this with ${inviteName || "them"}:`,
          ``,
          shareMessage,
        ];

        return text(lines.join("\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLink] Failed to publish invite: ${msg}`);
        return text(`Failed to generate invite: ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_join
// ---------------------------------------------------------------------------

export function createJoinTool(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
): ToolDefinition {
  return {
    name: "agentlink_join",
    label: "AgentLink: Join via Invite Code",
    description:
      "Join AgentLink using a 6-character invite code shared by another person. This adds them as a contact and notifies their agent so you become mutual contacts.",
    parameters: {
      type: "object",
      required: ["code"],
      properties: {
        code: {
          type: "string",
          description: "The 6-character invite code (e.g., E8RRN8)",
        },
      },
    },
    async execute(_id, params) {
      const code = (params.code as string)?.trim().toUpperCase();
      if (!code) return text("Error: 'code' parameter is required.");

      try {
        const result = await resolveInviteCode(code, config, mqttClient, contacts, logger);
        return text(result.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLink] Failed to join via invite: ${msg}`);
        return text(`Failed to join: ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_logs
// ---------------------------------------------------------------------------

export function createLogsTool(
  config: AgentLinkConfig,
  contacts: ContactsStore,
  logWriter: A2ALogWriter,
): ToolDefinition {
  return {
    name: "agentlink_logs",
    label: "Read A2A conversation logs",
    description:
      "Read your agent-to-agent conversation logs with other contacts. " +
      "Use this when your human asks about what you discussed with another agent. " +
      "Provide the contact name or agent ID to read the conversation history.",
    parameters: {
      type: "object",
      properties: {
        contact: {
          type: "string",
          description: "Contact name or agent ID (e.g., 'rupul' or 'agent-arya')",
        },
      },
      required: ["contact"],
    },
    async execute(_id, params) {
      const contactInput = (params.contact as string)?.trim();
      if (!contactInput) return text("Error: 'contact' parameter is required.");

      // Resolve contact name/ID → agent ID
      const agentId = contacts.resolve(contactInput);
      if (!agentId) {
        return text(`Contact "${contactInput}" not found. Use agentlink_whois to list your contacts.`);
      }

      // Read log file
      const log = logWriter.readLog(agentId);
      if (!log) {
        return text(`No conversation history found with ${contactInput}.`);
      }

      return text(
        `# Conversation history with ${contactInput}\n\n${log}\n\n` +
        `This is your full A2A conversation log. Summarize it for your human if they ask what you discussed.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: read a retained message from a topic
// ---------------------------------------------------------------------------

function readRetainedMessage<T>(
  mqttClient: MqttClient,
  topic: string,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    mqttClient.onMessage((msgTopic, payload) => {
      if (msgTopic === topic && !resolved) {
        resolved = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(payload.toString("utf-8")) as T);
        } catch {
          resolve(null);
        }
      }
    });

    mqttClient.subscribe(topic).catch(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}
