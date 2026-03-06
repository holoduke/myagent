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

// ── GoalTracker ──

export class GoalTracker {
  constructor(private graph: MemoryGraph) {}

  getActiveGoals(): { nodeId: string; data: GoalData }[] {
    const goalNodes = this.graph.findByType("goal");
    const active: { nodeId: string; data: GoalData }[] = [];

    for (const node of goalNodes) {
      const data = parseGoalData(node.content);
      if (data && data.status === "active") {
        active.push({ nodeId: node.id, data });
      }
    }

    return active.sort((a, b) => a.data.priority - b.data.priority);
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

  applyGoalOps(ops: GoalOperation[]): void {
    for (const op of ops) {
      try {
        switch (op.op) {
          case "create_goal": {
            const id = `n_${Math.random().toString(16).slice(2, 10)}`;
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
            break;
          }

          case "update_goal": {
            const node = this.graph.getNode(op.nodeId);
            if (!node) { log(`Goal node ${op.nodeId} not found`); break; }
            const data = parseGoalData(node.content);
            if (!data) { log(`Could not parse goal data from ${op.nodeId}`); break; }

            if (op.progress !== undefined) data.progress = op.progress;
            if (op.status !== undefined) data.status = op.status;
            if (op.checkpoints !== undefined) data.checkpoints = op.checkpoints;
            data.lastCheckedAt = Date.now();

            this.graph.updateNode(op.nodeId, { content: serializeGoalData(data) });
            this.graph.accessNode(op.nodeId);
            log(`Updated goal ${op.nodeId}: progress=${data.progress}%, status=${data.status}`);
            break;
          }

          case "complete_goal": {
            const node = this.graph.getNode(op.nodeId);
            if (!node) break;
            const data = parseGoalData(node.content);
            if (!data) break;

            data.status = "completed";
            data.progress = 100;
            data.lastCheckedAt = Date.now();
            this.graph.updateNode(op.nodeId, { content: serializeGoalData(data) });
            log(`Completed goal: ${data.title} (${op.nodeId})`);
            break;
          }

          case "abandon_goal": {
            const node = this.graph.getNode(op.nodeId);
            if (!node) break;
            const data = parseGoalData(node.content);
            if (!data) break;

            data.status = "abandoned";
            data.lastCheckedAt = Date.now();
            const reason = op.reason ? ` Reason: ${op.reason}` : "";
            this.graph.updateNode(op.nodeId, { content: serializeGoalData(data) + reason });
            log(`Abandoned goal: ${data.title} (${op.nodeId})${reason}`);
            break;
          }
        }
      } catch (err) {
        log(`Failed to apply goal op ${op.op}: ${err}`);
      }
    }
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
