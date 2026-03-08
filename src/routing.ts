import type { MessageEnvelope, AgentStatus, Capability } from "./types.js";

export interface Router {
  resolveTarget(msg: MessageEnvelope, groupParticipants: AgentStatus[]): string[];
}

export function createRouter(): Router {
  return {
    resolveTarget(msg, groupParticipants) {
      // Rule 1: Explicit target — route directly
      if (msg.to !== "group") {
        return [msg.to];
      }

      // Rule 2: Capability match — filter by capability (fuzzy: substring match)
      if (msg.payload.capability) {
        const requested = msg.payload.capability.toLowerCase();
        return groupParticipants
          .filter((p) => p.agent_id !== msg.from)
          .filter((p) => p.capabilities.some((c) => {
            const name = c.name.toLowerCase();
            return name === requested || requested.includes(name) || name.includes(requested);
          }))
          .map((p) => p.agent_id);
      }

      // Rule 3: No capability — broadcast to all except sender
      return groupParticipants
        .filter((p) => p.agent_id !== msg.from)
        .map((p) => p.agent_id);
    },
  };
}

/**
 * Receiver-side: should this agent process the incoming message?
 */
export function shouldProcess(
  msg: MessageEnvelope,
  myAgentId: string,
  myCapabilities: Capability[],
): boolean {
  // Always process if addressed to us directly
  if (msg.to === myAgentId) return true;

  // If broadcast with capability filter: process if we have the capability
  // OR if we have no capabilities at all (LLM fallback mode — accept everything)
  // Uses fuzzy matching: "check_calendar" matches "calendar" (substring or keyword overlap)
  if (msg.to === "group" && msg.payload.capability) {
    if (myCapabilities.length === 0) return true;
    const requested = msg.payload.capability.toLowerCase();
    return myCapabilities.some((c) => {
      const name = c.name.toLowerCase();
      return name === requested || requested.includes(name) || name.includes(requested);
    });
  }

  // Broadcast without capability: process (group coordination)
  if (msg.to === "group") return true;

  // Addressed to someone else
  return false;
}
