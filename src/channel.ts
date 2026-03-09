import type { MessageEnvelope, AgentLinkConfig } from "./types.js";
import type { Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";

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
// Dispatch inbound message to OC agent session
// ---------------------------------------------------------------------------

/**
 * Dispatch a text message into the OC agent session using the channel API.
 * This wakes the agent and injects the message as if it came from a chat channel.
 */
export async function dispatchToSession(
  text: string,
  senderAgentId: string,
  config: AgentLinkConfig,
  channelApi: ChannelApi,
  ocConfig: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  try {
    // 1. Resolve route → session key
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

    // 4. Dispatch — agent wakes up and processes the message
    await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: ocConfig,
      dispatcherOptions: {
        deliver: async (_payload, _info) => {
          // Agent's text response appears in OC chat UI.
          // We don't relay it back via MQTT — the human decides when to respond.
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

/**
 * Format an incoming agent message for display in the OC session.
 * Includes [AgentLink] prefix and anti-loop instruction.
 */
export function formatInboundMessage(envelope: MessageEnvelope): string {
  const contactLabel = envelope.from_name
    ? `${envelope.from_name} (${envelope.from})`
    : envelope.from;

  return [
    `[AgentLink] Message from ${contactLabel}:`,
    envelope.text ?? "(no message body)",
    "",
    "---",
    "This is an incoming message from another agent via AgentLink.",
    "Respond to help them, but do not send follow-up AgentLink messages unless your human asks you to.",
  ].join("\n");
}

/**
 * Handle an incoming message envelope:
 * 1. For "message" type: inject into OC session
 * 2. For "contact_exchange" type: auto-add to contacts
 */
export function handleIncomingEnvelope(
  envelope: MessageEnvelope,
  config: AgentLinkConfig,
  contacts: ContactsStore,
  logger: Logger,
  injectToSession: (text: string) => void,
): void {
  if (envelope.type === "contact_exchange") {
    // Auto-add sender to contacts
    const existingContact = contacts.findByAgentId(envelope.from);
    if (!existingContact) {
      const name = envelope.from_name?.toLowerCase() || envelope.from;
      contacts.add(name, envelope.from, envelope.from_name);
      logger.info(`[AgentLink] New contact added: ${envelope.from_name} (${envelope.from})`);
      injectToSession(
        `[AgentLink] ${envelope.from_name}'s agent (${envelope.from}) has connected! They are now in your contacts. You can message them anytime.`
      );
    }
    return;
  }

  if (envelope.type === "message") {
    const formatted = formatInboundMessage(envelope);
    injectToSession(formatted);
    return;
  }

  logger.warn(`[AgentLink] Unknown message type: ${envelope.type}`);
}
