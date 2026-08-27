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
  | "concept"
  | "preference"
  | "belief"
  | "procedure"
  | "reflection";

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
  emotionalValence?: number;   // -1.0 (negative) to 1.0 (positive), emotional direction
  confidence?: number;         // 0.0 – 1.0, source reliability signal
  uselessRetrievalCount?: number; // times included in context but not referenced by Claude
  reconstructedAt?: number;    // unix ms — set when restored from archive/logs
  reconstructedFrom?: "archive" | "log";  // source of reconstruction
  reconstructionOriginal?: {   // snapshot of original state at archive time (for fidelity validation)
    content: string;
    tags: string[];
    edgeCount: number;         // how many edges the node had when archived
    strength: number;          // original strength at archive time
  };
  /** Temporal validity window — when this fact is valid (Phase 5a) */
  validFrom?: number;          // unix ms — fact is valid starting from this time
  /** Temporal validity window — when this fact expires */
  validUntil?: number;         // unix ms — fact is no longer valid after this time
  /** Bi-temporal: when ARIA learned about this (distinct from createdAt which is event time) */
  ingestedAt?: number;         // unix ms — when this was ingested into the graph
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

// ── Rejected Edges ──
// Lightweight tombstones for proposed-but-refused candidate edges.
// Stored without semantic content or embedding so spreading activation can
// surface prior refusals and avoid re-deriving the same nos.

export interface RejectedEdge {
  from: string;
  to: string;
  type?: EdgeType;             // optional — null/undefined means "any type"
  reason: string;              // one-line, free-form justification
  rejectedAt: number;          // unix ms — first rejection
  lastSeenAt: number;          // unix ms — last time this candidate resurfaced
  seenCount: number;           // how many times the same candidate has been considered
}

/** Max stored rejected edges before LRU eviction */
export const MAX_REJECTED_EDGES = 1000;

/** TTL for rejected-edge entries before pruning (90 days). Reinforcement (lastSeenAt) extends life. */
export const REJECTED_EDGE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

/** Hierarchical temporal summaries — compressed history at multiple time scales */
export interface TemporalSummaries {
  /** One-line summary per day, keyed by ISO date (e.g. "2026-04-10") */
  daily: Record<string, string>;
  /** One-line summary per week, keyed by ISO week start date (Monday) */
  weekly: Record<string, string>;
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
  temporalSummaries?: TemporalSummaries;
}

// ── Brain State ──

/**
 * Delivery record for the most recent message the brain returned from a tick.
 * status "sent" starts unverified; the next tick cross-checks delivery-log.json
 * and either confirms it (verified=true) or downgrades it to "failed".
 */
export interface BrainMessageDelivery {
  at: number;             // when the brain returned/attempted the message
  targetJid: string;
  snippet: string;        // first 120 chars — matches delivery-log messageSnippet
  status: "sent" | "suppressed" | "failed";
  detail?: string;        // suppression/failure reason
  verified: boolean;      // true once cross-checked against delivery-log.json (or nothing to check)
}

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
  lastImproveNudgeDate?: string;

  // backups
  lastBackupTick: number;

  // daily news digest
  lastNewsDigestTick?: number;

  // delivery feedback for the last brain-returned message
  lastBrainMessage?: BrainMessageDelivery;
}

// ── Tick Types ──

export type TickType = "observe" | "think" | "consolidate" | "reflect";

// ── Memory Operations (Claude's output) ──

export type MemoryOperation =
  | { op: "add_node"; id: string; type: NodeType; content: string; tags: string[]; pinned?: boolean; strength?: number; importance?: number; validFrom?: number; validUntil?: number; confidence?: number }
  | { op: "add_edge"; from: string; to: string; type: EdgeType; weight: number }
  | { op: "strengthen"; id: string; amount: number }
  | { op: "weaken"; id: string; amount: number }
  | { op: "update_node"; id: string; content?: string; tags?: string[]; pinned?: boolean; importance?: number }
  | { op: "update_edge"; from: string; to: string; weight?: number; type?: EdgeType }
  | { op: "merge_nodes"; ids: string[]; into: { content: string; tags: string[] } }
  | { op: "remove_node"; id: string }
  | { op: "remove_edge"; from: string; to: string; type?: EdgeType }
  | { op: "reject_edge"; from: string; to: string; type?: EdgeType; reason: string };

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
  reason?: string;
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
  /** Optional: JID to send the message to. Defaults to owner. Use group @g.us JID to reply in a group. */
  messageTargetJid?: string | null;
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
  /** Raw consciousness state update — written verbatim to consciousness.dat */
  consciousnessUpdate?: string;
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
  person:     0.002,   // ~14-day half-life
  fact:       0.003,
  insight:    0.004,
  event:      0.005,
  plan:       0.006,
  emotion:    0.008,   // ~3.6-day half-life
  meta:       0.003,
  goal:       0.001,   // very slow — goals persist
  concept:    0.001,   // very slow — concepts are structural
  preference: 0.001,   // very slow — preferences are long-lived
  belief:     0.005,   // medium — beliefs evolve as evidence changes
  procedure:  0.001,   // very slow — learned strategies persist
  reflection: 0.01,    // medium-slow — reflections stay relevant for weeks
};

// ── Ghost Graph ──
// Lightweight topology-only remnants preserved after archive eviction.
// Retains structural information (node ID, type, tag fingerprint, edges)
// without content, enabling potential graph reconstruction.

export interface GhostNode {
  id: string;
  type: NodeType;
  tagFingerprint: string[];       // tags at time of eviction
  edges: ArchivedEdge[];          // topology preserved from archive
  archivedAt: number;             // when originally archived
  evictedAt: number;              // when evicted from archive → ghost
  archiveReason: ArchivedNode["archiveReason"];
}

export const MAX_GHOST_NODES = 5000;

// ── Write-Ahead Log (WAL) ──
// Append-only log recording every graph mutation for forensic reconstruction.

export type WALOperationType =
  | "add_node"
  | "remove_node"
  | "update_node"
  | "strengthen"
  | "weaken"
  | "add_edge"
  | "remove_edge"
  | "update_edge"
  | "merge_nodes"
  | "archive"
  | "restore"
  | "reject_edge"
  | "prune_rejected_edges";

export interface WALEntry {
  ts: number;                    // unix ms
  op: WALOperationType;
  nodeId?: string;               // primary node involved
  nodeIds?: string[];            // for merge: source node IDs
  edgeFrom?: string;             // for edge ops
  edgeTo?: string;               // for edge ops
  meta?: Record<string, unknown>; // minimal metadata (type, reason, etc.)
}

/** Max WAL file size in bytes before rolling (default 10MB) */
export const WAL_MAX_BYTES = 10 * 1024 * 1024;

export const PRUNE_NODE_THRESHOLD = 0.05;
export const PRUNE_EDGE_THRESHOLD = 0.03;
export const ORPHAN_GRACE_HOURS = 24;
export const MAX_NODES_SOFT = 500;
export const MAX_NODES_HARD = 2000;
