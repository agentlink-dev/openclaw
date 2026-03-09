import type { MessageEnvelope, AgentLinkConfig } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";
import type { A2ASessionManager } from "./a2a-session.js";

// ---------------------------------------------------------------------------
// OC Channel Runtime API types (subset used by AgentLink inbound dispatch)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ChannelApi {
  reply: {
    dispatchReplyWithBufferedBlockDispatcher(params: {
      ctx: Record<string, any>;
      cfg: Record<string, any>;
      dispatcherOptions: {
        deliver: (payload: { text?: string; mediaUrl?: string; isError?: boolean; isReasoning?: boolean }, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
        onError?: (err: unknown, info: { kind: string }) => void;
      };
      replyOptions?: { disableBlockStreaming?: boolean };
    }): Promise<{ queuedFinal: boolean }>;
    finalizeInboundContext(ctx: Record<string, any>): Record<string, any>;
  };
  session: {
    recordInboundSession(params: {
      storePath: string;
      sessionKey: string;
      ctx: Record<string, any>;
      onRecordError: (err: unknown) => void;
    }): Promise<void>;
    resolveStorePath(storeConfig: unknown, opts: { agentId: string }): string;
  };
  routing: {
    resolveAgentRoute(input: {
      cfg: Record<string, any>;
      channel: string;
      accountId?: string;
      peer?: { kind: string; id: string };
    }): { agentId: string; sessionKey: string; channel: string; accountId: string; mainSessionKey?: string };
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Dispatch options
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  /** MQTT client for publishing auto-responses back to sender. */
  mqttClient?: MqttClient;
  /** A2A session manager for exchange counting and relay tracking. */
  a2aManager?: A2ASessionManager;
  /** Contact store for looking up human names. */
  contacts?: ContactsStore;
}

// ---------------------------------------------------------------------------
// Dispatch inbound message to OC agent session (with outbound capture)
// ---------------------------------------------------------------------------

/**
 * Dispatch a text message into the OC agent session using the channel API.
 * This wakes the agent and injects the message as if it came from a chat channel.
 *
 * When `options.mqttClient` is provided, the agent's response is auto-captured
 * and published back to the sender via MQTT (outbound capture).
 */
export async function dispatchToSession(
  text: string,
  senderAgentId: string,
  config: AgentLinkConfig,
  channelApi: ChannelApi,
  ocConfig: Record<string, unknown>,
  logger: Logger,
  options?: DispatchOptions,
): Promise<void> {
  try {
    // 1. Resolve route → per-contact session key
    const route = channelApi.routing.resolveAgentRoute({
      cfg: ocConfig,
      channel: "agentlink",
      accountId: config.agentId,
      peer: { kind: "direct", id: senderAgentId },
    });

    // 2. Build + finalize inbound context
    const ctx = channelApi.reply.finalizeInboundContext({
      Body: text,
      BodyForAgent: text,
      SessionKey: route.sessionKey,
      From: `agentlink:${senderAgentId}`,
      To: `agentlink:${config.agentId}`,
      Provider: "agentlink",
      Surface: "agentlink",
      OriginatingChannel: "agentlink",
      OriginatingTo: config.agentId,
      SenderName: senderAgentId,
      SenderId: senderAgentId,
      ChatType: "direct",
      CommandAuthorized: true,
      Timestamp: Date.now(),
    });

    // 3. Record session
    const cfgAny = ocConfig as Record<string, any>;
    const storePath = channelApi.session.resolveStorePath(
      cfgAny.session?.store ?? cfgAny.store,
      { agentId: route.agentId },
    );
    await channelApi.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx,
      onRecordError: (err) => logger.warn(`[AgentLink] recordInboundSession error: ${err}`),
    });

    // 4. Track exchange count
    if (options?.a2aManager) {
      const count = options.a2aManager.recordExchange(senderAgentId);
      if (options.a2aManager.isPaused(senderAgentId)) {
        logger.info(`[AgentLink] A2A conversation with ${senderAgentId} paused (limit reached at ${count})`);
        // Don't dispatch — we've hit the exchange limit.
        // The relay handler in index.ts will notify the main session.
        return;
      }
    }

    // 5. Dispatch — agent wakes up and processes the message
    //    Outbound capture: accumulate the agent's response text
    let accumulated = "";
    let published = false;

    await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: ocConfig,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          // Skip reasoning and error blocks
          if (payload.isReasoning || payload.isError) return;

          // Accumulate text
          if (payload.text) accumulated += payload.text;

          // On final: publish the accumulated response back to sender via MQTT
          // Guard: only publish once (deliver may fire "final" multiple times)
          if (info.kind === "final" && !published && options?.mqttClient && accumulated.trim()) {
            published = true;
            const responseText = accumulated.trim();
            const envelope = createEnvelope(
              "message",
              config.agentId,
              config.humanName,
              senderAgentId,
              responseText,
              "auto",
            );
            const topic = TOPICS.inbox(senderAgentId, config.agentId);

            try {
              await options.mqttClient.publish(topic, JSON.stringify(envelope));
              const contact = options.contacts?.findByAgentId(senderAgentId);
              const label = contact ? `${contact.name}'s agent (${senderAgentId})` : senderAgentId;
              logger.info(`[AgentLink] Auto-response sent to ${label}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn(`[AgentLink] Failed to send auto-response: ${msg}`);
            }
          }
        },
        onError: (err, info) => {
          logger.warn(`[AgentLink] dispatch ${info.kind} error: ${err}`);
        },
      },
      replyOptions: { disableBlockStreaming: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[AgentLink] dispatchToSession failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Relay: inject a notification into the main/default agentlink session
// ---------------------------------------------------------------------------

/**
 * Relay an A2A response into the main agentlink session so the human sees it.
 * Uses a separate "relay" peer to avoid mixing with A2A per-contact sessions.
 */
export async function relayToMainSession(
  responseText: string,
  senderAgentId: string,
  senderHumanName: string | undefined,
  config: AgentLinkConfig,
  channelApi: ChannelApi,
  ocConfig: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  const senderLabel = senderHumanName
    ? `${senderHumanName}'s agent (${senderAgentId})`
    : senderAgentId;

  const relayText = [
    `[AgentLink] Response from ${senderLabel}:`,
    responseText,
    "",
    "---",
    "This is a response relayed from an agent-to-agent conversation.",
    "Summarize and share the relevant parts with your human.",
  ].join("\n");

  try {
    // Route to the webchat session so the relay appears in the human's main chat.
    // Falls back to agentlink channel if webchat routing fails.
    let route;
    try {
      route = channelApi.routing.resolveAgentRoute({
        cfg: ocConfig,
        channel: "webchat",
        accountId: config.agentId,
      });
    } catch {
      route = channelApi.routing.resolveAgentRoute({
        cfg: ocConfig,
        channel: "agentlink",
        accountId: config.agentId,
        peer: { kind: "relay", id: "notifications" },
      });
    }

    // Use webchat provider/channel so OC keeps the session tagged as webchat.
    // Without this, the session's lastChannel flips to "agentlink" after the first
    // relay and subsequent agent responses can't be delivered to the webchat UI.
    const ctx = channelApi.reply.finalizeInboundContext({
      Body: relayText,
      BodyForAgent: relayText,
      SessionKey: route.sessionKey,
      From: `agentlink:relay:${senderAgentId}`,
      To: config.agentId,
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: config.agentId,
      SenderName: senderLabel,
      SenderId: `agentlink:${senderAgentId}`,
      ChatType: "direct",
      CommandAuthorized: true,
      Timestamp: Date.now(),
    });

    const cfgAny = ocConfig as Record<string, any>;
    const storePath = channelApi.session.resolveStorePath(
      cfgAny.session?.store ?? cfgAny.store,
      { agentId: route.agentId },
    );

    await channelApi.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx,
      onRecordError: (err) => logger.warn(`[AgentLink] recordInboundSession (relay) error: ${err}`),
    });

    // Dispatch to relay session — agent processes and responds to human
    await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: ocConfig,
      dispatcherOptions: {
        deliver: async () => {
          // Relay session responses go to UI only — no MQTT outbound
        },
        onError: (err, info) => {
          logger.warn(`[AgentLink] relay dispatch ${info.kind} error: ${err}`);
        },
      },
      replyOptions: { disableBlockStreaming: true },
    });

    logger.info(`[AgentLink] Relayed response from ${senderAgentId} to main session`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[AgentLink] Failed to relay to main session: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Format inbound messages
// ---------------------------------------------------------------------------

/**
 * Format an incoming agent message for display in the A2A session.
 * Instructs the agent to respond naturally — outbound capture handles the rest.
 */
export function formatInboundMessage(
  envelope: MessageEnvelope,
  a2aContext?: { exchangeCount: number; maxExchanges: number },
): string {
  const contactLabel = envelope.from_name
    ? `${envelope.from_name} (${envelope.from})`
    : envelope.from;

  const lines = [
    `[AgentLink] Message from ${contactLabel}:`,
    envelope.text ?? "(no message body)",
    "",
    "---",
    `You are in an AgentLink conversation with ${contactLabel}.`,
    "Respond naturally — your text response will be captured and sent back automatically.",
    "IMPORTANT: Do NOT use the agentlink_message tool to reply in this conversation.",
    "Just respond with text. The system handles delivery.",
    "",
    "Use ALL your tools (calendar, skills, exec, etc.) to give accurate answers.",
    "If a tool call fails, read the relevant skill file with the read tool (NOT exec) and retry.",
    "When using exec, run simple commands without shell redirects (no 2>/dev/null, no pipes, no ||).",
    "Do NOT fall back to guessing or memory when tools are available — use them.",
  ];

  if (a2aContext) {
    lines.push(
      `Exchange ${a2aContext.exchangeCount}/${a2aContext.maxExchanges} — conversation will pause at the limit for human review.`,
    );
  }

  return lines.join("\n");
}

/**
 * Format a "conversation paused" message for the main session relay.
 */
export function formatPausedMessage(
  senderAgentId: string,
  senderHumanName: string | undefined,
  exchangeCount: number,
): string {
  const label = senderHumanName
    ? `${senderHumanName}'s agent (${senderAgentId})`
    : senderAgentId;

  return [
    `[AgentLink] Conversation with ${label} paused after ${exchangeCount} exchanges.`,
    "",
    "The agent-to-agent conversation has reached its exchange limit.",
    "Check the AgentLink conversation in the sidebar for details.",
    "Tell me to continue the conversation if you'd like me to keep going.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Handle incoming envelope: route to A2A session or process contact_exchange
// ---------------------------------------------------------------------------

/**
 * Handle an incoming message envelope:
 * 1. For "message" type: inject into A2A session (with outbound capture)
 * 2. For "contact_exchange" type: auto-add to contacts
 */
export function handleIncomingEnvelope(
  envelope: MessageEnvelope,
  config: AgentLinkConfig,
  contacts: ContactsStore,
  logger: Logger,
  injectToSession: (text: string, senderAgentId: string) => void,
): void {
  if (envelope.type === "contact_exchange") {
    // Auto-add sender to contacts
    const existingContact = contacts.findByAgentId(envelope.from);
    if (!existingContact) {
      const name = envelope.from_name?.toLowerCase() || envelope.from;
      contacts.add(name, envelope.from, envelope.from_name);
      logger.info(`[AgentLink] New contact added: ${envelope.from_name} (${envelope.from})`);
      injectToSession(
        `[AgentLink] ${envelope.from_name}'s agent (${envelope.from}) has connected! They are now in your contacts. You can message them anytime.`,
        envelope.from,
      );
    }
    return;
  }

  if (envelope.type === "message") {
    const formatted = formatInboundMessage(envelope);
    injectToSession(formatted, envelope.from);
    return;
  }

  logger.warn(`[AgentLink] Unknown message type: ${envelope.type}`);
}
