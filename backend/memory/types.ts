// ── Node Types ──

export type NodeType =
  | "person"
  | "event"
  | "insight"
  | "fact"
  | "emotion"
  | "plan"
  | "meta"
  | "goal"
  | "concept";

export interface MemoryNode {
  id: string;
  type: NodeType;
  content: string;
  tags: string[];
  strength: number;        // 0.0 – 1.0, decays over time
  pinned: boolean;         // pinned nodes never decay
  createdAt: number;       // unix ms
  lastAccessedAt: number;  // unix ms, updated on reinforce
  accessCount: number;
  importance?: number;     // 0.0 – 1.0, explicit salience signal (independent of frequency)
  reconstructedAt?: number;    // unix ms — set when restored from archive/logs
  reconstructedFrom?: "archive" | "log";  // source of reconstruction
}

export interface ArchivedNode extends MemoryNode {
  archivedAt: number;       // unix ms — when it was moved to cold storage
  archiveReason: "decay" | "orphan" | "emergency" | "manual" | "consolidation";
  archivedEdges?: ArchivedEdge[];  // tombstone: edges preserved from active graph at archive time
}

/** Lightweight edge snapshot preserved when a node is archived (tombstone) */
export interface ArchivedEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight: number;
}

// ── Edge Types ──

export type EdgeType =
  | "causal"
  | "temporal"
  | "social"
  | "topical"
  | "emotional"
  | "contradicts"
  | "hierarchical";

export interface MemoryEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight: number;          // 0.0 – 1.0
  createdAt: number;
  lastReinforcedAt: number;
}

// ── Working Memory ──

export interface WorkingGoalRef {
  nodeId: string;
  title: string;
  priority: 1 | 2 | 3;
  progress: number;
  deadlineStatus: "none" | "on_track" | "approaching" | "overdue";
}

export interface PendingFollowUp {
  id: string;
  question: string;
  targetPerson?: string;
  context: string;
  createdAt: number;
  dueAt?: number;
  potentiallyResolved?: boolean;
  potentiallyResolvedAt?: number;
}

export interface ConversationThread {
  id: string;
  participants: string[];
  topic: string;
  lastMessageAt: number;
  messageCount: number;
  status: "active" | "stale" | "closed";
}

export interface TemporalContext {
  dayOfWeek: string;
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  hour: number;
  date: string;
  isWeekend: boolean;
  upcomingEvents: string[];
}

export interface WorkingMemory {
  currentContext: string;
  mood: string;
  shortTermTracking: string[];
  activatedNodeIds: string[];
  lastUpdated: number;
  activeGoals: WorkingGoalRef[];
  pendingFollowUps: PendingFollowUp[];
  conversationThreads: ConversationThread[];
  temporal: TemporalContext;
}

// ── Brain State ──

export interface BrainState {
  // timing
  lastObserveTick: number;
  lastThinkTick: number;
  lastConsolidateTick: number;
  lastReflectTick: number;

  // messaging
  lastMessageTime: number;
  messagesToday: number;
  messagesTodayDate: string;

  // observations
  lastObservationTime: number;

  // stats
  totalThinks: number;
  totalCost: number;
  nodeCount: number;
  edgeCount: number;

  // recurring task budget
  recurringThinksToday: number;
  recurringBudgetDate: string;

  // initiative think budget
  initiativeThinksToday: number;
  initiativeBudgetDate: string;

  // self-improvement
  consecutiveFailures: number;
  lastSuccessfulTick: number;
  pendingSelfMod: boolean;
  selfModSpawnedAt?: number;
}

// ── Tick Types ──

export type TickType = "observe" | "think" | "consolidate" | "reflect";

// ── Memory Operations (Claude's output) ──

export type MemoryOperation =
  | { op: "add_node"; id: string; type: NodeType; content: string; tags: string[]; pinned?: boolean; strength?: number; importance?: number }
  | { op: "add_edge"; from: string; to: string; type: EdgeType; weight: number }
  | { op: "strengthen"; id: string; amount: number }
  | { op: "weaken"; id: string; amount: number }
  | { op: "update_node"; id: string; content?: string; tags?: string[]; pinned?: boolean; importance?: number }
  | { op: "update_edge"; from: string; to: string; weight?: number; type?: EdgeType }
  | { op: "merge_nodes"; ids: string[]; into: { content: string; tags: string[] } }
  | { op: "remove_node"; id: string }
  | { op: "remove_edge"; from: string; to: string; type?: EdgeType };

// ── Goal Operations ──

export interface GoalData {
  title: string;
  description: string;
  status: "active" | "completed" | "abandoned" | "paused";
  priority: 1 | 2 | 3;
  deadline?: number;
  progress: number;
  checkpoints: { label: string; done: boolean }[];
  createdBy: "brain" | "owner";
  lastCheckedAt: number;
}

export type GoalOperation =
  | { op: "create_goal"; title: string; description: string; priority: 1 | 2 | 3; deadline?: number; checkpoints?: string[]; createdBy?: "brain" | "owner" }
  | { op: "update_goal"; nodeId: string; progress?: number; status?: "active" | "completed" | "abandoned" | "paused"; checkpoints?: { label: string; done: boolean }[] }
  | { op: "complete_goal"; nodeId: string }
  | { op: "abandon_goal"; nodeId: string; reason?: string };

export interface ImprovementProposal {
  description: string;
  rationale: string;
  files: string[];
  memoryContext: string[];
  planNodeId: string;
}

/** A request flagged by the brain for owner confirmation */
export interface RequestFlag {
  /** Who sent the message */
  senderName: string;
  /** Sender's JID */
  senderJid: string;
  /** Original message text */
  text: string;
  /** Why the brain thinks this needs forwarding */
  reason: string;
  /** Detected categories */
  categories: string[];
  /** Was this from a group? */
  isGroup?: boolean;
  /** Group name if applicable */
  groupName?: string;
}

export interface BrainResponse {
  operations: MemoryOperation[];
  message: string | null;
  reasoning: string;
  workingMemory?: {
    currentContext?: string;
    mood?: string;
    shortTermTracking?: string[];
    pendingFollowUps?: PendingFollowUp[];
    conversationThreads?: ConversationThread[];
  };
  goalOps?: GoalOperation[];
  improvementProposals?: ImprovementProposal[];
  /** Requests from non-permissioned contacts that the brain judges worth forwarding */
  requestFlags?: RequestFlag[];
}

// ── Retention Tiers ──
// Hierarchical importance: family > friends > work > general > ephemeral
// Tier determines decay speed multiplier — lower = slower decay = longer retention

export type RetentionTier = "core" | "important" | "work" | "standard" | "ephemeral";

export const RETENTION_MULTIPLIER: Record<RetentionTier, number> = {
  core:      0.1,    // family, partner, children — near-permanent
  important: 0.25,   // friends, milestones, key insights
  work:      0.5,    // colleagues, projects, professional
  standard:  1.0,    // general events, facts (current behavior)
  ephemeral: 2.0,    // transient, promotional, one-offs
};

// Tags that signal each tier (checked against node tags, case-insensitive)
export const TIER_TAG_SIGNALS: Record<RetentionTier, string[]> = {
  core: [
    "family", "child", "children", "partner", "co-parent", "parent", "sibling",
    "gillis-child", "gillis-family", "blended-family", "father", "mother",
    "ilse", "maaike", "lucas", "naomi", "julian", "haasnoot-family",
    "core-relationship", "owner", "haas-family", "familie-haas",
    "krijn", "gillis-brother", "gillis-sister",
  ],
  important: [
    "friend", "gillis-friend", "milestone", "birthday", "birth", "pinned",
    "core-insight", "rule", "lesson", "persistent", "arjan", "important",
    "first-contact", "whitelisted", "aria-aware", "corrected",
  ],
  work: [
    "work", "newstory", "colleague", "professional-life", "project",
    "football-mania", "serie-a", "business", "client", "sprint",
    "jira", "meeting", "invoice", "gillis-employer", "marisa",
    "anthony", "gabriele", "developer", "infrastructure",
  ],
  standard: [],  // default tier — no specific signals needed
  ephemeral: [
    "promotional", "spam", "newsletter", "transient", "noise",
    "one-off", "temporary", "expired", "resolved", "closed",
  ],
};

// Content keywords that boost tier (checked against node content, case-insensitive)
export const TIER_CONTENT_SIGNALS: Record<RetentionTier, string[]> = {
  core: [
    "gillis's partner", "gillis's child", "gillis and ilse",
    "gillis and maaike", "co-parent", "blended family",
  ],
  important: [
    "gillis's friend", "confirmed jid", "birthday",
  ],
  work: [
    "newstory", "football-mania", "serie a", "deploy",
  ],
  standard: [],
  ephemeral: [],
};

// ── Decay Constants ──

export const DECAY_LAMBDA: Record<NodeType, number> = {
  person:  0.002,   // ~14-day half-life
  fact:    0.003,
  insight: 0.004,
  event:   0.005,
  plan:    0.006,
  emotion: 0.008,   // ~3.6-day half-life
  meta:    0.003,
  goal:    0.001,   // very slow — goals persist
  concept: 0.001,   // very slow — concepts are structural
};

export const PRUNE_NODE_THRESHOLD = 0.05;
export const PRUNE_EDGE_THRESHOLD = 0.03;
export const ORPHAN_GRACE_HOURS = 24;
export const MAX_NODES_SOFT = 500;
export const MAX_NODES_HARD = 2000;
