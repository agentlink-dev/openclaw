import { v4 as uuid } from "uuid";
import type { AgentLinkConfig, MessageEnvelope } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { StateManager } from "./state.js";
import type { MqttService } from "./mqtt-service.js";
import type { Logger } from "./mqtt-client.js";

export interface SubmitJobParams {
  groupId: string;
  intentId: string;
  targetAgentId?: string;
  capability: string;
  text: string;
}

export interface JobManager {
  submitJob(params: SubmitJobParams): Promise<string>;
  handleJobResponse(msg: MessageEnvelope): void;
  handleJobRequest(msg: MessageEnvelope): Promise<MessageEnvelope | null>;
}

export function createJobManager(
  config: AgentLinkConfig,
  state: StateManager,
  mqtt: MqttService,
  logger: Logger,
  executeTool?: (toolId: string, input: string) => Promise<string>,
  llmFallback?: (groupId: string, question: string, senderAgentId: string) => Promise<string>,
): JobManager {
  return {
    async submitJob(params) {
      const correlationId = uuid();
      const envelope = createEnvelope(config.agent.id, {
        group_id: params.groupId,
        intent_id: params.intentId,
        to: params.targetAgentId ?? "group",
        type: "job_request",
        correlation_id: correlationId,
        payload: {
          text: params.text,
          capability: params.capability,
        },
      });

      state.addJob({
        correlation_id: correlationId,
        group_id: params.groupId,
        target: params.targetAgentId ?? "group",
        capability: params.capability,
        status: "requested",
        sent_at: envelope.ts,
        text: params.text,
      });

      await mqtt.publishEnvelope(
        TOPICS.groupMessages(params.groupId, config.agent.id),
        envelope,
      );

      // Start timeout timer
      setTimeout(() => {
        if (state.hasPendingJob(correlationId)) {
          state.completeJob(correlationId, "failed");
          logger.info(`[AgentLink] Job ${correlationId} timed out (${params.capability})`);
        }
      }, config.jobTimeoutMs);

      return correlationId;
    },

    handleJobResponse(msg) {
      if (!msg.correlation_id) return;
      const job = state.getJob(msg.correlation_id);
      if (!job) return;

      const status = msg.payload.status ?? "completed";
      state.completeJob(msg.correlation_id, status);
      logger.info(
        `[AgentLink] Job ${msg.correlation_id} ${status}: ${msg.payload.result ?? "(no result)"}`,
      );
    },

    async handleJobRequest(msg) {
      const capability = msg.payload.capability;
      if (!capability) return null;

      // Fuzzy match: "check_calendar" matches "calendar" (substring)
      const reqLower = capability.toLowerCase();
      const cap = config.agent.capabilities.find((c) => {
        const n = c.name.toLowerCase();
        return n === reqLower || reqLower.includes(n) || n.includes(reqLower);
      });
      if (!cap) {
        // No matching capability — try LLM fallback (dispatches to agent's LLM)
        if (llmFallback) {
          logger.info(`[AgentLink] No capability '${capability}' — falling back to LLM`);
          try {
            const result = await llmFallback(
              msg.group_id,
              msg.payload.text ?? `What can you tell me about: ${capability}?`,
              msg.from,
            );
            const response = createEnvelope(config.agent.id, {
              group_id: msg.group_id,
              intent_id: msg.intent_id,
              to: msg.from,
              type: "job_response",
              correlation_id: msg.correlation_id,
              payload: {
                status: "completed",
                result,
                capability,
              },
            });
            await mqtt.publishEnvelope(
              TOPICS.groupMessages(msg.group_id, config.agent.id),
              response,
            );
            return response;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn(`[AgentLink] LLM fallback failed: ${errMsg}`);
            // Fall through to standard failure response
          }
        }

        const response = createEnvelope(config.agent.id, {
          group_id: msg.group_id,
          intent_id: msg.intent_id,
          to: msg.from,
          type: "job_response",
          correlation_id: msg.correlation_id,
          payload: {
            status: "failed",
            result: `Capability '${capability}' not available`,
            capability,
          },
        });
        await mqtt.publishEnvelope(
          TOPICS.groupMessages(msg.group_id, config.agent.id),
          response,
        );
        return response;
      }

      // Try direct tool execution first; fall back to LLM if unavailable
      if (executeTool) {
        logger.info(`[AgentLink] Running local tool: ${cap.tool} for capability: ${capability}`);
        try {
          const result = await executeTool(cap.tool, msg.payload.text ?? "");
          const response = createEnvelope(config.agent.id, {
            group_id: msg.group_id,
            intent_id: msg.intent_id,
            to: msg.from,
            type: "job_response",
            correlation_id: msg.correlation_id,
            payload: { status: "completed", result, capability },
          });
          await mqtt.publishEnvelope(TOPICS.groupMessages(msg.group_id, config.agent.id), response);
          return response;
        } catch (err) {
          logger.warn(`[AgentLink] executeTool failed for '${capability}': ${err instanceof Error ? err.message : err}`);
          // Fall through to LLM fallback
        }
      }

      // LLM fallback — the agent's LLM has access to OC tools (exec, etc.)
      if (llmFallback) {
        logger.info(`[AgentLink] Using LLM fallback for capability '${capability}'`);
        try {
          const result = await llmFallback(
            msg.group_id,
            msg.payload.text ?? `What can you tell me about: ${capability}?`,
            msg.from,
          );
          const response = createEnvelope(config.agent.id, {
            group_id: msg.group_id,
            intent_id: msg.intent_id,
            to: msg.from,
            type: "job_response",
            correlation_id: msg.correlation_id,
            payload: { status: "completed", result, capability },
          });
          await mqtt.publishEnvelope(TOPICS.groupMessages(msg.group_id, config.agent.id), response);
          return response;
        } catch (err) {
          logger.warn(`[AgentLink] LLM fallback failed for '${capability}': ${err instanceof Error ? err.message : err}`);
        }
      }

      // Both paths failed
      const response = createEnvelope(config.agent.id, {
        group_id: msg.group_id,
        intent_id: msg.intent_id,
        to: msg.from,
        type: "job_response",
        correlation_id: msg.correlation_id,
        payload: {
          status: "failed",
          result: `Capability '${capability}' execution failed`,
          capability,
        },
      });
      await mqtt.publishEnvelope(TOPICS.groupMessages(msg.group_id, config.agent.id), response);
      return response;
    },
  };
}
