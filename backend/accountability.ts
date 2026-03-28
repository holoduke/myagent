/**
 * General-purpose accountability layer.
 *
 * Scans ALL outgoing content for commitments — Moltbook, WhatsApp, email,
 * brain-generated messages. Detects commitment language, classifies by weight,
 * and auto-creates goals for notable+ commitments via GoalTracker.
 *
 * Nothing ARIA says escapes unnoticed. Trivial stuff gets ignored.
 * Real promises get tracked and reviewed every 6 hours during reflect.
 */

import { extractAndClassifyCommitments } from "./commitments.js";
import type { ClassifiedCommitment } from "./commitments.js";
import { GoalTracker } from "./goals.js";
import { createLogger } from "./logger.js";

const log = createLogger("accountability");

/** Metadata about where a commitment was made */
export interface CommitmentContext {
  /** Source channel: whatsapp, gmail, moltbook, brain, slack */
  source: string;
  /** Who it was said to (person, group, or 'public') */
  audience: string;
  /** When the commitment was detected */
  detectedAt: number;
}

/** A commitment with full context, ready for goal creation */
export interface TrackedCommitment {
  classified: ClassifiedCommitment;
  context: CommitmentContext;
}

/**
 * Scan text for commitments and return classified, non-trivial ones
 * along with the provided context.
 */
export function scanForCommitments(
  text: string,
  context: CommitmentContext,
): TrackedCommitment[] {
  const classified = extractAndClassifyCommitments(text);
  return classified.map(c => ({ classified: c, context }));
}

/**
 * Check if a commitment roughly matches an existing active goal title.
 * Uses simple word-overlap fuzzy matching.
 */
function fuzzyMatchesGoal(commitmentText: string, goalTitle: string): boolean {
  const commitWords = new Set(
    commitmentText.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3),
  );
  const goalWords = goalTitle.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3);

  if (goalWords.length === 0 || commitWords.size === 0) return false;

  let overlap = 0;
  for (const w of goalWords) {
    if (commitWords.has(w)) overlap++;
  }

  // Match if >40% of goal words appear in commitment
  return overlap / goalWords.length > 0.4;
}

/**
 * Process detected commitments: check against existing goals, auto-create
 * new goals for untracked notable+ commitments.
 *
 * Returns the number of new goals created.
 */
export function processCommitments(
  commitments: TrackedCommitment[],
  goalTracker: GoalTracker,
): number {
  if (commitments.length === 0) return 0;

  const activeGoals = goalTracker.getActiveGoals();
  let created = 0;

  for (const { classified, context } of commitments) {
    // Check if this commitment already has a matching goal
    const alreadyTracked = activeGoals.some(g =>
      fuzzyMatchesGoal(classified.commitment, g.data.title),
    );

    if (alreadyTracked) {
      log(`Commitment already tracked: "${classified.commitment.slice(0, 60)}"`);
      continue;
    }

    // Determine priority and deadline based on weight
    const priority = classified.weight === "significant" ? 2 : 3;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const deadline = classified.weight === "significant"
      ? Date.now() + 14 * DAY_MS // 14 days for significant
      : Date.now() + 7 * DAY_MS; // 7 days for notable

    const description = `Auto-detected commitment from ${context.source} (${context.audience}): "${classified.commitment}"`;

    goalTracker.applyGoalOps([{
      op: "create_goal",
      title: classified.commitment.slice(0, 120),
      description,
      priority: priority as 1 | 2 | 3,
      deadline,
      checkpoints: [],
      createdBy: "brain",
    }]);

    // Tag the newly created goal with 'commitment' for filtering in reflect
    // The goal was just created, so find it by matching title
    const updatedGoals = goalTracker.getActiveGoals();
    const newGoal = updatedGoals.find(g =>
      g.data.title === classified.commitment.slice(0, 120) &&
      g.data.description === description,
    );
    if (newGoal) {
      // Update tags to include commitment source info
      const graph = (goalTracker as any).graph;
      if (graph?.getNode && graph?.updateNode) {
        const node = graph.getNode(newGoal.nodeId);
        if (node) {
          const tags = [...new Set([...node.tags, "commitment", `source-${context.source}`])];
          graph.updateNode(newGoal.nodeId, { tags });
        }
      }
    }

    log(`Created goal for commitment [${classified.weight}]: "${classified.commitment.slice(0, 80)}" (source: ${context.source}, audience: ${context.audience})`);
    created++;
  }

  if (created > 0) {
    log(`Accountability: ${created} new goal(s) from ${commitments.length} detected commitment(s)`);
  }

  return created;
}

/**
 * Convenience: scan text and immediately process any commitments found.
 * Used in the post-think/post-reflect output pipeline.
 */
export function scanAndProcessCommitments(
  text: string,
  source: string,
  audience: string,
  goalTracker: GoalTracker,
): number {
  const commitments = scanForCommitments(text, {
    source,
    audience,
    detectedAt: Date.now(),
  });
  return processCommitments(commitments, goalTracker);
}
