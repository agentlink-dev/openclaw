import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentLinkConfig } from "./types.js";
import { resolveIdentity } from "./identity.js";
import { createContacts } from "./contacts.js";
import { createMqttService } from "./mqtt-service.js";
import { createMessageTool, createWhoisTool, createInviteTool, createJoinTool } from "./tools.js";
import { handleIncomingEnvelope, dispatchToSession } from "./channel.js";
import type { ChannelApi } from "./channel.js";
import { resolveInviteCode } from "./invite.js";
import type { Logger } from "./mqtt-client.js";

// ---------------------------------------------------------------------------
// Minimal OC Plugin API type (matches what we use from OpenClaw)
// ---------------------------------------------------------------------------

interface PluginApi {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: Logger;
  registerService(service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
    }>;
  }): void;
  registerChannel?(registration: { plugin: unknown }): void;
  registerCli?(registrar: (ctx: { program: unknown }) => void, opts?: { commands?: string[] }): void;
  runtime?: {
    channel?: ChannelApi;
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(raw: Record<string, unknown>): AgentLinkConfig {
  const dataDir = (raw.data_dir as string) ?? path.join(os.homedir(), ".agentlink");
  const identity = resolveIdentity({
    agentId: (raw.agent as Record<string, unknown>)?.id as string | undefined,
    humanName: (raw.agent as Record<string, unknown>)?.human_name as string | undefined
      ?? (raw.human_name as string | undefined),
    dataDir,
  });

  return {
    brokerUrl: (raw.brokerUrl as string) ?? "mqtt://broker.emqx.io:1883",
    brokerUsername: raw.brokerUsername as string | undefined,
    brokerPassword: raw.brokerPassword as string | undefined,
    agentId: identity.agent_id,
    humanName: identity.human_name,
    dataDir,
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default {
  id: "agentlink",
  name: "AgentLink",
  description: "Agent-to-agent messaging over MQTT. Your agent talks to other people's agents.",
  register,
};

function register(api: PluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});
  const contacts = createContacts(config.dataDir);
  const mqttService = createMqttService(config, api.logger);
  const mqttClient = mqttService.getClient();

  api.logger.info(`[AgentLink] Agent: ${config.agentId} (${config.humanName})`);

  // --- Service: background MQTT connection ---
  api.registerService({
    id: "agentlink-mqtt",
    async start() {
      await mqttService.start();

      // Handle incoming messages
      mqttService.onMessage((envelope) => {
        handleIncomingEnvelope(
          envelope,
          config,
          contacts,
          api.logger,
          (text) => {
            // Inject message into OC session via channel API
            if (api.runtime?.channel) {
              dispatchToSession(
                text,
                envelope.from,
                config,
                api.runtime.channel,
                api.config,
                api.logger,
              ).catch((err) => {
                api.logger.warn(`[AgentLink] Failed to dispatch to session: ${err}`);
              });
            } else {
              // Fallback: log it (channel API may not be available)
              api.logger.info(`[AgentLink] Inbound (no channel): ${text}`);
            }
          },
        );
      });

      api.logger.info("[AgentLink] Service started. Listening for messages.");
    },
    async stop() {
      await mqttService.stop();
      api.logger.info("[AgentLink] Service stopped.");
    },
  });

  // --- Tools ---
  api.registerTool(createMessageTool(config, mqttClient, contacts, api.logger));
  api.registerTool(createWhoisTool(config, mqttClient, contacts, api.logger));
  api.registerTool(createInviteTool(config, mqttClient, api.logger));
  api.registerTool(createJoinTool(config, mqttClient, contacts, api.logger));

  // --- CLI ---
  if (api.registerCli) {
    api.registerCli(
      ({ program }: { program: any }) => {
        const agentlink = program
          .command("agentlink")
          .description("AgentLink agent-to-agent messaging");

        agentlink
          .command("status")
          .description("Show AgentLink connection status")
          .action(() => {
            console.log(`Agent ID:    ${config.agentId}`);
            console.log(`Human:       ${config.humanName}`);
            console.log(`Broker:      ${config.brokerUrl}`);
            console.log(`Connected:   ${mqttService.isConnected() ? "Yes" : "No"}`);
            console.log(`Data dir:    ${config.dataDir}`);
          });

        agentlink
          .command("contacts")
          .description("List AgentLink contacts")
          .action(() => {
            const all = contacts.getAll();
            const entries = Object.entries(all);
            if (entries.length === 0) {
              console.log("No contacts yet. Use agentlink_invite to generate an invite code.");
              return;
            }
            console.log(`Contacts (${entries.length}):\n`);
            for (const [name, entry] of entries) {
              const label = entry.human_name ? `${entry.human_name} ` : "";
              console.log(`  ${name}: ${label}(${entry.agent_id}) — added ${entry.added}`);
            }
          });

        agentlink
          .command("join <code>")
          .description("Join AgentLink using an invite code")
          .action(async (code: string) => {
            if (!mqttService.isConnected()) {
              console.log("Not connected to broker. Start the gateway first.");
              return;
            }
            const result = await resolveInviteCode(code, config, mqttClient, contacts, api.logger);
            console.log(result.message);
          });
      },
      { commands: ["agentlink"] },
    );
  }
}
