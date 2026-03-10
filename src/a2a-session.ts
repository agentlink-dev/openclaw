import type { Logger } from "./mqtt-client.js";

// ---------------------------------------------------------------------------
// A2A Session Manager
// ---------------------------------------------------------------------------
// Tracks per-contact state for agent-to-agent conversations:
// - Exchange counts (loop prevention)
// - Pending relays (auto-relay response back to main session)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EXCHANGES = 20;

export interface A2ASessionManager {
  /** Record an exchange with a contact. Returns the new count. */
  recordExchange(contactAgentId: string): number;

  /** Get the current exchange count for a contact. */
  getExchangeCount(contactAgentId: string): number;

  /** Check if the conversation is paused (exchange limit reached). */
  isPaused(contactAgentId: string): boolean;

  /** Explicitly pause the conversation (e.g., after relay fires). */
  pause(contactAgentId: string): void;

  /** Reset exchange count (e.g., when human says "continue"). */
  reset(contactAgentId: string): void;

  /** Record that the human initiated an A2A via tool, with originating session context. */
  setOriginContext(contactAgentId: string, ctx: OriginContext): void;

  /** Get the originating session context for relay back to human. */
  getOriginContext(contactAgentId: string): OriginContext | undefined;

  /** Record timestamp of last exchange for silence timeout. */
  getLastExchangeTime(contactAgentId: string): number;
}

/** Context from the session where the human initiated the A2A conversation. */
export interface OriginContext {
  sessionKey: string;
  channel: string;
  agentId: string;
  timestamp: number;
}

export function createA2ASessionManager(
  logger: Logger,
  maxExchanges: number = DEFAULT_MAX_EXCHANGES,
): A2ASessionManager {
  const exchangeCounts = new Map<string, number>();
  const lastExchangeTimes = new Map<string, number>();
  const originContexts = new Map<string, OriginContext>();

  return {
    recordExchange(contactAgentId) {
      const count = (exchangeCounts.get(contactAgentId) ?? 0) + 1;
      exchangeCounts.set(contactAgentId, count);
      lastExchangeTimes.set(contactAgentId, Date.now());
      if (count >= maxExchanges) {
        logger.info(
          `[AgentLink] A2A exchange limit reached for ${contactAgentId} (${count}/${maxExchanges})`,
        );
      }
      return count;
    },

    getExchangeCount(contactAgentId) {
      return exchangeCounts.get(contactAgentId) ?? 0;
    },

    isPaused(contactAgentId) {
      return (exchangeCounts.get(contactAgentId) ?? 0) >= maxExchanges;
    },

    pause(contactAgentId) {
      exchangeCounts.set(contactAgentId, maxExchanges);
    },

    reset(contactAgentId) {
      exchangeCounts.set(contactAgentId, 0);
      logger.info(`[AgentLink] A2A exchange counter reset for ${contactAgentId}`);
    },

    setOriginContext(contactAgentId, ctx) {
      originContexts.set(contactAgentId, ctx);
    },

    getOriginContext(contactAgentId) {
      return originContexts.get(contactAgentId);
    },

    getLastExchangeTime(contactAgentId) {
      return lastExchangeTimes.get(contactAgentId) ?? 0;
    },
  };
}
