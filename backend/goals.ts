import { randomUUID } from "crypto";
import type { MemoryGraph } from "./memory/graph.js";
import type { GoalData, GoalOperation, WorkingGoalRef } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("goals");

// ── Goal Data Helpers ──

function parseGoalData(content: string): GoalData | null {
  try {
    const match = content.match(/\[GOAL_DATA\]([\s\S]*)\[\/GOAL_DATA\]/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function serializeGoalData(data: GoalData): string {
  return `${data.title}\n[GOAL_DATA]${JSON.stringify(data)}[/GOAL_DATA]`;
}

// ── Result type for applyGoalOps ──

export interface GoalOpsResult {
  applied: number;
  failed: number;
  errors: string[];
}

// ── GoalTracker ──

export class GoalTracker {
  constructor(private graph: MemoryGraph) {}

  /** Expose underlying graph for callers that need direct node access (e.g. tagging). */
  getGraph(): MemoryGraph { return this.graph; }

  getActiveGoals(): { nodeId: string; data: GoalData }[] {
    const goalNodes = this.graph.findByType("goal");
    const active: { nodeId: string; data: GoalData }[] = [];

    for (const node of goalNodes) {
      const data = parseGoalData(node.content);
      if (data && data.status === "active") {
        active.push({ nodeId: node.id, data });
      }
    }

    return active.sort((a, b) => {
      // Primary: priority (lower number = higher priority)
      const priDiff = a.data.priority - b.data.priority;
      if (priDiff !== 0) return priDiff;

      // Secondary: deadline (earlier first, no-deadline last)
      const aD = a.data.deadline ?? Infinity;
      const bD = b.data.deadline ?? Infinity;
      if (aD !== bD) return aD - bD;

      // Tertiary: nodeId for full determinism
      return a.nodeId.localeCompare(b.nodeId);
    });
  }

  checkDeadlines(): { nodeId: string; data: GoalData; status: "approaching" | "overdue" }[] {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const results: { nodeId: string; data: GoalData; status: "approaching" | "overdue" }[] = [];

    for (const { nodeId, data } of this.getActiveGoals()) {
      if (!data.deadline) continue;

      if (data.deadline < now) {
        results.push({ nodeId, data, status: "overdue" });
      } else if (data.deadline - now < DAY_MS) {
        results.push({ nodeId, data, status: "approaching" });
      }
    }

    return results;
  }

  applyGoalOps(ops: GoalOperation[]): GoalOpsResult {
    const result: GoalOpsResult = { applied: 0, failed: 0, errors: [] };

    for (const op of ops) {
      try {
        switch (op.op) {
          case "create_goal": {
            const id = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
            const data: GoalData = {
              title: op.title,
              description: op.description,
              status: "active",
              priority: op.priority,
              deadline: op.deadline,
              progress: 0,
              checkpoints: (op.checkpoints || []).map(label => ({ label, done: false })),
              createdBy: op.createdBy || "brain",
              lastCheckedAt: Date.now(),
            };
            this.graph.addNode({
              id,
              type: "goal",
              content: serializeGoalData(data),
              tags: ["goal", `priority-${op.priority}`, ...op.title.toLowerCase().split(/\s+/).slice(0, 3)],
              strength: 1.0,
              pinned: false,
              createdAt: Date.now(),
              lastAccessedAt: Date.now(),
              accessCount: 1,
            });
            log(`Created goal: ${op.title} (${id})`);
            result.applied++;
            break;
          }

          case "update_goal": {
            const node = this.graph.getNode(op.nodeId);
            if (!node) {
              const msg = `Goal node ${op.nodeId} not found`;
              log(msg);
              result.failed++;
              result.errors.push(`update_goal: ${msg}`);
              break;
            }
            const data = parseGoalData(node.content);
            if (!data) {
              const msg = `Could not parse goal data from ${op.nodeId}`;
              log(msg);
              result.failed++;
              result.errors.push(`update_goal: ${msg}`);
              break;
            }

            if (op.progress !== undefined) data.progress = Math.max(0, Math.min(100, op.progress));
            if (op.status !== undefined) data.status = op.status;
            if (op.checkpoints !== undefined) data.checkpoints = op.checkpoints;
            data.lastCheckedAt = Date.now();

            this.graph.updateNode(op.nodeId, { content: serializeGoalData(data) });
            this.graph.accessNode(op.nodeId);
            log(`Updated goal ${op.nodeId}: progress=${data.progress}%, status=${data.status}`);
            result.applied++;
            break;
          }

          case "complete_goal": {
            const node = this.graph.getNode(op.nodeId);
            if (!node) {
              const msg = `Goal node ${op.nodeId} not found for complete`;
              log(msg);
              result.failed++;
              result.errors.push(`complete_goal: ${msg}`);
              break;
            }
            const data = parseGoalData(node.content);
            if (!data) {
              const msg = `Could not parse goal data from ${op.nodeId} for complete`;
              log(msg);
              result.failed++;
              result.errors.push(`complete_goal: ${msg}`);
              break;
            }

            data.status = "completed";
            data.progress = 100;
            data.lastCheckedAt = Date.now();
            this.graph.updateNode(op.nodeId, { content: serializeGoalData(data) });
            log(`Completed goal: ${data.title} (${op.nodeId})`);
            result.applied++;
            break;
          }

          case "abandon_goal": {
            const node = this.graph.getNode(op.nodeId);
            if (!node) {
              const msg = `Goal node ${op.nodeId} not found for abandon`;
              log(msg);
              result.failed++;
              result.errors.push(`abandon_goal: ${msg}`);
              break;
            }
            const data = parseGoalData(node.content);
            if (!data) {
              const msg = `Could not parse goal data from ${op.nodeId} for abandon`;
              log(msg);
              result.failed++;
              result.errors.push(`abandon_goal: ${msg}`);
              break;
            }

            data.status = "abandoned";
            data.lastCheckedAt = Date.now();
            if (op.reason) data.reason = op.reason;
            this.graph.updateNode(op.nodeId, { content: serializeGoalData(data) });
            log(`Abandoned goal: ${data.title} (${op.nodeId})${op.reason ? ` Reason: ${op.reason}` : ""}`);
            result.applied++;
            break;
          }
        }
      } catch (err) {
        const msg = `Failed to apply goal op ${op.op}: ${err}`;
        log(msg);
        result.failed++;
        result.errors.push(msg);
      }
    }

    return result;
  }

  serializeForPrompt(): string {
    const goals = this.getActiveGoals();
    if (goals.length === 0) return "(no active goals)";

    return goals.map(({ nodeId, data }) => {
      const deadlineStr = data.deadline
        ? ` | deadline: ${new Date(data.deadline).toLocaleDateString()}`
        : "";
      const checkStr = data.checkpoints.length > 0
        ? `\n  Checkpoints: ${data.checkpoints.map(c => `${c.done ? "[x]" : "[ ]"} ${c.label}`).join(", ")}`
        : "";
      return `[${nodeId}] P${data.priority} "${data.title}" — ${data.progress}%${deadlineStr}${checkStr}\n  ${data.description.slice(0, 120)}`;
    }).join("\n\n");
  }

  getWorkingGoalRefs(): WorkingGoalRef[] {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    return this.getActiveGoals().map(({ nodeId, data }) => {
      let deadlineStatus: WorkingGoalRef["deadlineStatus"] = "none";
      if (data.deadline) {
        if (data.deadline < now) deadlineStatus = "overdue";
        else if (data.deadline - now < DAY_MS) deadlineStatus = "approaching";
        else deadlineStatus = "on_track";
      }

      return {
        nodeId,
        title: data.title,
        priority: data.priority,
        progress: data.progress,
        deadlineStatus,
      };
    });
  }
}
