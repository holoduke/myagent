/**
 * Next-Scene Prediction (Research: MemOS, 2025)
 *
 * At the end of each think tick, predicts what the next likely context will be
 * (based on calendar events, time of day, recent conversation topics) and
 * pre-stages relevant memory node IDs in working memory.
 *
 * This means the next think tick starts with a "warm" context, reducing
 * retrieval latency and improving relevance.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode, WorkingMemory } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("scene-predictor");

// ── Types ──

export interface ScenePrediction {
  /** Predicted context topics */
  topics: string[];
  /** Pre-staged node IDs */
  stagedNodeIds: string[];
  /** Reasoning for the prediction */
  reasoning: string;
  /** Prediction confidence */
  confidence: number;
}

// ── Scene Prediction ──

/**
 * Predict the next likely context and pre-stage relevant memory nodes.
 */
export function predictNextScene(
  graph: MemoryGraph,
  wm: WorkingMemory,
): ScenePrediction {
  const topics: string[] = [];
  const stagedNodeIds: string[] = [];
  const reasons: string[] = [];

  // Signal 1: Upcoming calendar events (stored as string[] in working memory)
  const upcomingEvents = wm.temporal?.upcomingEvents ?? [];
  if (upcomingEvents.length > 0) {
    const nextEvent = upcomingEvents[0];
    topics.push(nextEvent.toLowerCase());
    reasons.push("upcoming calendar event");

    // Find person/event nodes related to the event
    const eventKeywords = nextEvent.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    for (const keyword of eventKeywords.slice(0, 3)) {
      for (const node of graph.findByType("person")) {
        if (node.content.toLowerCase().includes(keyword)) {
          stagedNodeIds.push(node.id);
        }
      }
    }
  }

  // Signal 2: Active conversations (from working memory)
  const activeThreads = wm.conversationThreads ?? [];
  for (const thread of activeThreads.slice(0, 2)) {
    if (thread.status === "active") {
      topics.push(thread.topic?.toLowerCase() ?? "conversation");
      reasons.push("active conversation thread");

      // Stage participant person nodes
      for (const participant of thread.participants ?? []) {
        const personNodes = graph.findByType("person")
          .filter(p => p.content.toLowerCase().includes(participant.toLowerCase()));
        for (const p of personNodes.slice(0, 1)) {
          stagedNodeIds.push(p.id);
        }
      }
    }
  }

  // Signal 3: Pending follow-ups due soon
  const now = Date.now();
  const SOON = 4 * 3600_000; // 4 hours
  for (const fu of wm.pendingFollowUps ?? []) {
    if (fu.potentiallyResolved) continue;
    if (fu.dueAt && fu.dueAt - now < SOON && fu.dueAt > now) {
      topics.push(fu.question?.toLowerCase().slice(0, 30) ?? "follow-up");
      reasons.push("follow-up due soon");

      // Stage related person nodes
      if (fu.targetPerson) {
        const personNodes = graph.findByType("person")
          .filter(p => p.content.toLowerCase().includes(fu.targetPerson!.toLowerCase()));
        for (const p of personNodes.slice(0, 1)) {
          stagedNodeIds.push(p.id);
        }
      }
    }
  }

  // Signal 4: Time-based context (morning → schedule, evening → recap)
  const hour = new Date().getHours();
  if (hour >= 7 && hour <= 9) {
    topics.push("morning routine");
    reasons.push("morning time window");
    // Stage goal nodes for morning planning
    for (const goalNode of graph.findByType("goal").slice(0, 3)) {
      stagedNodeIds.push(goalNode.id);
    }
  } else if (hour >= 18 && hour <= 20) {
    topics.push("evening recap");
    reasons.push("evening time window");
    // Stage recent event nodes for recap
    const recentEvents = graph.findByType("event")
      .filter(n => now - n.createdAt < 12 * 3600_000)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    for (const event of recentEvents) {
      stagedNodeIds.push(event.id);
    }
  }

  // Signal 5: Active goals approaching deadlines
  for (const goalRef of wm.activeGoals ?? []) {
    if (goalRef.deadlineStatus === "approaching" || goalRef.deadlineStatus === "overdue") {
      topics.push(`goal: ${goalRef.title?.slice(0, 20) ?? "approaching deadline"}`);
      reasons.push("goal deadline approaching");
    }
  }

  // Deduplicate staged node IDs
  const uniqueStaged = [...new Set(stagedNodeIds)].slice(0, 15);

  const confidence = Math.min(1, topics.length * 0.2 + uniqueStaged.length * 0.05);

  if (uniqueStaged.length > 0) {
    log(`Scene prediction: ${topics.length} topics, ${uniqueStaged.length} nodes pre-staged (${reasons.join(", ")})`);
  }

  return {
    topics,
    stagedNodeIds: uniqueStaged,
    reasoning: reasons.join("; "),
    confidence,
  };
}

/**
 * Apply scene prediction: inject pre-staged node IDs into working memory
 * so they're available for the next think tick's context selection.
 */
export function applyScenePrediction(wm: WorkingMemory, prediction: ScenePrediction): void {
  if (prediction.stagedNodeIds.length === 0) return;

  // Merge predicted node IDs into activatedNodeIds (deduplicate)
  const existing = new Set(wm.activatedNodeIds ?? []);
  for (const id of prediction.stagedNodeIds) {
    existing.add(id);
  }

  // Keep bounded
  wm.activatedNodeIds = [...existing].slice(0, 20);
}
