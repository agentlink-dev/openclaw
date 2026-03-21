import type { AgentLinkConfig, AgentStatus, MessageEnvelope, OpenClawPluginToolFactory, OpenClawPluginToolContext, ToolDefinition } from "./types.js";
import { createEnvelope, createInvitePayload, TOPICS } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";
import type { A2ASessionManager } from "./a2a-session.js";
import type { A2ALogWriter } from "./a2a-log.js";
import type { InvitationsStore } from "./invitations.js";
import type { ChannelTracker } from "./channel-tracker.js";
import type { ChannelApi } from "./channel.js";
import { searchByIdentifier } from "./discovery.js";
import { AskManager } from "./ask-manager.js";
import type { AskRecord } from "./ask-manager.js";
import {
  readSharing,
  setProfile,
  setPermission,
  setContactOverride,
  removeContactOverride,
  formatScopeList,
  ALL_SCOPES,
  SCOPE_LABELS,
  PROFILE_PERMISSIONS,
} from "./sharing.js";
import type { SharingProfile, PermissionAction } from "./sharing.js";
import mqtt from "mqtt";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

// ---------------------------------------------------------------------------
// Tool: agentlink_message
// ---------------------------------------------------------------------------

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/**
 * Extract delivery target from OpenClaw sessionKey.
 * Format: agent:main:{channel}:{chatType}:{identifier}
 * Returns: channel-appropriate target (e.g., "user:U123", "+31617427785", "channel:C123")
 */
function extractDeliveryTarget(sessionKey: string, channel: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 5) return "main"; // Fallback for malformed keys

  const chatType = parts[3]; // "direct", "channel", "group"
  const identifier = parts.slice(4).join(":"); // Handle identifiers with colons

  // Format based on channel and chat type
  if (channel === "slack") {
    if (chatType === "direct") return `user:${identifier.toUpperCase()}`;
    if (chatType === "channel") return `channel:${identifier.toUpperCase()}`;
    return identifier;
  } else if (channel === "discord") {
    if (chatType === "direct") return `user:${identifier}`;
    if (chatType === "channel") return `channel:${identifier}`;
    return identifier;
  } else if (channel === "whatsapp" || channel === "telegram" || channel === "signal") {
    // Phone numbers pass through as-is
    return identifier;
  }

  // Default: use identifier as-is
  return identifier;
}

export function createMessageTool(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
  a2aManager?: A2ASessionManager,
  onA2AStarted?: (agentId: string) => void,
): OpenClawPluginToolFactory {
  // Return factory function that captures session context
  return (ctx: OpenClawPluginToolContext) => {
    // Capture session context from factory parameter
    const sessionKey = ctx.sessionKey ?? "main";
    const messageChannel = ctx.messageChannel ?? "webchat";
    const accountId = ctx.agentAccountId ?? "default";
    const deliveryTarget = extractDeliveryTarget(sessionKey, messageChannel);

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
          // Format: "name" (AgentName for HumanName) or "name" (HumanName's agent)
          let suffix = "";
          if (entry.agent_name && entry.human_name) {
            suffix = ` (${entry.agent_name} for ${entry.human_name})`;
          } else if (entry.agent_name) {
            suffix = ` (agent: ${entry.agent_name})`;
          } else if (entry.human_name) {
            suffix = ` (${entry.human_name}'s agent)`;
          }
          return `  - "${name}"${suffix}`;
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
        const envelope = createEnvelope("message", config.agentId, config.humanName, agentId, messageText, "tool", context, undefined, config.agentName);
        const topic = TOPICS.inbox(agentId, config.agentId);

        try {
          await mqttClient.publish(topic, JSON.stringify(envelope));
          const contact = contacts.findByAgentId(agentId);
          const label = contact ? `${contact.name}'s agent (${agentId})` : agentId;
          logger.info(`[AgentLink] Message sent to ${label}`);

          // Stash origin context (captured from session) for relay
          if (a2aManager) {
            a2aManager.setOriginContext(agentId, {
              sessionKey,              // ✓ From factory context closure
              channel: messageChannel, // ✓ From factory context closure
              agentId: config.agentId,
              to: deliveryTarget,      // ✓ Extracted from sessionKey
              accountId,               // ✓ From factory context closure
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
        const lastSeen = status.timestamp ? new Date(status.timestamp).toLocaleString() : "Unknown";
        const lines = [
          `Agent: ${status.agent_id}`,
          `Human: ${status.human_name}`,
          `Status: ${status.online ? "Online" : "Offline"}`,
          `Last seen: ${lastSeen}`,
        ];
        if (localContact) {
          lines.push(`Your contact name: ${localContact.name}`);
          if (localContact.entry.capabilities && localContact.entry.capabilities.length > 0) {
            lines.push(`\nCapabilities (${localContact.entry.capabilities.length}):`);
            for (const cap of localContact.entry.capabilities) {
              lines.push(`  - ${cap}`);
            }
          }
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
// Tool: agentlink_connect
// ---------------------------------------------------------------------------

export function createConnectTool(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
  a2aManager?: A2ASessionManager,
  invitations?: InvitationsStore,
): OpenClawPluginToolFactory {
  return (ctx: OpenClawPluginToolContext) => {
    const sessionKey = ctx.sessionKey ?? "main";
    const messageChannel = ctx.messageChannel ?? "webchat";
    const accountId = ctx.agentAccountId ?? "default";
    const deliveryTarget = extractDeliveryTarget(sessionKey, messageChannel);

    return {
      name: "agentlink_connect",
      label: "AgentLink: Connect by Email",
      description:
        "Connect with another agent by email. Searches the public directory, checks if they're online, " +
        "and establishes a mutual connection. If the agent isn't found or is offline, generates an invite code to share instead.",
      parameters: {
        type: "object",
        required: ["email"],
        properties: {
          email: {
            type: "string",
            description: "Email address to connect with (e.g., 'alice@example.com')",
          },
          name: {
            type: "string",
            description: "Contact name to save as (optional, defaults to their agent name or email username)",
          },
        },
      },
      async execute(_id, params) {
        const email = params.email as string;
        const contactName = params.name as string | undefined;

        if (!email) {
          return text("Error: 'email' parameter is required.");
        }

        if (!email.includes("@")) {
          return text(`Error: Invalid email format: ${email}`);
        }

        logger.info(`[agentlink_connect] Searching for ${email}...`);

        try {
          // --- STEP 1: Discovery lookup ---
          const rawClient = await new Promise<mqtt.MqttClient>((resolve, reject) => {
            const client = mqtt.connect(config.brokerUrl, {
              username: config.brokerUsername,
              password: config.brokerPassword,
              clientId: `agentlink-connect-${config.agentId}-${Date.now()}`,
              clean: true,
              connectTimeout: 10000,
            });
            client.on("connect", () => resolve(client));
            client.on("error", (err) => reject(err));
            setTimeout(() => reject(new Error("MQTT connection timeout")), 10000);
          });

          let discoveryResult;
          try {
            discoveryResult = await searchByIdentifier(
              { identifier: email, timeoutMs: 5000 },
              config.agentId,
              rawClient
            );
          } finally {
            rawClient.end();
          }

          // --- NOT FOUND → fallback to invite ---
          if (!discoveryResult.found || !discoveryResult.agentId) {
            return generateFallbackInvite(config, mqttClient, logger, invitations, email);
          }

          const targetAgentId = discoveryResult.agentId;

          // Check if already connected
          const existing = contacts.findByAgentId(targetAgentId);
          if (existing) {
            return text(
              `Already connected to this agent!\n\n` +
              `Contact name: ${existing.name}\n` +
              `Agent ID: ${targetAgentId}\n` +
              `Email: ${email}`
            );
          }

          // --- STEP 2: Whois — check online/offline ---
          const statusTopic = TOPICS.status(targetAgentId);
          const agentStatus = await readRetainedMessage<AgentStatus>(mqttClient, statusTopic, 3000);

          const isOnline = agentStatus?.online === true;
          const displayName = agentStatus?.human_name || email;
          const agentName = agentStatus?.agent_name;
          const finalName = contactName || agentName?.toLowerCase() || email.split("@")[0].toLowerCase();

          // Check if name is already taken
          if (contacts.has(finalName)) {
            return text(
              `Error: Contact name "${finalName}" is already in use.\n\n` +
              `Please provide a different name using the 'name' parameter.`
            );
          }

          // --- OFFLINE → fallback to invite ---
          if (!isOnline) {
            const lastSeen = agentStatus?.timestamp
              ? new Date(agentStatus.timestamp).toLocaleString()
              : "unknown";
            logger.info(`[agentlink_connect] ${email} is offline (last seen: ${lastSeen}), generating invite`);
            return generateFallbackInvite(config, mqttClient, logger, invitations, email, displayName, lastSeen);
          }

          // --- STEP 3: ONLINE → send contact_exchange + wait for ack ---
          logger.info(`[agentlink_connect] ${email} is online, sending connection request...`);

          const exchange = createEnvelope(
            "contact_exchange",
            config.agentId,
            config.humanName,
            targetAgentId,
            undefined,
            undefined,
            undefined,
            config.capabilities,
            config.agentName,
          );
          const outTopic = TOPICS.inbox(targetAgentId, config.agentId);
          await mqttClient.publish(outTopic, JSON.stringify(exchange));

          // Wait for ack (subscribe to our inbox for this specific sender, 5s timeout)
          const ack = await waitForContactAck(mqttClient, config.agentId, targetAgentId, 5000);

          if (ack) {
            // Synchronous success — add confirmed contact
            contacts.add(finalName, targetAgentId, displayName, ack.capabilities, agentName, agentStatus?.email, agentStatus?.phone, agentStatus?.location);
            logger.info(`[agentlink_connect] Connected with ${email} as "${finalName}" (confirmed)`);

            return text(
              `Connected with ${displayName}!\n\n` +
              `Contact name: ${finalName}\n` +
              (agentName ? `Agent name: ${agentName}\n` : "") +
              `Agent ID: ${targetAgentId}\n\n` +
              `You can now send messages to ${finalName}.`
            );
          }

          // Ack timeout — save as pending, stash origin context for async relay
          contacts.add(finalName, targetAgentId, displayName, undefined, agentName, agentStatus?.email, agentStatus?.phone, agentStatus?.location);
          logger.info(`[agentlink_connect] Ack timeout for ${email}, saved as pending`);

          if (a2aManager) {
            a2aManager.setOriginContext(targetAgentId, {
              sessionKey,
              channel: messageChannel,
              agentId: config.agentId,
              to: deliveryTarget,
              accountId,
              timestamp: Date.now(),
            });
          }

          return text(
            `Connection request sent to ${displayName}.\n` +
            `Contact saved as "${finalName}".\n` +
            `You'll be notified when their agent confirms.`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[agentlink_connect] Failed to connect: ${msg}`);
          return text(`Failed to connect: ${msg}`);
        }
      },
    };
  };
}

/** Wait for a contact_exchange ack from a specific agent. */
function waitForContactAck(
  mqttClient: MqttClient,
  myAgentId: string,
  fromAgentId: string,
  timeoutMs: number,
): Promise<MessageEnvelope | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const inboxTopic = TOPICS.inbox(myAgentId, fromAgentId);

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    mqttClient.onMessage((topic, payload) => {
      if (topic === inboxTopic && !resolved) {
        try {
          const env = JSON.parse(payload.toString("utf-8")) as MessageEnvelope;
          if (env.type === "contact_exchange" && env.ack && env.from === fromAgentId) {
            resolved = true;
            clearTimeout(timer);
            resolve(env);
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    });

    mqttClient.subscribe(inboxTopic).catch(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/** Generate a fallback invite when discovery fails or agent is offline. */
function generateFallbackInvite(
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  logger: Logger,
  invitations: InvitationsStore | undefined,
  email: string,
  displayName?: string,
  lastSeen?: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return (async () => {
    const invite = createInvitePayload(config.agentId, config.humanName);
    const inviteTopic = TOPICS.invite(invite.code);
    await mqttClient.publish(inviteTopic, JSON.stringify(invite), { retain: true, qos: 1 });

    if (invitations) {
      invitations.addSent(invite.code, email, invite.expires);
    }

    const landingPageBase = "https://website-agentlink.vercel.app";
    const inviteUrl = `${landingPageBase}/join/${invite.code}.txt`;

    logger.info(`[agentlink_connect] Generated fallback invite ${invite.code} for ${email}`);

    const senderName = config.humanName || "sender";

    // Installation message for the recipient to paste into their OpenClaw
    const installMessage = [
      `Hi OpenClaw, I would like to install AgentLink. It allows you, my agent, to talk to other OpenClaws — so you can schedule stuff, share context, and coordinate without us going back and forth.`,
      ``,
      `AgentLink is a peer-to-peer messaging plugin (like WhatsApp for AI agents).`,
      `No credentials shared. Messages are direct over MQTT.`,
      ``,
      `Get started: ${inviteUrl}`,
      `(Takes 30 seconds)`,
    ].join("\n");

    let header: string;
    if (lastSeen && displayName) {
      header = `${displayName}'s agent is offline (last seen: ${lastSeen}).\nShare this invite so they can connect when back online:`;
    } else {
      header = `${email} isn't on AgentLink yet.\nShare this invite with them:`;
    }

    const lines = [
      header,
      ``,
      `───────────────────────────────────────────`,
      ``,
      `**Instructions for ${senderName}:** Send the whole message below to ${displayName || email}.`,
      ``,
      `───────────────────────────────────────────`,
      ``,
      `**Instructions for ${displayName || email}:** Paste the message below in your OpenClaw.`,
      ``,
      `───────────────────────────────────────────`,
      ``,
      installMessage,
      ``,
      `───────────────────────────────────────────`,
      ``,
      `**Invite code: ${invite.code}** (expires ${new Date(invite.expires).toLocaleDateString()})`,
    ];

    return text(lines.join("\n"));
  })();
}

// ---------------------------------------------------------------------------
// Tool: agentlink_contacts
// ---------------------------------------------------------------------------

export function createContactsTool(
  contacts: ContactsStore,
): ToolDefinition {
  return {
    name: "agentlink_contacts",
    label: "AgentLink: List Contacts",
    description:
      "List your AgentLink contacts. Shows who you're connected to.",
    parameters: {
      type: "object",
      required: [],
      properties: {},
    },
    async execute(_id, _params) {
      const all = contacts.getAll();
      const entries = Object.entries(all);

      if (entries.length === 0) {
        return text("No contacts yet. Use agentlink_connect to add someone.");
      }

      const lines = [`Contacts (${entries.length}):\n`];
      for (const [name, entry] of entries) {
        lines.push(`- ${name}`);
        if (entry.agent_name) lines.push(`    Agent name: ${entry.agent_name}`);
        if (entry.human_name) lines.push(`    Human name: ${entry.human_name}`);
        lines.push(`    Agent ID: ${entry.agent_id}`);
        if (entry.email) lines.push(`    Email: ${entry.email}`);
        lines.push(`    Added: ${entry.added}`);
      }

      return text(lines.join("\n"));
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
// Tool: agentlink_debug
// ---------------------------------------------------------------------------

export function createDebugTool(
  config: AgentLinkConfig,
  logger: Logger,
): ToolDefinition {
  return {
    name: "agentlink_debug",
    label: "AgentLink: Export Debug Logs",
    description:
      "Export diagnostic information about AgentLink for troubleshooting. " +
      "Tells the human how to generate a debug export file they can share for support. " +
      "Use this when the human reports AgentLink isn't working correctly.",
    parameters: {
      type: "object",
      required: [],
      properties: {},
    },
    async execute(_id, _params) {
      return text(
        `I'll help you generate diagnostic logs for AgentLink troubleshooting.\n\n` +
        `Please run this command in your terminal:\n\n` +
        `\`\`\`\n` +
        `agentlink debug\n` +
        `\`\`\`\n\n` +
        `This will create a file called \`agentlink-debug-YYYY-MM-DD-HH-MM-SS.tar.gz\` in your home directory.\n\n` +
        `The export includes:\n` +
        `- System information (OS, Node.js version, OpenClaw version)\n` +
        `- AgentLink configuration (plugin settings)\n` +
        `- Recent gateway logs (last 500 lines)\n` +
        `- AgentLink-specific log entries\n` +
        `- Conversation history\n` +
        `- MQTT connectivity test\n\n` +
        `**Privacy:** No API keys or credentials are included. Safe to share for support.\n\n` +
        `Once generated, you can:\n` +
        `1. Email the file to support\n` +
        `2. Share it via your preferred file transfer method\n` +
        `3. Upload to a GitHub issue\n\n` +
        `Let me know if you need help with anything else!`
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_update_policy
// ---------------------------------------------------------------------------

export function createUpdatePolicyTool(
  config: AgentLinkConfig,
  contacts: ContactsStore,
  logger: Logger,
): ToolDefinition {
  const scopeList = ALL_SCOPES.map((s) => `  - ${s}: ${SCOPE_LABELS[s]}`).join("\n");
  return {
    name: "agentlink_update_policy",
    label: "AgentLink: Update Sharing Policy",
    description:
      "Update your human's PII sharing policy. Use this when your human asks to change " +
      "what information is shared, blocked, or requires asking.\n\n" +
      "Actions:\n" +
      "- set_profile: Switch to a preset profile (open/balanced/private)\n" +
      "- set_permission: Change a base permission for a scope\n" +
      "- set_contact_override: Set a per-contact exception\n" +
      "- remove_contact_override: Remove a per-contact exception\n\n" +
      `Available scopes:\n${scopeList}\n\n` +
      "Permission values: allow, ask, block",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["set_profile", "set_permission", "set_contact_override", "remove_contact_override"],
          description: "The policy action to perform",
        },
        profile: {
          type: "string",
          enum: ["open", "balanced", "private"],
          description: "Profile name (for set_profile)",
        },
        scope: {
          type: "string",
          description: "The sharing scope (e.g. 'financial', 'location.precise')",
        },
        permission: {
          type: "string",
          enum: ["allow", "ask", "block"],
          description: "Permission value (for set_permission, set_contact_override)",
        },
        contact: {
          type: "string",
          description: "Contact name or agent ID (for contact override actions)",
        },
      },
    },
    async execute(_id, params) {
      const action = params.action as string;
      const dataDir = config.dataDir;

      if (action === "set_profile") {
        const profile = params.profile as SharingProfile;
        if (!profile || !PROFILE_PERMISSIONS[profile]) {
          return text("Error: 'profile' must be 'open', 'balanced', or 'private'.");
        }
        setProfile(dataDir, profile);
        const sharing = readSharing(dataDir);
        const summary = ALL_SCOPES.map((s) => `  ${s}: ${sharing.permissions[s] ?? "block"}`).join("\n");
        logger.info(`[AgentLink] Sharing profile set to: ${profile}`);
        return text(`Sharing profile updated to **${profile}**.\n\nCurrent permissions:\n${summary}`);
      }

      if (action === "set_permission") {
        const scope = params.scope as string;
        const permission = params.permission as PermissionAction;
        if (!scope) return text("Error: 'scope' is required.");
        if (!permission) return text("Error: 'permission' is required (allow/ask/block).");
        setPermission(dataDir, scope, permission);
        logger.info(`[AgentLink] Permission updated: ${scope} = ${permission}`);
        return text(`Updated: **${SCOPE_LABELS[scope] || scope}** is now set to **${permission}**.`);
      }

      if (action === "set_contact_override") {
        const scope = params.scope as string;
        const permission = params.permission as PermissionAction;
        const contactInput = params.contact as string;
        if (!scope) return text("Error: 'scope' is required.");
        if (!permission) return text("Error: 'permission' is required (allow/ask/block).");
        if (!contactInput) return text("Error: 'contact' is required.");

        const agentId = contacts.resolve(contactInput);
        if (!agentId) return text(`Contact "${contactInput}" not found.`);
        const contact = contacts.findByAgentId(agentId);
        const name = contact?.name ?? contactInput;
        const humanName = contact?.entry.human_name ?? contactInput;

        setContactOverride(dataDir, agentId, name, humanName, scope, permission);
        logger.info(`[AgentLink] Contact override: ${name} ${scope} = ${permission}`);
        return text(`Updated: **${SCOPE_LABELS[scope] || scope}** for **${humanName}** is now **${permission}**.`);
      }

      if (action === "remove_contact_override") {
        const scope = params.scope as string;
        const contactInput = params.contact as string;
        if (!scope) return text("Error: 'scope' is required.");
        if (!contactInput) return text("Error: 'contact' is required.");

        const agentId = contacts.resolve(contactInput);
        if (!agentId) return text(`Contact "${contactInput}" not found.`);
        const contact = contacts.findByAgentId(agentId);
        const humanName = contact?.entry.human_name ?? contactInput;

        removeContactOverride(dataDir, agentId, scope);
        logger.info(`[AgentLink] Removed contact override: ${contactInput} ${scope}`);
        return text(`Removed override for **${SCOPE_LABELS[scope] || scope}** on **${humanName}**. Base permission now applies.`);
      }

      return text(`Unknown action: ${action}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_ask_human
// ---------------------------------------------------------------------------

export interface AskHumanContext {
  askManager: AskManager;
  config: AgentLinkConfig;
  channelTracker: ChannelTracker;
  getChannelApi: () => ChannelApi;
  ocConfig: Record<string, unknown>;
  logger: Logger;
  getRuntime: () => any;
}

export function createAskHumanTool(ctx: AskHumanContext): ToolDefinition {
  return {
    name: "agentlink_ask_human",
    label: "AgentLink: Ask Human for Permission",
    description:
      "Ask your human for permission to share information with another agent. " +
      "Sends a notification to your human and waits for their decision (up to 2 minutes). " +
      "Use this when the sharing policy says ASK for a particular scope.",
    parameters: {
      type: "object",
      required: ["scope", "contactAgentId", "contactName", "description"],
      properties: {
        scope: {
          type: "string",
          description: "The sharing scope being requested (e.g. 'location.precise')",
        },
        contactAgentId: {
          type: "string",
          description: "The agent ID of the requester",
        },
        contactName: {
          type: "string",
          description: "The human name of the requester",
        },
        description: {
          type: "string",
          description: "Brief description of what's being asked (e.g. 'home address')",
        },
      },
    },
    async execute(_id, params) {
      const scope = params.scope as string;
      const contactAgentId = params.contactAgentId as string;
      const contactName = params.contactName as string;
      const description = params.description as string;

      if (!scope || !contactAgentId || !contactName || !description) {
        return text("Error: all parameters (scope, contactAgentId, contactName, description) are required.");
      }

      const askId = `ask_${Date.now()}_${scope.replace(/\./g, "-")}`;

      // Build notification message with askId for the human-facing session
      const message = [
        `[ask:${askId}] ${contactName}'s agent is asking for your ${description}.`,
        "",
        "1. Allow (this time)",
        `2. Always allow for ${contactName}`,
        "3. Always allow for everyone",
        "4. Deny",
        "",
        "Reply with the number (e.g. 1) to choose.",
      ].join("\n");

      // Register with AskManager (writes file + creates Promise)
      const record: AskRecord = {
        id: askId,
        scope,
        contactAgentId,
        contactName,
        description,
        createdAt: "",
        status: "pending",
      };
      const decisionPromise = ctx.askManager.register(record, 120_000);

      // Push notification to human (fire-and-forget)
      const { pushNotification } = await import("./channel.js");
      try {
        await pushNotification({
          message,
          config: ctx.config,
          channelTracker: ctx.channelTracker,
          channelApi: ctx.getChannelApi(),
          ocConfig: ctx.ocConfig,
          logger: ctx.logger,
          runtime: ctx.getRuntime(),
        });
      } catch (err) {
        ctx.logger.warn(`[AgentLink] Failed to push ask notification: ${err}`);
      }

      ctx.logger.info(`[AgentLink] Ask registered: ${askId} (${scope} for ${contactName})`);

      // Wait for decision (Promise resolves on human reply OR timeout)
      const decision = await decisionPromise;

      ctx.logger.info(`[AgentLink] Ask resolved: ${askId} → ${decision}`);

      if (decision === "timeout") {
        return text(
          `Your human didn't respond within 2 minutes. ` +
          `You cannot share ${description} right now. ` +
          `Politely tell the other agent that your human hasn't approved sharing this information.`
        );
      }

      if (decision === "deny") {
        return text(
          `Your human denied sharing ${description}. ` +
          `Politely tell the other agent that your human prefers not to share this information.`
        );
      }

      // Allow decisions — directive must be forceful because the A2A conversation
      // may have moved on while the tool was blocking.
      return text(
        `APPROVED. Your human said yes to sharing ${description} (decision: ${decision}).\n\n` +
        `CRITICAL INSTRUCTION: Your ONLY job now is to share the actual ${description} with ${contactName}'s agent. ` +
        `Ignore anything else the other agent said while you were waiting. ` +
        `Look up the ${description} from your knowledge, files, or tools and send it. ` +
        `Do NOT say "got it", "thanks", or acknowledge anything. Just share the ${description}.`
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: agentlink_resolve_ask
// ---------------------------------------------------------------------------

export interface ResolveAskContext {
  askManager: AskManager;
  config: AgentLinkConfig;
  contacts: ContactsStore;
  logger: Logger;
}

export function createResolveAskTool(ctx: ResolveAskContext): ToolDefinition {
  return {
    name: "agentlink_resolve_ask",
    label: "AgentLink: Resolve Permission Ask",
    description:
      "Resolve a pending sharing permission ask based on the human's decision. " +
      "Use this when the human responds to a sharing permission notification.",
    parameters: {
      type: "object",
      required: ["askId", "decision"],
      properties: {
        askId: {
          type: "string",
          description: "The pending ask ID (from the notification message)",
        },
        decision: {
          type: "string",
          enum: ["allow-once", "allow-always-contact", "allow-always-everyone", "deny"],
          description: "The human's decision",
        },
      },
    },
    async execute(_id, params) {
      const askId = params.askId as string;
      const decision = params.decision as "allow-once" | "allow-always-contact" | "allow-always-everyone" | "deny";

      if (!askId || !decision) {
        return text("Error: 'askId' and 'decision' are required.");
      }

      // Get the ask record for context
      const record = ctx.askManager.getPending(askId);
      if (!record) {
        return text(`No pending ask found with ID "${askId}".`);
      }

      // Update sharing.json for "always" decisions BEFORE resolving
      const dataDir = ctx.config.dataDir;
      if (decision === "allow-always-contact") {
        const contact = ctx.contacts.findByAgentId(record.contactAgentId);
        const name = contact?.name ?? record.contactName;
        const humanName = contact?.entry.human_name ?? record.contactName;
        setContactOverride(dataDir, record.contactAgentId, name, humanName, record.scope, "allow");
        ctx.logger.info(`[AgentLink] Sharing updated: ${record.scope} = allow for ${record.contactAgentId}`);
      } else if (decision === "allow-always-everyone") {
        setPermission(dataDir, record.scope, "allow");
        ctx.logger.info(`[AgentLink] Sharing updated: ${record.scope} = allow (base)`);
      }

      // Resolve the Promise (wakes up A2A session if still pending)
      const inTime = ctx.askManager.resolve(askId, decision);

      if (inTime) {
        return text(`Decision recorded: ${decision}. The other agent will be notified.`);
      } else {
        return text(
          `Decision recorded: ${decision}. The original conversation already ended, ` +
          `but this preference is saved for next time.`
        );
      }
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
