import path from "node:path";
import os from "node:os";
import type { AgentLinkConfig } from "./types.js";
import { resolveIdentity } from "./identity.js";
import { createContacts } from "./contacts.js";
import { createMqttService } from "./mqtt-service.js";
import { createMessageTool, createWhoisTool, createInviteTool, createJoinTool, createLogsTool } from "./tools.js";
import {
  handleIncomingEnvelope,
  dispatchToSession,
  relayToMainSession,
  formatConsolidatedSummaryPrompt,
  formatStatusPrompt,
} from "./channel.js";
import type { ChannelApi } from "./channel.js";
import { createA2ASessionManager } from "./a2a-session.js";
import { createA2ALogWriter } from "./a2a-log.js";
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
  const a2aManager = createA2ASessionManager(api.logger);
  const logWriter = createA2ALogWriter(config.dataDir, config.agentId, config.humanName);

  // ---------------------------------------------------------------------------
  // Timer management: status updates (15s/45s), no-response (60s), silence (30s)
  // ---------------------------------------------------------------------------

  interface ContactTimers {
    status15?: ReturnType<typeof setTimeout>;
    status45?: ReturnType<typeof setTimeout>;
    noResponse60?: ReturnType<typeof setTimeout>;
    silence30?: ReturnType<typeof setTimeout>;
  }
  const timers = new Map<string, ContactTimers>();

  function clearContactTimers(agentId: string) {
    const t = timers.get(agentId);
    if (t) {
      if (t.status15) clearTimeout(t.status15);
      if (t.status45) clearTimeout(t.status45);
      if (t.noResponse60) clearTimeout(t.noResponse60);
      if (t.silence30) clearTimeout(t.silence30);
      timers.delete(agentId);
    }
  }

  function startSilenceTimer(contactAgentId: string) {
    const t = timers.get(contactAgentId) ?? {};
    if (t.silence30) clearTimeout(t.silence30);
    t.silence30 = setTimeout(() => {
      // Silence timeout — conversation naturally ended
      if (a2aManager.isPaused(contactAgentId) || !api.runtime?.channel) return;

      const ctx = a2aManager.getOriginContext(contactAgentId);
      if (ctx) {
        // Human-initiated: relay consolidated summary
        a2aManager.pause(contactAgentId);
        const contact = contacts.findByAgentId(contactAgentId);
        const contactName = contact?.entry.human_name;
        const log = logWriter.readLog(contactAgentId);
        const count = a2aManager.getExchangeCount(contactAgentId);
        const relayText = formatConsolidatedSummaryPrompt(
          contactAgentId, contactName, count, log, "silence",
        );
        relayToMainSession(
          relayText, contactAgentId, contactName, config,
          api.runtime.channel, api.config, api.logger,
        ).catch((err) => {
          api.logger.warn(`[AgentLink] Failed to relay silence summary: ${err}`);
        });
        clearContactTimers(contactAgentId);
      }
      // Auto-respond (no origin context): log file already written. No relay.
    }, 30_000);
    timers.set(contactAgentId, t);
  }

  // Called when agentlink_message tool fires — starts 15s/45s/60s timers
  function onA2AStarted(contactAgentId: string) {
    if (!api.runtime?.channel) return;
    clearContactTimers(contactAgentId);

    const contact = contacts.findByAgentId(contactAgentId);
    const contactName = contact?.entry.human_name;
    const t: ContactTimers = {};

    t.status15 = setTimeout(() => {
      if (a2aManager.isPaused(contactAgentId) || !api.runtime?.channel) return;
      const prompt = formatStatusPrompt(contactAgentId, contactName, 1);
      relayToMainSession(
        prompt, contactAgentId, contactName, config,
        api.runtime.channel, api.config, api.logger,
      ).catch(() => {});
    }, 15_000);

    t.status45 = setTimeout(() => {
      if (a2aManager.isPaused(contactAgentId) || !api.runtime?.channel) return;
      const prompt = formatStatusPrompt(contactAgentId, contactName, 2);
      relayToMainSession(
        prompt, contactAgentId, contactName, config,
        api.runtime.channel, api.config, api.logger,
      ).catch(() => {});
    }, 45_000);

    t.noResponse60 = setTimeout(() => {
      if (a2aManager.isPaused(contactAgentId) || !api.runtime?.channel) return;
      const count = a2aManager.getExchangeCount(contactAgentId);
      if (count === 0) {
        // No exchanges at all — remote agent never responded
        a2aManager.pause(contactAgentId);
        const log = logWriter.readLog(contactAgentId);
        const relayText = formatConsolidatedSummaryPrompt(
          contactAgentId, contactName, count, log, "no_response",
        );
        relayToMainSession(
          relayText, contactAgentId, contactName, config,
          api.runtime.channel, api.config, api.logger,
        ).catch(() => {});
        clearContactTimers(contactAgentId);
      }
    }, 60_000);

    timers.set(contactAgentId, t);
  }

  api.logger.info(`[AgentLink] Agent: ${config.agentId} (${config.humanName})`);

  // --- Service: background MQTT connection ---
  api.registerService({
    id: "agentlink-mqtt",
    async start() {
      await mqttService.start();

      // Handle incoming messages — free-running multi-turn A2A
      mqttService.onMessage((envelope) => {
        handleIncomingEnvelope(
          envelope,
          config,
          contacts,
          api.logger,
          (text, senderAgentId) => {
            if (!api.runtime?.channel) {
              api.logger.info(`[AgentLink] Inbound (no channel): ${text}`);
              return;
            }

            // Log inbound message to markdown (only for actual messages)
            const contact = contacts.findByAgentId(senderAgentId);
            const contactName = contact?.entry.human_name ?? envelope.from_name ?? senderAgentId;
            if (envelope.type === "message" && envelope.text) {
              logWriter.logInbound(senderAgentId, contactName, envelope.text);
            }

            // If tool-origin (other side's human initiated), reset exchange counter
            if (envelope.origin === "tool" && a2aManager.isPaused(senderAgentId)) {
              a2aManager.reset(senderAgentId);
            }

            // If paused (exchange limit already hit), drop the message
            if (a2aManager.isPaused(senderAgentId)) {
              api.logger.info(`[AgentLink] Dropping message from ${senderAgentId} — conversation paused`);
              return;
            }

            // Reset silence timer on each inbound (conversation still active)
            startSilenceTimer(senderAgentId);

            // Dispatch to A2A session — always with outbound capture enabled
            // Track if CONVERSATION_COMPLETE already handled the relay
            let completionRelayed = false;

            dispatchToSession(
              text,
              senderAgentId,
              config,
              api.runtime.channel,
              api.config,
              api.logger,
              {
                mqttClient,
                a2aManager,
                contacts,
                logWriter,
                onOutboundSent: () => startSilenceTimer(senderAgentId),
                onConversationComplete: () => {
                  // Agent signaled [CONVERSATION_COMPLETE] — pause conversation
                  if (completionRelayed || a2aManager.isPaused(senderAgentId)) return;
                  completionRelayed = true;
                  a2aManager.pause(senderAgentId);
                  clearContactTimers(senderAgentId);

                  // Only relay if human-initiated (origin context exists).
                  // Auto-respond side (no origin) just pauses — no relay to human.
                  const originCtx = a2aManager.getOriginContext(senderAgentId);
                  if (!originCtx || !api.runtime?.channel) {
                    api.logger.info(`[AgentLink] A2A with ${senderAgentId} completed (auto-respond, no relay)`);
                    return;
                  }

                  const cInfo = contacts.findByAgentId(senderAgentId);
                  const cName = cInfo?.entry.human_name;
                  const log = logWriter.readLog(senderAgentId);
                  const count = a2aManager.getExchangeCount(senderAgentId);
                  const relayText = formatConsolidatedSummaryPrompt(
                    senderAgentId, cName, count, log, "silence",
                  );
                  api.logger.info(`[AgentLink] A2A with ${senderAgentId} completed — relaying to human`);
                  relayToMainSession(
                    relayText, senderAgentId, cName,
                    config, api.runtime.channel, api.config, api.logger,
                  ).catch((err) => {
                    api.logger.warn(`[AgentLink] Failed to relay completion summary: ${err}`);
                  });
                },
              },
            ).then(() => {
              // After dispatch: if exchange limit was just hit AND completion didn't already relay
              if (!completionRelayed && a2aManager.isPaused(senderAgentId) && api.runtime?.channel) {
                const log = logWriter.readLog(senderAgentId);
                const count = a2aManager.getExchangeCount(senderAgentId);
                const relayText = formatConsolidatedSummaryPrompt(
                  senderAgentId, contact?.entry.human_name, count, log, "exchange_limit",
                );
                relayToMainSession(
                  relayText, senderAgentId, contact?.entry.human_name,
                  config, api.runtime.channel, api.config, api.logger,
                ).catch((err) => {
                  api.logger.warn(`[AgentLink] Failed to relay exchange limit summary: ${err}`);
                });
                clearContactTimers(senderAgentId);
              }
            }).catch((err) => {
              api.logger.warn(`[AgentLink] Failed to dispatch to session: ${err}`);
            });
          },
        );
      });

      api.logger.info("[AgentLink] Service started. Listening for messages.");

      // Process pending invite code (if CLI saved one)
      const fs = await import("node:fs/promises");
      const pendingJoinPath = path.join(config.dataDir, "pending_join.json");
      try {
        const pendingData = await fs.readFile(pendingJoinPath, "utf-8");
        const { code } = JSON.parse(pendingData);
        if (code) {
          api.logger.info(`[AgentLink] Processing pending invite code: ${code}`);
          const result = await resolveInviteCode(code, config, mqttClient, contacts, api.logger);
          api.logger.info(`[AgentLink] ${result.message}`);
          await fs.unlink(pendingJoinPath);
        }
      } catch (err) {
        // No pending join file or failed to process - not an error
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          api.logger.warn(`[AgentLink] Failed to process pending join: ${err}`);
        }
      }
    },
    async stop() {
      await mqttService.stop();
      api.logger.info("[AgentLink] Service stopped.");
    },
  });

  // --- Tools ---
  api.registerTool(createMessageTool(config, mqttClient, contacts, api.logger, a2aManager, onA2AStarted));
  api.registerTool(createWhoisTool(config, mqttClient, contacts, api.logger));
  api.registerTool(createInviteTool(config, mqttClient, api.logger));
  api.registerTool(createJoinTool(config, mqttClient, contacts, api.logger));
  api.registerTool(createLogsTool(config, contacts, logWriter));

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
