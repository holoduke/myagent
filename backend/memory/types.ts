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
  | { op: "add_node"; id: string; type: NodeType; content: string; tags: string[]; pinned?: boolean; strength?: number }
  | { op: "add_edge"; from: string; to: string; type: EdgeType; weight: number }
  | { op: "strengthen"; id: string; amount: number }
  | { op: "weaken"; id: string; amount: number }
  | { op: "update_node"; id: string; content?: string; tags?: string[]; pinned?: boolean }
  | { op: "update_edge"; from: string; to: string; weight?: number; type?: EdgeType }
  | { op: "merge_nodes"; ids: string[]; into: { content: string; tags: string[] } }
  | { op: "remove_node"; id: string }
  | { op: "remove_edge"; from: string; to: string };

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
}

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
