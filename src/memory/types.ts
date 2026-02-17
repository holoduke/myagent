// ── Node Types ──

export type NodeType =
  | "person"
  | "event"
  | "insight"
  | "fact"
  | "emotion"
  | "plan"
  | "meta";

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
  | "contradicts";

export interface MemoryEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight: number;          // 0.0 – 1.0
  createdAt: number;
  lastReinforcedAt: number;
}

// ── Working Memory ──

export interface WorkingMemory {
  currentContext: string;
  mood: string;
  shortTermTracking: string[];
  activatedNodeIds: string[];
  lastUpdated: number;
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

export interface BrainResponse {
  operations: MemoryOperation[];
  message: string | null;
  reasoning: string;
  workingMemory?: {
    currentContext?: string;
    mood?: string;
    shortTermTracking?: string[];
  };
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
};

export const PRUNE_NODE_THRESHOLD = 0.05;
export const PRUNE_EDGE_THRESHOLD = 0.03;
export const ORPHAN_GRACE_HOURS = 24;
export const MAX_NODES_SOFT = 500;
export const MAX_NODES_HARD = 2000;
