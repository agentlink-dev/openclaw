import type { MessageEnvelope, AgentLinkConfig } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";
import type { A2ASessionManager, OriginContext } from "./a2a-session.js";
import type { A2ALogWriter } from "./a2a-log.js";
import type { InvitationsStore } from "./invitations.js";
import type { ChannelTracker } from "./channel-tracker.js";
import {
  readSharing,
  getAllowedScopes,
  getAskScopes,
  getBlockedScopes,
  formatScopeList,
} from "./sharing.js";

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
  /** Log writer for A2A conversation logs. */
  logWriter?: A2ALogWriter;
  /** Called after an outbound auto-response is published via MQTT. */
  onOutboundSent?: () => void;
  /** Called when the agent signals [CONVERSATION_COMPLETE]. */
  onConversationComplete?: () => void;
  /** Called with agent's response text (for relay scenarios). Takes precedence over MQTT publish. */
  captureOutbound?: (responseText: string) => Promise<void>;
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
  options?: DispatchOptions & { sessionKey?: string; targetChannel?: string },
): Promise<void> {
  try {
    // 1. Determine target channel and session key
    const targetChannel = options?.targetChannel || "agentlink";
    const sessionKey = options?.sessionKey || channelApi.routing.resolveAgentRoute({
      cfg: ocConfig,
      channel: targetChannel,
      accountId: config.agentId,
      peer: targetChannel === "agentlink" ? { kind: "direct", id: senderAgentId } : undefined,
    }).sessionKey;

    // 2. Build + finalize inbound context
    // For relay (targetChannel = "slack"/"whatsapp"), match the target channel in all fields
    // For A2A (targetChannel = "agentlink"), use agentlink identifiers
    const ctx = channelApi.reply.finalizeInboundContext({
      Body: text,
      BodyForAgent: text,
      SessionKey: sessionKey,
      From: targetChannel === "agentlink" ? `agentlink:${senderAgentId}` : targetChannel,
      To: targetChannel === "agentlink" ? `agentlink:${config.agentId}` : config.agentId,
      Provider: targetChannel,
      Surface: targetChannel,
      OriginatingChannel: targetChannel,
      OriginatingTo: config.agentId,
      SenderName: senderAgentId,
      SenderId: targetChannel === "agentlink" ? senderAgentId : targetChannel,
      ChatType: "direct",
      CommandAuthorized: true,
      Timestamp: Date.now(),
    });

    // 3. Record session
    const cfgAny = ocConfig as Record<string, any>;
    const storePath = channelApi.session.resolveStorePath(
      cfgAny.session?.store ?? cfgAny.store,
      { agentId: config.agentId },
    );
    await channelApi.session.recordInboundSession({
      storePath,
      sessionKey: sessionKey,
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

          // On final: handle the accumulated response
          // Guard: only handle once (deliver may fire "final" multiple times)
          if (info.kind === "final" && !published && accumulated.trim()) {
            published = true;
            let responseText = accumulated.trim();

            // Check for [CONVERSATION_COMPLETE] marker — agent signals it's done
            const completeMarker = "[CONVERSATION_COMPLETE]";
            const isComplete = responseText.includes(completeMarker);
            if (isComplete) {
              // Strip the marker from the response text
              responseText = responseText.replace(completeMarker, "").trim();
            }

            const contact = options?.contacts?.findByAgentId(senderAgentId);

            // Log the outbound
            if (options?.logWriter && responseText) {
              options.logWriter.logOutbound(senderAgentId, contact?.entry.human_name ?? senderAgentId, responseText);
            }

            // If captureOutbound is provided (relay scenario), call it instead of MQTT publish
            if (options?.captureOutbound) {
              try {
                await options.captureOutbound(responseText);
                logger.info(`[AgentLink] Relay response captured and delivered`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[AgentLink] Failed to deliver relay: ${msg}`);
              }
              return;
            }

            // Otherwise: publish the response to MQTT (normal A2A flow)
            if (options?.mqttClient) {
              const envelope = createEnvelope(
                "message",
                config.agentId,
                config.humanName,
                senderAgentId,
                responseText,
                "auto",
                undefined,
                undefined,
                config.agentName,
              );
              const topic = TOPICS.inbox(senderAgentId, config.agentId);

              try {
                await options.mqttClient.publish(topic, JSON.stringify(envelope));
                const label = contact ? `${contact.name}'s agent (${senderAgentId})` : senderAgentId;
                logger.info(`[AgentLink] Auto-response sent to ${label}`);

                if (isComplete) {
                  // Final answer published. Pause this side — don't auto-respond to further messages.
                  logger.info(`[AgentLink] Conversation with ${label} completed (agent signaled DONE)`);
                  options?.onConversationComplete?.();
                } else {
                  options?.onOutboundSent?.();
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[AgentLink] Failed to send auto-response: ${msg}`);
              }
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
 * Send a message to any OpenClaw channel using the appropriate channel-specific API.
 * Works for Slack, Discord, Telegram, WhatsApp, Signal, and other official channels.
 */
export async function sendToChannel(params: {
  channel: string;
  to: string;
  message: string;
  accountId?: string;
  runtime: any;
  cfg: any;
  logger: Logger;
}): Promise<void> {
  const { channel, to, message, accountId, runtime, cfg, logger } = params;

  try {
    switch (channel.toLowerCase()) {
      case "slack":
        await runtime.channel.slack.sendMessageSlack(to, message, { accountId, cfg });
        break;
      case "discord":
        await runtime.channel.discord.sendMessageDiscord(to, message, { accountId, cfg });
        break;
      case "telegram":
        await runtime.channel.telegram.sendMessageTelegram(to, message, { accountId, cfg });
        break;
      case "whatsapp":
        await runtime.channel.whatsapp.sendMessageWhatsApp(to, message, { accountId, cfg });
        break;
      case "signal":
        await runtime.channel.signal.sendMessageSignal(to, message, { accountId, cfg });
        break;
      default:
        logger.warn(`[AgentLink] Unsupported channel for direct delivery: ${channel}`);
        throw new Error(`Channel "${channel}" does not support direct delivery via AgentLink`);
    }

    logger.info(`[AgentLink] Delivered relay to ${channel} (${to})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[AgentLink] Failed to deliver to ${channel}: ${msg}`);
    throw err;
  }
}

/**
 * Push a notification to the human via all known messaging channels.
 * Falls back to webchat/main session if no messaging channels are known.
 */
export async function pushNotification(params: {
  message: string;
  config: AgentLinkConfig;
  channelTracker: ChannelTracker;
  channelApi: ChannelApi;
  ocConfig: Record<string, unknown>;
  logger: Logger;
  runtime: any;
}): Promise<void> {
  const channels = params.channelTracker.getMessagingChannels();

  // Resolve delivery address from hook's "from" value to channel-specific "to" format.
  // Hook "from" may include channel prefix (e.g., "slack:U0146UGUH1R").
  // Slack/Discord DMs need "user:<id>" format.
  function resolveDeliveryAddress(channelId: string, from: string): string {
    // Strip channel prefix if present (e.g., "slack:U0146UGUH1R" → "U0146UGUH1R")
    const colonIdx = from.indexOf(":");
    const raw = colonIdx >= 0 && from.substring(0, colonIdx) === channelId
      ? from.substring(colonIdx + 1)
      : from;

    if (channelId === "slack" || channelId === "discord") {
      return raw.startsWith("user:") ? raw : `user:${raw}`;
    }
    return raw;
  }

  // Push to all known messaging channels
  for (const [channelId, record] of Object.entries(channels)) {
    try {
      await sendToChannel({
        channel: channelId,
        to: resolveDeliveryAddress(channelId, record.from),
        message: params.message,
        accountId: record.accountId,
        runtime: params.runtime,
        cfg: params.ocConfig,
        logger: params.logger,
      });
    } catch (err) {
      params.logger.warn(`[AgentLink] Failed to push notification to ${channelId}: ${err}`);
    }
  }

  // If no messaging channels known, dispatch to main/webchat session
  if (Object.keys(channels).length === 0) {
    await dispatchToSession(
      params.message,
      "system",
      params.config,
      params.channelApi,
      params.ocConfig,
      params.logger,
      {
        sessionKey: "agent:main:main",
        targetChannel: "webchat",
        mqttClient: undefined,
      },
    );
  }
}

/**
 * Relay a prompt into the session where the human initiated the A2A conversation.
 * The relay text is pre-formatted by the caller (e.g., consolidated summary, status prompt).
 * Uses channel-specific delivery APIs to send directly to Slack/WhatsApp/Discord/etc.
 */
export async function relayToInitiatingSession(
  relayText: string,
  senderAgentId: string,
  senderHumanName: string | undefined,
  config: AgentLinkConfig,
  channelApi: ChannelApi,
  ocConfig: Record<string, unknown>,
  logger: Logger,
  originCtx?: OriginContext,
  runtime?: any,
): Promise<void> {
  const senderLabel = senderHumanName
    ? `${senderHumanName}'s agent (${senderAgentId})`
    : senderAgentId;

  try {
    // Use origin context for delivery
    if (!originCtx || !runtime) {
      logger.warn(`[AgentLink] Missing origin context or runtime - cannot deliver relay`);
      return;
    }

    const { channel, to, accountId, sessionKey } = originCtx;

    logger.info(`[AgentLink] Relay targeting ${channel} session: ${sessionKey} (${to})`);

    // Use channel-specific delivery API
    await sendToChannel({
      channel,
      to,
      message: relayText,
      accountId,
      runtime,
      cfg: ocConfig,
      logger,
    });

    logger.info(`[AgentLink] Relay delivered to initiating session (from ${senderAgentId})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[AgentLink] Failed to relay to initiating session: ${msg}`);
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
  dataDir?: string,
): string {
  const contactLabel = envelope.from_name
    ? `${envelope.from_name} (${envelope.from})`
    : envelope.from;

  // Build prompt with context-aware framing
  const lines: string[] = [
    `[AgentLink] Message from ${contactLabel}:`,
    envelope.text ?? "(no message body)",
    "",
    "---",
  ];

  // Context-aware framing (based on message context)
  if (envelope.context === "tell") {
    lines.push(
      `This is an UPDATE or STATEMENT from ${contactLabel}.`,
      "No response is required unless you have questions or need clarification.",
      "",
    );
  } else {
    // Default: "ask" or undefined (treat as question)
    lines.push(
      `This is a QUESTION directed at you about your human.`,
      "Answer using your tools and knowledge (calendar, files, skills, etc.).",
      "Do NOT reach out to other agents or try to coordinate.",
      "When you've fully answered, end with [CONVERSATION_COMPLETE].",
      "",
    );
  }

  lines.push(
    `You are in an AgentLink conversation with ${contactLabel}.`,
    "Your text response will be captured and sent back automatically.",
    "IMPORTANT: Do NOT use the agentlink_message tool to reply in this conversation.",
    "Just respond with text. The system handles delivery.",
    "",
  );

  // Sharing policy from sharing.json (read per-message, no restart needed)
  if (dataDir) {
    const sharing = readSharing(dataDir);
    const allowed = getAllowedScopes(sharing, envelope.from);
    const askScopes = getAskScopes(sharing, envelope.from);
    const blocked = getBlockedScopes(sharing, envelope.from);

    lines.push(
      "SHARING POLICY (set by your human):",
      `You MAY share: ${formatScopeList(allowed) || "nothing"}.`,
    );
    if (askScopes.length) {
      lines.push(
        `ASK YOUR HUMAN FIRST before sharing: ${formatScopeList(askScopes)}.`,
        "Use the agentlink_ask_human tool — it will notify your human and wait for their decision.",
        "Tell the other agent you're checking with your human while you wait.",
      );
    }
    lines.push(
      `NEVER share: ${formatScopeList(blocked) || "nothing"}.`,
      `Full policy: ${dataDir}/sharing.json`,
      "",
    );
  } else {
    lines.push(
      "PRIVACY: If the other agent asks for personally identifiable information",
      "(home address, phone number, email, financial details, health info),",
      "do NOT share it. Politely decline: say your human prefers not to share that.",
      "Continue the conversation with what you can share.",
      "",
    );
  }

  lines.push(
    "Use ALL your tools (calendar, skills, exec, etc.) to give accurate answers.",
    "If a tool call fails, read the relevant skill file with the read tool (NOT exec) and retry.",
    "When using exec, run simple commands without shell redirects (no 2>/dev/null, no pipes, no ||).",
    "Do NOT fall back to guessing or memory when tools are available — use them.",
    "",
    "CONVERSATION FLOW: When the question has been fully answered and there is nothing",
    "more to discuss, end your response with [CONVERSATION_COMPLETE] on its own line.",
    "Do NOT continue with pleasantries like 'let me know if you need anything' or 'take care'.",
    "One clear answer, then [CONVERSATION_COMPLETE]. Do not use this marker if you are",
    "asking a follow-up question or expecting more information.",
  );

  if (a2aContext) {
    lines.push(
      `Exchange ${a2aContext.exchangeCount}/${a2aContext.maxExchanges} — conversation will pause at the limit for human review.`,
    );
  }

  return lines.join("\n");
}

/**
 * Format a "conversation paused" message (legacy, kept for tests).
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
    "Tell me to continue the conversation if you'd like me to keep going.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Consolidated summary + status prompts (for relay to main session)
// ---------------------------------------------------------------------------

export type SummaryTrigger = "silence" | "exchange_limit" | "no_response";

/**
 * Build the relay prompt for a consolidated A2A summary.
 * This text is injected into the main session so the LLM can synthesize
 * and present the result to the human (UX Section 1, Message 3).
 */
export function formatConsolidatedSummaryPrompt(
  contactAgentId: string,
  contactName: string | undefined,
  exchangeCount: number,
  logContents: string | null,
  trigger: SummaryTrigger,
): string {
  const label = contactName
    ? `${contactName}'s agent (${contactAgentId})`
    : contactAgentId;
  const displayName = contactName ?? "the other agent";

  if (trigger === "no_response") {
    const lines = [
      `[AgentLink] ${label} hasn't responded after 60 seconds — they may be offline.`,
    ];
    if (logContents && exchangeCount > 0) {
      lines.push("", "## Conversation so far:", logContents);
    }
    lines.push(
      "",
      "---",
      `Tell your human that ${displayName}'s agent isn't responding.`,
      "Offer alternatives: try again later, or reach out to them directly.",
      "Do NOT mention AgentLink, MQTT, agent IDs, or technical details.",
    );
    return lines.join("\n");
  }

  const header = trigger === "exchange_limit"
    ? `[AgentLink] Conversation with ${label} paused after ${exchangeCount} exchanges.`
    : `[AgentLink] Conversation with ${label} completed (${exchangeCount} exchanges).`;

  const lines = [header];
  if (logContents) {
    lines.push("", "## Full conversation:", logContents);
  }
  lines.push(
    "",
    "---",
    "Summarize the key findings for your human. Lead with the result, not the process.",
    "If there's a next action (booking, confirming, deciding), ask your human.",
    "Do NOT narrate the exchanges — synthesize the result.",
    "Do NOT mention AgentLink, MQTT, agent IDs, exchange counts, or technical details.",
  );

  if (trigger === "exchange_limit") {
    lines.push(
      "If the conversation didn't reach a conclusion, tell your human where things stand and ask what they want to do.",
    );
  }

  return lines.join("\n");
}

/**
 * Build a status update prompt for relay to the main session.
 * Injected at 15s and 45s after the human initiates an A2A conversation.
 */
export function formatStatusPrompt(
  contactAgentId: string,
  contactName: string | undefined,
  statusNumber: 1 | 2,
): string {
  const displayName = contactName ?? contactAgentId;

  if (statusNumber === 1) {
    return [
      `[AgentLink] Your conversation with ${displayName}'s agent is still in progress.`,
      "",
      "Give your human a brief, specific status update about what's happening. One sentence.",
      "Do NOT repeat the original message. Be specific about what the other agent is doing.",
      "Do NOT mention AgentLink, agent IDs, exchange counts, or technical details.",
    ].join("\n");
  }

  return [
    `[AgentLink] Your conversation with ${displayName}'s agent is taking longer than usual.`,
    "",
    "Give your human a second status update with different wording from the first.",
    "Be specific. One sentence. Optionally offer an alternative approach.",
    "Do NOT mention AgentLink, agent IDs, exchange counts, or technical details.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Handle incoming envelope: route to A2A session or process contact_exchange
// ---------------------------------------------------------------------------

/**
 * Handle an incoming message envelope:
 * 1. For "message" type: inject into A2A session (with outbound capture)
 * 2. For "contact_exchange" type: auto-add to contacts and send ack
 */
export function handleIncomingEnvelope(
  envelope: MessageEnvelope,
  config: AgentLinkConfig,
  contacts: ContactsStore,
  logger: Logger,
  injectToSession: (text: string, senderAgentId: string) => void,
  mqttClient?: MqttClient,
  channelApi?: ChannelApi,
  ocConfig?: Record<string, unknown>,
  invitations?: InvitationsStore,
  a2aManager?: A2ASessionManager,
  runtime?: any,
  channelTracker?: ChannelTracker,
): void {
  if (envelope.type === "contact_exchange") {
    if (envelope.ack) {
      // This is an acknowledgment — log confirmation
      logger.info(`[AgentLink] Connection confirmed with ${envelope.from_name} (${envelope.from})`);

      // Update contact with capabilities and agent name from ack
      const existingContact = contacts.findByAgentId(envelope.from);
      if (existingContact && (envelope.capabilities?.length || envelope.from_agent_name)) {
        contacts.add(
          existingContact.name,
          envelope.from,
          envelope.from_name,
          envelope.capabilities,
          envelope.from_agent_name,
        );
        logger.info(`[AgentLink] Updated ${envelope.from} with ack data`);
      }

      // Relay notification to the human's origin session (async relay for ack-timeout case)
      const originCtx = a2aManager?.getOriginContext(envelope.from);
      if (originCtx && channelApi && ocConfig && runtime) {
        const notificationText = `${envelope.from_name}'s agent has confirmed your connection. You can now message ${envelope.from_name}.`;
        relayToInitiatingSession(
          notificationText,
          envelope.from,
          envelope.from_name,
          config,
          channelApi,
          ocConfig,
          logger,
          originCtx,
          runtime,
        ).catch((err) => {
          logger.warn(`[AgentLink] Failed to relay connection confirmation: ${err}`);
        });
      } else {
        // No origin context — ack was already handled synchronously in the tool call
        logger.info(`[AgentLink] Ack from ${envelope.from} — no async relay needed (handled synchronously)`);
      }
      return;
    }

    // Not an ack — process contact_exchange and send ack back
    const existingContact = contacts.findByAgentId(envelope.from);
    if (!existingContact) {
      // Use agent name for contact name (e.g., "arya"), fall back to human name, then agent ID
      const name = envelope.from_agent_name?.toLowerCase()
        || envelope.from_name?.toLowerCase()
        || envelope.from;
      contacts.add(name, envelope.from, envelope.from_name, envelope.capabilities, envelope.from_agent_name);
      logger.info(`[AgentLink] New contact added: ${name} — ${envelope.from_name} (${envelope.from})`);

      // Update any matching sent invites to "accepted" status
      if (invitations) {
        const sent = invitations.getSent();
        const pendingInvite = sent.find(
          inv => inv.status === "pending" && !inv.accepted_by
        );
        if (pendingInvite) {
          invitations.updateSentStatus(pendingInvite.code, "accepted", envelope.from);
          logger.info(`[AgentLink] Marked invite ${pendingInvite.code} as accepted by ${envelope.from}`);
        }
      }

      // Trust-on-first-use: push notification to human's known channels
      const displayName = envelope.from_agent_name
        ? `${envelope.from_agent_name} (${envelope.from_name}'s agent)`
        : envelope.from_name || envelope.from;
      logger.info(`[AgentLink] Trust-on-first-use: ${displayName} connected. Saved as "${name}".`);

      if (channelTracker && channelApi && ocConfig && runtime) {
        pushNotification({
          message: `${displayName} just connected with you. They're now in your contacts as "${name}".`,
          config,
          channelTracker,
          channelApi,
          ocConfig,
          logger,
          runtime,
        }).catch((err) => {
          logger.warn(`[AgentLink] Failed to push connect notification: ${err}`);
        });
      }
    }

    // Send ack back to sender
    if (mqttClient) {
      const ackEnvelope = createEnvelope(
        "contact_exchange",
        config.agentId,
        config.humanName,
        envelope.from,
        undefined, // text
        undefined, // origin
        undefined, // context
        config.capabilities, // capabilities
        config.agentName, // fromAgentName
      );
      ackEnvelope.ack = true;
      const ackTopic = TOPICS.inbox(envelope.from, config.agentId);

      mqttClient.publish(ackTopic, JSON.stringify(ackEnvelope))
        .then(() => {
          logger.info(`[AgentLink] Sent ack to ${envelope.from}`);
        })
        .catch((err) => {
          logger.warn(`[AgentLink] Failed to send ack: ${err}`);
        });
    }
    return;
  }

  if (envelope.type === "message") {
    const formatted = formatInboundMessage(envelope, undefined, config.dataDir);
    injectToSession(formatted, envelope.from);
    return;
  }

  logger.warn(`[AgentLink] Unknown message type: ${envelope.type}`);
}
