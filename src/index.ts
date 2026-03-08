import type { AgentLinkConfig } from "./types.js";
import { resolveConfig } from "./types.js";
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

  function log(msg: string) {
    if (config.outputMode === "debug") {
      logger.info(`[AgentLink] ${msg}`);
    }
  }

  const mqttService = createMqttService(config, state, contacts, logger);

  const invites = createInviteManager(config, mqttService);

  // executeTool bridge: calls the local OC tool when a job_request arrives
  const executeTool = api.runtime
    ? async (toolId: string, input: string): Promise<string> => {
        const result = await api.runtime!.executeTool({
          toolName: toolId,
          params: { input },
        });
        return typeof result === "string" ? result : JSON.stringify(result);
      }
    : undefined;

  const jobs = createJobManager(config, state, mqttService, logger, executeTool);

  // Channel inbound: wakes agent when MQTT events arrive (autonomous coordination)
  const channelInbound: ChannelInbound | null = api.runtime?.channel
    ? createChannelInbound(config, state, contacts, mqttService, api.runtime.channel, api.config, logger)
    : null;

  if (!channelInbound) {
    logger.warn("[AgentLink] Channel inbound API not available. Autonomous coordination disabled.");
  }

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
        const name = contacts.getNameByAgentId(msg.from) ?? msg.from;
        const cap = msg.payload.capability ?? "unknown";
        const result = msg.payload.result ?? msg.payload.text ?? "(no text)";
        channelInbound.dispatch(msg.group_id,
          `**${name}** (${cap}): ${result}`,
          msg.from);
      }
      return;
    }

    // Chat from participant — wake agent if we're the driver
    if (msg.type === "chat" && channelInbound) {
      const group = state.getGroup(msg.group_id);
      if (group && group.driver === config.agent.id) {
        const name = contacts.getNameByAgentId(msg.from) ?? msg.from;
        channelInbound.dispatch(msg.group_id,
          `**${name}**: ${msg.payload.text ?? "(no text)"}`,
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
      const name = contacts.getNameByAgentId(fromId) ?? fromId;
      log(`Invite received from ${name}: "${goal}"`);

      if (channelInbound && contacts.resolve(fromId)) {
        const groupId = msg.group_id as string;
        channelInbound.dispatch(groupId,
          `Invite from **${name}**: "${goal}"`,
          fromId);
      }
    }
  });

  // Status updates: track participant capabilities
  mqttService.onStatusUpdate((raw) => {
    const status = raw as Record<string, unknown>;
    if (!status || typeof status !== "object") return;
    const agentId = status.agent_id as string;
    if (!agentId || agentId === config.agent.id) return;

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

      const name = contacts.getNameByAgentId(from) ?? from;
      logger.info(`[AgentLink] ${name} joined group ${groupId.slice(0, 8)} (isNew=${isNew}, hasInbound=${!!channelInbound}, isDriver=${group.driver === config.agent.id})`);

      // Wake agent with join notification (only on first join, prevent duplicates)
      if (isNew && channelInbound && group.driver === config.agent.id) {
        const caps = state.getParticipantCapabilities(groupId, from);
        const capList = caps && caps.length > 0
          ? caps.map(c => `- **${c.name}**: ${c.description}`).join("\n")
          : "(capabilities loading...)";
        channelInbound.dispatch(groupId, [
          `**${name}** joined. Goal: "${group.goal}" | Done when: "${group.done_when}"`,
          ``,
          `Their capabilities:`,
          capList,
          ``,
          `Start by submitting jobs to ${name} using agentlink_submit_job with group_id "${groupId}".`,
        ].join("\n"), from);
      }
    }

    if (envelope.type === "leave") {
      const groupId = envelope.group_id as string;
      const from = envelope.from as string;
      const group = state.getGroup(groupId);

      if (group && from !== config.agent.id) {
        // Wake agent with completion notification before cleanup
        if (channelInbound && group.driver !== config.agent.id) {
          const name = contacts.getNameByAgentId(from) ?? from;
          const summary = (envelope.payload as Record<string, unknown>)?.text as string ?? "";
          channelInbound.dispatch(groupId,
            `Coordination complete — ${name}: ${summary}`,
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
  const tools = createTools(config, state, contacts, mqttService, invites, jobs, logger, channelInbound);
  for (const tool of tools) {
    api.registerTool(tool);
  }

  // Optional channel registration
  if (api.registerChannel) {
    const channelPlugin = createChannelPlugin(config, state, contacts, mqttService, logger);
    api.registerChannel({ plugin: channelPlugin });
  }

  // Anti-deadlock system prompt injection
  if (api.on) {
    api.on("before_prompt_build", () => {
      const activeGroups = state.getActiveGroups();
      if (activeGroups.length === 0) return {};

      const driverGroups = activeGroups
        .map((id) => state.getGroup(id))
        .filter((g) => g?.driver === config.agent.id);

      if (driverGroups.length === 0) return {};

      let prompt = "\n\n## AgentLink Coordination (MANDATORY)\n\n";
      prompt += "You are coordinating with other agents. Follow these rules:\n\n";
      prompt += "### Execution\n";
      prompt += "- Submit direct jobs (agentlink_submit_job) to get information — don't ask vague questions\n";
      prompt += "- Make concrete proposals with specifics (time, place, price)\n";
      prompt += "- After 3 idle turns, force progress with a job or complete\n";
      prompt += "- Call agentlink_complete immediately when done_when is met\n\n";
      prompt += "### Presentation (CRITICAL)\n";
      prompt += "- Work efficiently. Call tools without announcing each step.\n";
      prompt += "- NEVER say things like \"Waiting for response...\", \"Let me submit a job...\", \"I'm checking...\" — just do it.\n";
      prompt += "- Present results as clean, conversational updates. Show the OUTCOME, not the process.\n";
      prompt += "- When you get responses from participants, summarize the key findings naturally.\n";
      prompt += "- Keep messages short and polished. This conversation is visible to the user.\n\n";

      for (const group of driverGroups) {
        if (!group) continue;
        prompt += `### Active: "${group.goal}"\n`;
        prompt += `Done when: ${group.done_when} | Turns: ${group.idle_turns}/3\n`;
        if (group.idle_turns >= 3) {
          prompt += `⚠️ 3 idle turns — take concrete action NOW.\n`;
        }
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
