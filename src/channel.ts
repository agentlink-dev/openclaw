import type { AgentLinkConfig } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { StateManager } from "./state.js";
import type { ContactsManager } from "./contacts.js";
import type { MqttService } from "./mqtt-service.js";
import type { Logger } from "./mqtt-client.js";

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
        onReplyStart?: () => Promise<void> | void;
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
    }): { agentId: string; sessionKey: string; channel: string; accountId: string };
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ChannelPlugin {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    blurb: string;
    aliases: string[];
  };
  capabilities: {
    chatTypes: string[];
  };
  config: {
    listAccountIds: () => string[];
    resolveAccount: () => { accountId: string; enabled: boolean; configured: boolean };
  };
  outbound: {
    deliveryMode: string;
    sendText: (params: {
      text: string;
      threadId?: string;
      channelId?: string;
    }) => Promise<{ ok: boolean; error?: string }>;
  };
}

export function createChannelPlugin(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  mqtt: MqttService,
  logger: Logger,
): ChannelPlugin {
  return {
    id: "agentlink",
    meta: {
      id: "agentlink",
      label: "AgentLink",
      selectionLabel: "AgentLink (Agent Coordination)",
      blurb: "Agent-to-agent coordination channel",
      aliases: ["al"],
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      listAccountIds: () => [config.agent.id],
      resolveAccount: () => ({
        accountId: config.agent.id,
        enabled: true,
        configured: true,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      async sendText({ text, threadId, channelId }) {
        if (!threadId) return { ok: false, error: "No group context" };

        const group = state.getGroup(threadId);
        if (!group) return { ok: false, error: "Group not found" };

        const envelope = createEnvelope(config.agent.id, {
          group_id: threadId,
          intent_id: group.intent_id,
          to: channelId ?? "group",
          type: "chat",
          payload: { text },
        });

        await mqtt.publishEnvelope(
          TOPICS.groupMessages(threadId, config.agent.id),
          envelope,
        );

        // Track idle turns for anti-deadlock (chat without job/proposal increments)
        if (group.driver === config.agent.id) {
          state.incrementIdleTurns(threadId);
        }

        return { ok: true };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Channel Inbound — wakes the agent when MQTT events arrive
// ---------------------------------------------------------------------------

export interface ChannelInbound {
  /** Dispatch an event to the agent. body = user-visible, agentBody = LLM-visible (defaults to body). */
  dispatch(groupId: string, body: string, senderAgentId?: string, agentBody?: string): void;
  /** Dispatch and capture the agent's text response (for LLM fallback on job requests). */
  dispatchAndCapture(groupId: string, body: string, senderAgentId?: string, agentBody?: string): Promise<string>;
  dispatchToMainSession(body: string): void;
  clearWatchdog(groupId: string): void;
  shutdown(): void;
}

const DEBOUNCE_MS = 1500;
const WATCHDOG_MS = 300_000; // safety net: 5 minutes of total silence before nudge
const MAX_NUDGES = 1; // single nudge then auto-complete (safety net only)

export function createChannelInbound(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  mqtt: MqttService,
  channelApi: ChannelApi,
  ocConfig: Record<string, unknown>,
  logger: Logger,
): ChannelInbound {
  // Per-group dispatch queue: serializes dispatches to prevent concurrent agent turns
  const dispatchQueues = new Map<string, Promise<void>>();

  function enqueueDispatch(groupId: string, fn: () => Promise<void>): void {
    const prev = dispatchQueues.get(groupId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // always continue even if previous failed
    dispatchQueues.set(groupId, next);
  }

  // Watchdog: re-dispatch if a group goes idle (agent sent chat but no job → no response)
  const watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const nudgeCounts = new Map<string, number>();

  function resetWatchdog(groupId: string) {
    const existing = watchdogTimers.get(groupId);
    if (existing) clearTimeout(existing);

    watchdogTimers.set(groupId, setTimeout(() => {
      watchdogTimers.delete(groupId);
      const group = state.getGroup(groupId);
      if (!group || group.driver !== config.agent.id) return;

      const nudgeCount = (nudgeCounts.get(groupId) ?? 0) + 1;
      nudgeCounts.set(groupId, nudgeCount);
      logger.info(`[AgentLink] Watchdog: group ${groupId.slice(0, 8)} idle ${WATCHDOG_MS / 1000}s, nudge #${nudgeCount}`);

      if (nudgeCount >= MAX_NUDGES) {
        // Safety net auto-complete after prolonged silence
        logger.info(`[AgentLink] Auto-completing group ${groupId.slice(0, 8)} after ${WATCHDOG_MS / 1000}s silence`);
        nudgeCounts.delete(groupId);
        enqueueDispatch(groupId, () => doDispatch(groupId, "",
          undefined,
          `[System] Coordination timed out (no activity for ${WATCHDOG_MS / 1000}s). Summarize what you have and call agentlink_complete.`,
        ));
        return;
      }

      // Nudge — just remind the agent to wrap up
      enqueueDispatch(groupId, () => doDispatch(groupId, "", undefined,
        `[System] No activity for ${WATCHDOG_MS / 1000}s. If you're waiting for participants, they may be offline. Call agentlink_complete with what you have, or submit any remaining jobs.`));
    }, WATCHDOG_MS));
  }

  // Debounce: coalesce rapid events per group into one inbound message
  const pendingEvents = new Map<string, Array<{ body: string; senderAgentId?: string; agentBody?: string }>>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleDebounced(groupId: string, body: string, senderAgentId?: string, agentBody?: string) {
    // Any inbound event resets the watchdog (activity detected)
    resetWatchdog(groupId);

    if (!pendingEvents.has(groupId)) pendingEvents.set(groupId, []);
    pendingEvents.get(groupId)!.push({ body, senderAgentId, agentBody });

    const existing = debounceTimers.get(groupId);
    if (existing) clearTimeout(existing);

    debounceTimers.set(groupId, setTimeout(() => {
      const events = pendingEvents.get(groupId) ?? [];
      pendingEvents.delete(groupId);
      debounceTimers.delete(groupId);
      if (events.length === 0) return;

      // User-visible body: only include non-empty bodies (skip system events)
      const visibleBodies = events.map(e => e.body).filter(b => b.length > 0);
      const combinedBody = visibleBodies.join("\n\n");

      // Agent-visible body: include everything (agentBody fallback to body)
      const combinedAgent = events.map(e => e.agentBody ?? e.body).join("\n\n");
      const lastSender = events.at(-1)?.senderAgentId;

      enqueueDispatch(groupId, () => doDispatch(groupId, combinedBody, lastSender, combinedAgent).then(() => {
        // Restart watchdog after dispatch completes (agent turn done, waiting for response)
        resetWatchdog(groupId);
      }));
    }, DEBOUNCE_MS));
  }

  // Enqueue with a result (for dispatchAndCapture — needs the return value)
  function enqueueDispatchWithResult(groupId: string, fn: () => Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const prev = dispatchQueues.get(groupId) ?? Promise.resolve();
      const next = prev.then(
        () => fn().then(resolve, reject),
        () => fn().then(resolve, reject),
      );
      // Store void-ified promise in queue so subsequent dispatches chain correctly
      dispatchQueues.set(groupId, next.then(() => {}, () => {}));
    });
  }

  // Core dispatch: build MsgContext, record session, dispatch to agent
  async function doDispatch(groupId: string, body: string, senderAgentId?: string, agentBody?: string) {
    const senderName = senderAgentId
      ? (contacts.getNameByAgentId(senderAgentId) ?? senderAgentId)
      : "system";

    // Use group goal as session label (shown in OC sidebar)
    const group = state.getGroup(groupId);
    const sessionLabel = group?.goal ?? `Group ${groupId.slice(0, 8)}`;

    logger.info(`[AgentLink] doDispatch: group=${groupId.slice(0, 8)}, from=${senderName}, body=${body.slice(0, 80)}...`);

    try {
      // 1. Resolve route → session key
      const route = channelApi.routing.resolveAgentRoute({
        cfg: ocConfig,
        channel: "agentlink",
        accountId: config.agent.id,
        peer: { kind: "group", id: groupId },
      });

      // 2. Build + finalize inbound context
      // Body = user-visible (shown in chat UI). Empty string hides the "You" bubble.
      // BodyForAgent = what the LLM sees (may include system context invisible to user).
      const ctx = channelApi.reply.finalizeInboundContext({
        Body: body || " ",
        BodyForAgent: agentBody ?? body,
        SessionKey: route.sessionKey,
        From: `agentlink:${senderAgentId ?? "system"}`,
        To: `agentlink:${config.agent.id}`,
        Provider: "agentlink",
        Surface: "agentlink",
        OriginatingChannel: "agentlink",
        OriginatingTo: groupId,
        SenderName: sessionLabel,
        SenderId: senderAgentId ?? "system",
        ChatType: "group",
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

      // 4. Dispatch — agent wakes up and processes the event
      // NOTE: We intentionally do NOT send the agent's text response to MQTT.
      // The agent coordinates via tool calls (submit_job, complete), not chat.
      // This prevents narration/filler text from flooding the group channel.
      await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: ocConfig,
        dispatcherOptions: {
          deliver: async (_payload, _info) => {
            // Agent's text appears in OC chat UI but is NOT relayed to MQTT group.
            // Coordination happens via agentlink_submit_job and agentlink_complete tools.
          },
          onError: (err, info) => {
            logger.warn(`[AgentLink] dispatch ${info.kind} error for group ${groupId}: ${err}`);
          },
        },
        replyOptions: { disableBlockStreaming: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[AgentLink] dispatch failed for group ${groupId}: ${msg}`);
    }
  }

  // Dispatch and capture: like doDispatch but collects the agent's text response
  async function doDispatchAndCapture(groupId: string, body: string, senderAgentId?: string, agentBody?: string): Promise<string> {
    const senderName = senderAgentId
      ? (contacts.getNameByAgentId(senderAgentId) ?? senderAgentId)
      : "system";

    const group = state.getGroup(groupId);
    const sessionLabel = group?.goal ?? `Group ${groupId.slice(0, 8)}`;

    logger.info(`[AgentLink] dispatchAndCapture: group=${groupId.slice(0, 8)}, from=${senderName}, body=${(agentBody ?? body).slice(0, 80)}...`);

    const collectedText: string[] = [];

    try {
      const route = channelApi.routing.resolveAgentRoute({
        cfg: ocConfig,
        channel: "agentlink",
        accountId: config.agent.id,
        peer: { kind: "group", id: groupId },
      });

      const ctx = channelApi.reply.finalizeInboundContext({
        Body: body || " ",
        BodyForAgent: agentBody ?? body,
        SessionKey: route.sessionKey,
        From: `agentlink:${senderAgentId ?? "system"}`,
        To: `agentlink:${config.agent.id}`,
        Provider: "agentlink",
        Surface: "agentlink",
        OriginatingChannel: "agentlink",
        OriginatingTo: groupId,
        SenderName: sessionLabel,
        SenderId: senderAgentId ?? "system",
        ChatType: "group",
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
        onRecordError: (err) => logger.warn(`[AgentLink] recordInboundSession error: ${err}`),
      });

      await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: ocConfig,
        dispatcherOptions: {
          deliver: async (payload, _info) => {
            // Capture non-reasoning, non-error text from the agent's response
            if (payload.text && !payload.isReasoning && !payload.isError) {
              collectedText.push(payload.text);
            }
          },
          onError: (err, info) => {
            logger.warn(`[AgentLink] dispatchAndCapture ${info.kind} error for group ${groupId}: ${err}`);
          },
        },
        replyOptions: { disableBlockStreaming: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[AgentLink] dispatchAndCapture failed for group ${groupId}: ${msg}`);
      return `Error: ${msg}`;
    }

    return collectedText.join("") || "(no response)";
  }

  // Dispatch to the main/webchat session (for completion callbacks)
  async function doDispatchToMainSession(body: string) {
    try {
      // Resolve the webchat main session
      const route = channelApi.routing.resolveAgentRoute({
        cfg: ocConfig,
        channel: "webchat",
        accountId: config.agent.id,
      });

      // Use webchat as provider/channel so we don't overwrite the main session's metadata
      const ctx = channelApi.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: body,
        SessionKey: route.sessionKey,
        From: `webchat:user`,
        To: `webchat:${config.agent.id}`,
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: config.agent.id,
        SenderName: "Main Session",
        SenderId: "user",
        ChatType: "direct",
        CommandAuthorized: true,
        Timestamp: Date.now(),
      });

      // Skip recordInboundSession to avoid overwriting main session metadata
      await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: ocConfig,
        dispatcherOptions: {
          deliver: async (_payload, _info) => {
            // Main session delivery is handled by OC's webchat — no MQTT needed
          },
          onError: (err, info) => {
            logger.warn(`[AgentLink] main session dispatch ${info.kind} error: ${err}`);
          },
        },
        replyOptions: { disableBlockStreaming: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[AgentLink] main session dispatch failed: ${msg}`);
    }
  }

  // Main session dispatch queue (separate from per-group queues)
  let mainSessionQueue: Promise<void> = Promise.resolve();

  function scheduleMainSessionDispatch(body: string) {
    mainSessionQueue = mainSessionQueue.then(
      () => doDispatchToMainSession(body),
      () => doDispatchToMainSession(body),
    );
  }

  return {
    dispatch: scheduleDebounced,
    dispatchAndCapture(groupId: string, body: string, senderAgentId?: string, agentBody?: string): Promise<string> {
      // No debounce — job responses need immediate dispatch.
      // Uses per-group queue for serialization.
      return enqueueDispatchWithResult(groupId, () => doDispatchAndCapture(groupId, body, senderAgentId, agentBody));
    },
    dispatchToMainSession: scheduleMainSessionDispatch,
    clearWatchdog(groupId: string) {
      const timer = watchdogTimers.get(groupId);
      if (timer) { clearTimeout(timer); watchdogTimers.delete(groupId); }
      nudgeCounts.delete(groupId);
    },
    shutdown() {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      for (const timer of watchdogTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      watchdogTimers.clear();
      pendingEvents.clear();
      nudgeCounts.clear();
    },
  };
}
