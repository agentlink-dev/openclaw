import type { AgentLinkConfig } from "./types.js";
import { resolveConfig } from "./types.js";
import { createContacts } from "./contacts.js";
import { createState } from "./state.js";
import { createMqttService } from "./mqtt-service.js";
import { createInviteManager } from "./invite.js";
import { createJobManager } from "./jobs.js";
import { createTools } from "./tools.js";
import { createChannelPlugin } from "./channel.js";
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
      return;
    }

    // General coordination message — log it
    const senderName = contacts.getNameByAgentId(msg.from) ?? msg.from;
    log(`Message from ${senderName}: ${msg.payload.text ?? "(no text)"}`);
  });

  mqttService.onInboxMessage((_topic, raw) => {
    const msg = raw as Record<string, unknown>;
    if (msg.type === "invite") {
      log(`Invite received from ${msg.from}: "${msg.goal}"`);
      // For V1: auto-join if from known contact
      const fromId = msg.from as string;
      if (contacts.resolve(fromId)) {
        log(`Auto-joining (known contact: ${contacts.getNameByAgentId(fromId) ?? fromId})`);
        // Auto-join logic handled by the agent's LLM calling agentlink_join_group
        // or we could auto-accept here for known contacts
      }
    }
  });

  mqttService.onSystemEvent((raw) => {
    const msg = raw as Record<string, unknown>;
    if (msg && typeof msg === "object" && "type" in msg) {
      const envelope = msg as Record<string, unknown>;
      if (envelope.type === "join") {
        const from = envelope.from as string;
        const groupId = envelope.group_id as string;
        const group = state.getGroup(groupId);
        if (group && !group.participants.includes(from)) {
          group.participants.push(from);
          state.updateGroup(groupId, { participants: group.participants });
        }
        log(`${contacts.getNameByAgentId(from) ?? from} joined group ${groupId}`);
      }
      if (envelope.type === "leave") {
        const groupId = envelope.group_id as string;
        // If this is a completion message from the driver, clean up
        const group = state.getGroup(groupId);
        if (group && envelope.from !== config.agent.id) {
          mqttService.unsubscribeGroup(groupId);
          state.removeGroup(groupId);
          log(`Group ${groupId} closed by driver`);
        }
      }
    }
  });

  // Background MQTT connection
  api.registerService({
    id: "agentlink-mqtt",
    start: () => mqttService.start(),
    stop: () => mqttService.stop(),
  });

  // Register the 5 agent tools
  const tools = createTools(config, state, contacts, mqttService, invites, jobs, logger);
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

      let prompt = "\n\n## AgentLink Coordination Rules (MANDATORY)\n";
      prompt += "You are the DRIVER of active coordination(s). You MUST follow these rules:\n";
      prompt += "1. Issue direct jobs (agentlink_submit_job) instead of asking open-ended questions.\n";
      prompt += "2. Make concrete proposals with specifics (time, place, price), not vague suggestions.\n";
      prompt += "3. After 3 turns of discussion without a job, proposal, or completion, you MUST force progress.\n";
      prompt += "4. Declare completion (agentlink_complete) as soon as the done_when condition is met.\n";
      prompt += "5. Hub-and-spoke: you mediate all coordination. Participants respond to you, not each other.\n\n";

      for (const group of driverGroups) {
        if (!group) continue;
        prompt += `Active: "${group.goal}" | Done when: "${group.done_when}" | Idle turns: ${group.idle_turns}/3\n`;
        if (group.idle_turns >= 3) {
          prompt += `  WARNING: 3 idle turns reached. You MUST take concrete action NOW.\n`;
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
