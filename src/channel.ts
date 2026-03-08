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
  dispatch(groupId: string, body: string, senderAgentId?: string): void;
  dispatchToMainSession(body: string): void;
  clearWatchdog(groupId: string): void;
  shutdown(): void;
}

const DEBOUNCE_MS = 1500;
const WATCHDOG_MS = 20_000; // re-dispatch if no activity for 20s

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

  function resetWatchdog(groupId: string) {
    const existing = watchdogTimers.get(groupId);
    if (existing) clearTimeout(existing);

    watchdogTimers.set(groupId, setTimeout(() => {
      watchdogTimers.delete(groupId);
      const group = state.getGroup(groupId);
      if (!group || group.driver !== config.agent.id) return;
      logger.info(`[AgentLink] Watchdog: group ${groupId.slice(0, 8)} idle for ${WATCHDOG_MS / 1000}s, nudging agent`);
      enqueueDispatch(groupId, () => doDispatch(groupId,
        `No response yet. Submit a job to move forward, or call agentlink_complete if the goal is met.`,
      ));
    }, WATCHDOG_MS));
  }

  // Debounce: coalesce rapid events per group into one inbound message
  const pendingEvents = new Map<string, Array<{ body: string; senderAgentId?: string }>>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleDebounced(groupId: string, body: string, senderAgentId?: string) {
    // Any inbound event resets the watchdog (activity detected)
    resetWatchdog(groupId);

    if (!pendingEvents.has(groupId)) pendingEvents.set(groupId, []);
    pendingEvents.get(groupId)!.push({ body, senderAgentId });

    const existing = debounceTimers.get(groupId);
    if (existing) clearTimeout(existing);

    debounceTimers.set(groupId, setTimeout(() => {
      const events = pendingEvents.get(groupId) ?? [];
      pendingEvents.delete(groupId);
      debounceTimers.delete(groupId);
      if (events.length === 0) return;

      const combined = events.length === 1
        ? events[0].body
        : events.map(e => e.body).join("\n\n");
      const lastSender = events.at(-1)?.senderAgentId;

      enqueueDispatch(groupId, () => doDispatch(groupId, combined, lastSender).then(() => {
        // Restart watchdog after dispatch completes (agent turn done, waiting for response)
        resetWatchdog(groupId);
      }));
    }, DEBOUNCE_MS));
  }

  // Core dispatch: build MsgContext, record session, dispatch to agent
  async function doDispatch(groupId: string, body: string, senderAgentId?: string) {
    const senderName = senderAgentId
      ? (contacts.getNameByAgentId(senderAgentId) ?? senderAgentId)
      : "system";

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
      const ctx = channelApi.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: body,
        SessionKey: route.sessionKey,
        From: `agentlink:${senderAgentId ?? "system"}`,
        To: `agentlink:${config.agent.id}`,
        Provider: "agentlink",
        Surface: "agentlink",
        OriginatingChannel: "agentlink",
        OriginatingTo: groupId,
        SenderName: senderName,
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
      await channelApi.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: ocConfig,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (info.kind !== "final") return;
            if (!payload.text) return;
            // Send agent's response to MQTT group as chat message
            const envelope = createEnvelope(config.agent.id, {
              group_id: groupId,
              to: "group",
              type: "chat",
              payload: { text: payload.text },
            });
            await mqtt.publishEnvelope(TOPICS.groupMessages(groupId, config.agent.id), envelope);
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
    dispatchToMainSession: scheduleMainSessionDispatch,
    clearWatchdog(groupId: string) {
      const timer = watchdogTimers.get(groupId);
      if (timer) { clearTimeout(timer); watchdogTimers.delete(groupId); }
    },
    shutdown() {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      for (const timer of watchdogTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      watchdogTimers.clear();
      pendingEvents.clear();
    },
  };
}
