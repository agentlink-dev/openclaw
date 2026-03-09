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

  /** Mark that we're expecting a response from this agent (for relay). */
  setPendingRelay(contactAgentId: string): void;

  /** Check and consume a pending relay. Returns true if there was one. */
  consumePendingRelay(contactAgentId: string): boolean;

  /** Check if there's a pending relay without consuming it. */
  hasPendingRelay(contactAgentId: string): boolean;
}

export function createA2ASessionManager(
  logger: Logger,
  maxExchanges: number = DEFAULT_MAX_EXCHANGES,
): A2ASessionManager {
  const exchangeCounts = new Map<string, number>();
  const pendingRelays = new Set<string>();

  return {
    recordExchange(contactAgentId) {
      const count = (exchangeCounts.get(contactAgentId) ?? 0) + 1;
      exchangeCounts.set(contactAgentId, count);
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
      logger.info(`[AgentLink] A2A conversation with ${contactAgentId} paused (relay fired)`);
    },

    reset(contactAgentId) {
      exchangeCounts.set(contactAgentId, 0);
      logger.info(`[AgentLink] A2A exchange counter reset for ${contactAgentId}`);
    },

    setPendingRelay(contactAgentId) {
      pendingRelays.add(contactAgentId);
    },

    consumePendingRelay(contactAgentId) {
      if (pendingRelays.has(contactAgentId)) {
        pendingRelays.delete(contactAgentId);
        return true;
      }
      return false;
    },

    hasPendingRelay(contactAgentId) {
      return pendingRelays.has(contactAgentId);
    },
  };
}
