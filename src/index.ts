import fs from "node:fs";
import nodePath from "node:path";
import type { AgentLinkConfig } from "./types.js";
import { resolveConfig, parseIdentityMd, createEnvelope, TOPICS } from "./types.js";
import { createContacts } from "./contacts.js";
import { createState } from "./state.js";
import { createMqttService } from "./mqtt-service.js";
import { createInviteManager } from "./invite.js";
import { createJobManager } from "./jobs.js";
import { createTools } from "./tools.js";
import { createChannelPlugin, createChannelInbound } from "./channel.js";
import type { ChannelApi, ChannelInbound } from "./channel.js";
import { shouldProcess } from "./routing.js";
import type { Logger } from "./mqtt-client.js";

// ---------------------------------------------------------------------------
// Minimal OC Plugin API type (matches what we use from OpenClaw's PluginApi)
// ---------------------------------------------------------------------------

interface PluginApi {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: Logger;
  registerService(service: { id: string; start: () => Promise<void>; stop: () => Promise<void> }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (_id: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: unknown;
    }>;
  }): void;
  registerChannel?(registration: { plugin: unknown }): void;
  registerCli?(registrar: (ctx: { program: unknown }) => void, opts?: { commands?: string[] }): void;
  on?(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
  runtime?: {
    executeTool(params: {
      toolName: string;
      params: Record<string, unknown>;
      ctx?: unknown;
    }): Promise<unknown>;
    channel?: ChannelApi;
  };
}

// ---------------------------------------------------------------------------
// Plugin definition object (preferred OC pattern)
// ---------------------------------------------------------------------------

export default {
  id: "agentlink",
  name: "AgentLink",
  description: "Agent-to-agent coordination over MQTT",
  register,
};

function register(api: PluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});
  const contacts = createContacts(config.dataDir);
  const state = createState(config.dataDir);
  const logger = api.logger;

  // Read display name from IDENTITY.md in the OC workspace
  if (!config.agent.displayName) {
    try {
      const ocConfig = api.config as Record<string, unknown>;
      // OC stores workspace at agents.defaults.workspace
      const agents = ocConfig.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const workspacePath = defaults?.workspace as string | undefined;
      if (workspacePath) {
        const identityPath = nodePath.join(workspacePath, "IDENTITY.md");
        if (fs.existsSync(identityPath)) {
          const content = fs.readFileSync(identityPath, "utf-8");
          const parsed = parseIdentityMd(content);
          if (parsed.name) {
            config.agent.displayName = parsed.name;
            logger.info(`[AgentLink] Display name from IDENTITY.md: ${parsed.name}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[AgentLink] Failed to read IDENTITY.md: ${msg}`);
    }
  }

  // Registry for remote agents' display names (from MQTT status messages)
  const remoteDisplayNames = new Map<string, string>();

  /** Resolve display name for a remote agent: status display_name → contact name → agent_id */
  function resolveDisplayName(agentId: string): string {
    const fromStatus = remoteDisplayNames.get(agentId);
    if (fromStatus) return fromStatus;
    const fromContacts = contacts.getNameByAgentId(agentId);
    if (fromContacts) return fromContacts.charAt(0).toUpperCase() + fromContacts.slice(1);
    return agentId;
  }

  function log(msg: string) {
    if (config.outputMode === "debug") {
      logger.info(`[AgentLink] ${msg}`);
    }
  }

  const mqttService = createMqttService(config, state, contacts, logger);

  const invites = createInviteManager(config, mqttService);

  // Channel inbound: wakes agent when MQTT events arrive (autonomous coordination)
  const channelInbound: ChannelInbound | null = api.runtime?.channel
    ? createChannelInbound(config, state, contacts, mqttService, api.runtime.channel, api.config, logger)
    : null;

  if (!channelInbound) {
    logger.warn("[AgentLink] Channel inbound API not available. Autonomous coordination disabled.");
  }

  // LLM dispatch: routes job questions to the agent's OC session as plain natural
  // language. The OC session has all the tools it needs (exec, gog, skills, etc.)
  // and will handle the question exactly like a user message.
  const llmDispatch = channelInbound
    ? async (groupId: string, question: string, senderAgentId: string): Promise<string> => {
        return channelInbound.dispatchAndCapture(groupId, "", senderAgentId, question);
      }
    : undefined;

  const jobs = createJobManager(config, state, mqttService, logger, llmDispatch);

  // Wire inbound message handling
  mqttService.onGroupMessage((msg) => {
    // Check if this agent should process the message
    if (!shouldProcess(msg, config.agent.id, config.agent.capabilities)) {
      return;
    }

    if (msg.type === "job_request") {
      jobs.handleJobRequest(msg);
      return;
    }

    if (msg.type === "job_response" && msg.correlation_id && state.hasPendingJob(msg.correlation_id)) {
      jobs.handleJobResponse(msg);
      // Wake agent with the response
      if (channelInbound) {
        const displayName = resolveDisplayName(msg.from);
        const result = msg.payload.result ?? msg.payload.text ?? "(no text)";
        channelInbound.dispatch(msg.group_id,
          `**${displayName}:** ${result}`,
          msg.from);
      }
      return;
    }

    // Chat from participant — wake agent if we're the driver
    if (msg.type === "chat" && channelInbound) {
      const group = state.getGroup(msg.group_id);
      if (group && group.driver === config.agent.id) {
        const displayName = resolveDisplayName(msg.from);
        channelInbound.dispatch(msg.group_id,
          `**${displayName}:** ${msg.payload.text ?? "(no text)"}`,
          msg.from);
        return;
      }
    }

    // General coordination message — log it
    const senderName = contacts.getNameByAgentId(msg.from) ?? msg.from;
    log(`Message from ${senderName}: ${msg.payload.text ?? "(no text)"}`);
  });

  mqttService.onInboxMessage((_topic, raw) => {
    const msg = raw as Record<string, unknown>;
    if (msg.type === "invite") {
      const fromId = msg.from as string;
      const goal = msg.goal as string;
      const displayName = resolveDisplayName(fromId);
      log(`Invite received from ${displayName}: "${goal}"`);

      if (channelInbound && contacts.resolve(fromId)) {
        const groupId = msg.group_id as string;
        const inviteCode = msg.invite_code as string | undefined;
        if (!inviteCode) {
          logger.warn(`[AgentLink] Invite from ${displayName} missing invite_code — cannot join`);
          return;
        }
        const agentBody = [
          `[AgentLink] ${displayName} invited you to coordinate. Goal: "${goal}"`,
          `This is a known contact. Accept by calling agentlink_join_group with invite_code: "${inviteCode}"`,
          `Do NOT output any text — just call the tool.`,
        ].join("\n");
        channelInbound.dispatch(groupId, "", fromId, agentBody);
      }
    }
  });

  // Status updates: track participant capabilities and display names
  mqttService.onStatusUpdate((raw) => {
    const status = raw as Record<string, unknown>;
    if (!status || typeof status !== "object") return;
    const agentId = status.agent_id as string;
    if (!agentId || agentId === config.agent.id) return;

    // Store display name from remote agent's status message
    const displayName = status.display_name as string | undefined;
    if (displayName) {
      remoteDisplayNames.set(agentId, displayName);
    }

    const capabilities = status.capabilities as Array<{ name: string; description: string }> | undefined;
    if (!capabilities || !Array.isArray(capabilities)) return;

    // Store capabilities for all active groups (status may arrive before join)
    for (const groupId of state.getActiveGroups()) {
      state.updateParticipantCapabilities(groupId, agentId, capabilities);
    }
  });

  mqttService.onSystemEvent((raw) => {
    const msg = raw as Record<string, unknown>;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    const envelope = msg as Record<string, unknown>;
    logger.info(`[AgentLink] System event: type=${envelope.type}, from=${envelope.from}`);

    if (envelope.type === "join") {
      const from = envelope.from as string;
      if (from === config.agent.id) return; // ignore own join
      const groupId = envelope.group_id as string;
      const group = state.getGroup(groupId);
      if (!group) return;

      // Deduplicate: only process first join
      const isNew = !group.participants.includes(from);
      if (isNew) {
        group.participants.push(from);
        state.updateGroup(groupId, { participants: group.participants });
      }

      const displayName = resolveDisplayName(from);
      logger.info(`[AgentLink] ${displayName} joined group ${groupId.slice(0, 8)} (isNew=${isNew}, hasInbound=${!!channelInbound}, isDriver=${group.driver === config.agent.id})`);

      // Wake agent with join notification (only on first join, prevent duplicates)
      if (isNew && channelInbound && group.driver === config.agent.id) {
        const caps = state.getParticipantCapabilities(groupId, from);
        const capList = caps && caps.length > 0
          ? caps.map(c => `- **${c.name}**: ${c.description}`).join("\n")
          : "(capabilities loading...)";

        // Empty body = invisible "You" bubble. Agent gets full context via agentBody.
        const agentContext = [
          `${displayName} joined. Goal: "${group.goal}" | Done when: "${group.done_when}"`,
          ``,
          `What they can help with:`,
          capList,
          ``,
          `[System] Submit ALL needed jobs NOW using agentlink_submit_job (group_id: "${groupId}"). Do NOT output any text — only tool calls.`,
        ].join("\n");
        channelInbound.dispatch(groupId, "", from, agentContext);
      }
    }

    if (envelope.type === "leave") {
      const groupId = envelope.group_id as string;
      const from = envelope.from as string;
      const group = state.getGroup(groupId);

      if (group && from !== config.agent.id) {
        // Wake agent with completion notification before cleanup
        if (channelInbound && group.driver !== config.agent.id) {
          const displayName = resolveDisplayName(from);
          const summary = (envelope.payload as Record<string, unknown>)?.text as string ?? "";
          channelInbound.dispatch(groupId,
            `Coordination wrapped up by ${displayName}. ${summary}`,
            from);
        }
        mqttService.unsubscribeGroup(groupId);
        state.removeGroup(groupId);
        log(`Group ${groupId} closed by driver`);
      }
    }
  });

  // Background MQTT connection
  api.registerService({
    id: "agentlink-mqtt",
    start: async () => {
      await mqttService.start();

      // Process pending joins from CLI --join flag
      const pendingJoins = state.getPendingJoins();
      for (const code of pendingJoins) {
        try {
          log(`Processing pending join: ${code}`);
          const invite = await invites.resolveInviteCode(code);
          if (invite) {
            const groupId = invite.group_id;
            await mqttService.subscribeGroup(groupId);
            state.addGroup({
              group_id: groupId,
              driver: invite.from,
              goal: invite.goal,
              done_when: "",
              intent_id: "",
              participants: [invite.from],
              status: "active",
              idle_turns: 0,
              created_at: new Date().toISOString(),
            });
            if (!contacts.resolve(invite.from)) {
              contacts.add(invite.from, invite.from);
            }

            // Publish status + join event so the driver knows we joined
            const status = {
              agent_id: config.agent.id,
              owner: config.agent.description?.split("'s")[0] ?? config.agent.id,
              display_name: config.agent.displayName,
              status: "online",
              capabilities: config.agent.capabilities.map((c) => ({
                name: c.name,
                description: c.description ?? c.name,
                input_hint: c.input_hint ?? "",
              })),
              description: config.agent.description,
              ts: new Date().toISOString(),
            };
            await mqttService.publish(
              TOPICS.groupStatus(groupId, config.agent.id),
              JSON.stringify(status),
              { retain: true },
            );
            const joinMsg = createEnvelope(config.agent.id, {
              group_id: groupId,
              to: "group",
              type: "join",
              payload: { text: `${config.agent.id} joined the group` },
            });
            await mqttService.publishEnvelope(TOPICS.groupSystem(groupId), joinMsg);

            state.removePendingJoin(code);
            log(`Auto-joined group from setup: ${code}`);
          } else {
            log(`Pending join ${code}: invite not found (will retry next restart)`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Failed to auto-join ${code}: ${msg}`);
        }
      }
    },
    stop: () => {
      channelInbound?.shutdown();
      return mqttService.stop();
    },
  });

  // Register the 5 agent tools
  const tools = createTools(config, state, contacts, mqttService, invites, jobs, logger, channelInbound, resolveDisplayName);
  for (const tool of tools) {
    api.registerTool(tool);
  }

  // Optional channel registration
  if (api.registerChannel) {
    const channelPlugin = createChannelPlugin(config, state, contacts, mqttService, logger);
    api.registerChannel({ plugin: channelPlugin });
  }

  // System prompt injection — shapes agent persona during coordination
  if (api.on) {
    api.on("before_prompt_build", () => {
      const activeGroups = state.getActiveGroups();
      if (activeGroups.length === 0) return {};

      const driverGroups = activeGroups
        .map((id) => state.getGroup(id))
        .filter((g) => g?.driver === config.agent.id);

      if (driverGroups.length === 0) return {};

      let prompt = "\n\n## AgentLink — Assistant-to-Assistant Coordination\n\n";
      prompt += "You are your human's personal assistant. You are in a GROUP CHAT with other people's assistants, ";
      prompt += "coordinating on your human's behalf. Your human delegated this to you and is watching.\n\n";

      prompt += "### Rules\n";
      prompt += "1. When a participant joins, submit jobs to gather what you need (availability, preferences, etc.).\n";
      prompt += "2. Wait for ALL participants to respond before making your decision.\n";
      prompt += "3. When you have heard from everyone (or a participant is confirmed offline), call `agentlink_complete` with your recommendation.\n";
      prompt += "4. Do NOT complete until you have responses from all joined participants.\n\n";

      prompt += "### Decision authority\n";
      prompt += "- You have FULL authority to make the final decision. Pick specific times, places, and options.\n";
      prompt += "- If preferences conflict, pick the best compromise. Don't ask — decide.\n\n";

      prompt += "### Voice\n";
      prompt += "Speak in first person as your human's assistant. Be concise.\n";
      prompt += "NEVER narrate process or say \"waiting for\" / \"let me check\".\n\n";

      for (const group of driverGroups) {
        if (!group) continue;
        const participantNames = group.participants
          .filter(p => p !== config.agent.id)
          .map(p => resolveDisplayName(p))
          .join(", ");

        // Build tracking context: who's joined, who's responded
        const pendingJobs = Object.values(state.getAllPendingJobs?.() ?? {})
          .filter((j: any) => j.group_id === group.group_id && j.status === "requested");
        const completedJobs = Object.values(state.getAllPendingJobs?.() ?? {})
          .filter((j: any) => j.group_id === group.group_id && j.status !== "requested");

        prompt += `### Coordinating with ${participantNames || "other assistants"}\n`;
        prompt += `**Goal:** ${group.goal}\n`;
        prompt += `**Done when:** ${group.done_when}\n`;
        prompt += `**Participants joined:** ${group.participants.length} (${group.participants.map(p => resolveDisplayName(p)).join(", ")})\n`;
        if (pendingJobs.length > 0) {
          prompt += `**⏳ Waiting for ${pendingJobs.length} job response(s)** — do NOT complete yet.\n`;
        }
        if (completedJobs.length > 0 && pendingJobs.length === 0) {
          prompt += `**✓ All jobs answered** — ready to call agentlink_complete.\n`;
        }
        prompt += "\n";
      }

      return { appendSystemContext: prompt };
    });
  }

  // CLI commands
  if (api.registerCli) {
    api.registerCli(
      ({ program }: { program: any }) => {
        const cmd = program.command("agentlink").description("AgentLink agent coordination");
        cmd
          .command("status")
          .description("Show AgentLink connection and group status")
          .action(() => {
            console.log(`Agent ID: ${config.agent.id}`);
            if (config.agent.displayName) {
              console.log(`Display Name: ${config.agent.displayName}`);
            }
            console.log(`Broker: ${config.brokerUrl}`);
            console.log(`Connected: ${mqttService.getClient().isConnected()}`);
            console.log(`Active groups: ${state.getActiveGroups().length}`);
            console.log(
              `Capabilities: ${config.agent.capabilities.map((c) => c.name).join(", ") || "none"}`,
            );
          });
        cmd
          .command("contacts")
          .description("List known contacts")
          .action(() => {
            const all = contacts.getAll();
            const entries = Object.entries(all);
            if (entries.length === 0) {
              console.log("No contacts.");
              return;
            }
            for (const [name, entry] of entries) {
              console.log(`${name} -> ${entry.agent_id} (added ${entry.added})`);
            }
          });
      },
      { commands: ["agentlink"] },
    );
  }
}
