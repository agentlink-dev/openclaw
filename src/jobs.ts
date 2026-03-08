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

/**
 * AgentLink doesn't execute tools — it routes job requests to the receiving
 * agent's OC session via llmDispatch. The OC session has all the tools it
 * needs (exec, gog, skills, etc.) and handles the question like a user message.
 */
export function createJobManager(
  config: AgentLinkConfig,
  state: StateManager,
  mqtt: MqttService,
  logger: Logger,
  llmDispatch?: (groupId: string, question: string, senderAgentId: string) => Promise<string>,
  onJobTimeout?: (groupId: string, correlationId: string) => void,
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
          onJobTimeout?.(params.groupId, correlationId);
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

      const question = msg.payload.text ?? `What can you tell me about: ${capability}?`;

      // Route to the agent's OC session — it handles tool execution locally
      if (llmDispatch) {
        logger.info(`[AgentLink] Job for '${capability}' — dispatching to OC session`);
        try {
          const result = await llmDispatch(msg.group_id, question, msg.from);
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
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`[AgentLink] Job dispatch failed for '${capability}': ${errMsg}`);
        }
      }

      // No dispatch available — fail
      const response = createEnvelope(config.agent.id, {
        group_id: msg.group_id,
        intent_id: msg.intent_id,
        to: msg.from,
        type: "job_response",
        correlation_id: msg.correlation_id,
        payload: {
          status: "failed",
          result: llmDispatch ? `Job '${capability}' failed` : "No agent session available",
          capability,
        },
      });
      await mqtt.publishEnvelope(TOPICS.groupMessages(msg.group_id, config.agent.id), response);
      return response;
    },
  };
}
