import fs from "node:fs";
import path from "node:path";
import type { GroupState, JobStatus, PendingJob, TimedOutJob } from "./types.js";

export interface StateManager {
  // Identity
  getAgentId(): string | null;

  // Pending joins (from CLI --join flag)
  getPendingJoins(): string[];
  removePendingJoin(code: string): void;

  // Groups
  addGroup(group: GroupState): void;
  getGroup(groupId: string): GroupState | null;
  removeGroup(groupId: string): void;
  getActiveGroups(): string[];
  updateGroup(groupId: string, updates: Partial<GroupState>): void;
  incrementIdleTurns(groupId: string): number;
  resetIdleTurns(groupId: string): void;

  // Participant capabilities (from MQTT status messages)
  updateParticipantCapabilities(groupId: string, agentId: string, capabilities: Array<{ name: string; description: string }>): void;
  getParticipantCapabilities(groupId: string, agentId: string): Array<{ name: string; description: string }> | null;

  // Jobs
  addJob(job: PendingJob): void;
  getJob(correlationId: string): PendingJob | null;
  completeJob(correlationId: string, status: JobStatus, result?: string): void;
  removeJob(correlationId: string): void;
  hasPendingJob(correlationId: string): boolean;
  getJobsForGroup(groupId: string): PendingJob[];
  checkTimeouts(timeoutMs: number): TimedOutJob[];
}

interface StateData {
  agent_id?: string;
  pending_joins?: string[];
  groups: Record<string, GroupState>;
  pending_jobs: Record<string, PendingJob>;
}

export function createState(dataDir: string): StateManager {
  const filePath = path.join(dataDir, "state.json");
  let data: StateData = {
    groups: {},
    pending_jobs: {},
  };

  if (fs.existsSync(filePath)) {
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    data = {
      ...data,
      ...loaded,
      groups: loaded.groups ?? data.groups,
      pending_jobs: loaded.pending_jobs ?? data.pending_jobs,
    };
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  return {
    getAgentId() {
      return data.agent_id ?? null;
    },

    getPendingJoins() {
      return data.pending_joins ? [...data.pending_joins] : [];
    },

    removePendingJoin(code) {
      if (data.pending_joins) {
        data.pending_joins = data.pending_joins.filter((c) => c !== code);
        save();
      }
    },

    addGroup(group) {
      data.groups[group.group_id] = group;
      save();
    },

    getGroup(groupId) {
      return data.groups[groupId] ?? null;
    },

    removeGroup(groupId) {
      delete data.groups[groupId];
      for (const [id, job] of Object.entries(data.pending_jobs)) {
        if (job.group_id === groupId) delete data.pending_jobs[id];
      }
      save();
    },

    getActiveGroups() {
      return Object.keys(data.groups).filter(
        (id) => data.groups[id].status === "active",
      );
    },

    updateGroup(groupId, updates) {
      if (data.groups[groupId]) {
        Object.assign(data.groups[groupId], updates);
        save();
      }
    },

    incrementIdleTurns(groupId) {
      const group = data.groups[groupId];
      if (!group) return 0;
      group.idle_turns++;
      save();
      return group.idle_turns;
    },

    resetIdleTurns(groupId) {
      if (data.groups[groupId]) {
        data.groups[groupId].idle_turns = 0;
        save();
      }
    },

    updateParticipantCapabilities(groupId, agentId, capabilities) {
      const group = data.groups[groupId];
      if (!group) return;
      if (!group.participant_capabilities) group.participant_capabilities = {};
      group.participant_capabilities[agentId] = capabilities;
      save();
    },

    getParticipantCapabilities(groupId, agentId) {
      return data.groups[groupId]?.participant_capabilities?.[agentId] ?? null;
    },

    addJob(job) {
      data.pending_jobs[job.correlation_id] = job;
      save();
    },

    getJob(correlationId) {
      return data.pending_jobs[correlationId] ?? null;
    },

    completeJob(correlationId, status) {
      const job = data.pending_jobs[correlationId];
      if (job) {
        job.status = status;
        save();
      }
    },

    removeJob(correlationId) {
      delete data.pending_jobs[correlationId];
      save();
    },

    hasPendingJob(correlationId) {
      const job = data.pending_jobs[correlationId];
      return !!job && job.status === "requested";
    },

    getJobsForGroup(groupId) {
      return Object.values(data.pending_jobs).filter((j) => j.group_id === groupId);
    },

    checkTimeouts(timeoutMs) {
      const now = Date.now();
      const timedOut: TimedOutJob[] = [];
      for (const job of Object.values(data.pending_jobs)) {
        if (job.status === "requested") {
          const elapsed = now - new Date(job.sent_at).getTime();
          if (elapsed > timeoutMs) {
            job.status = "failed";
            timedOut.push({ ...job, timed_out: true });
          }
        }
      }
      if (timedOut.length > 0) save();
      return timedOut;
    },
  };
}
