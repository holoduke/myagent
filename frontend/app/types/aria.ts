export type NodeType = 'person' | 'event' | 'insight' | 'fact' | 'emotion' | 'plan' | 'meta' | 'goal'
export type EdgeType = 'causal' | 'temporal' | 'social' | 'topical' | 'emotional' | 'contradicts'

export interface MemoryNode {
  id: string
  type: NodeType
  content: string
  tags: string[]
  strength: number
  pinned: boolean
  createdAt: number
  lastAccessedAt: number
  accessCount: number
}

export interface WorkingMemory {
  currentContext: string
  mood: string
  shortTermTracking: string[]
  activatedNodeIds: string[]
  lastUpdated: number
}

export interface BrainState {
  lastObserveTick: number
  lastThinkTick: number
  lastConsolidateTick: number
  lastReflectTick: number
  lastMessageTime: number
  messagesToday: number
  totalThinks: number
  totalCost: number
  nodeCount: number
  edgeCount: number
  consecutiveFailures: number
  lastSuccessfulTick: number
  pendingSelfMod: boolean
}

export interface GraphData {
  nodeCount: number
  edgeCount: number
  byType: Record<string, number>
  avgStrength: number
  pinnedNodes: GraphNode[]
  strongestNodes: GraphNode[]
  weakestNodes: GraphNode[]
  recentNodes: GraphNode[]
}

export interface GraphNode {
  id: string
  type: NodeType
  content: string
  tags?: string[]
  strength: number
  accessCount?: number
  createdAt?: number
}

export interface SelfImprove {
  pendingTask: {
    description: string
    files: string[]
  } | null
  lastResult: {
    success: boolean
    description: string
    prUrl?: string
    completedAt?: number
  } | null
  bootCounter: number
  lastGoodCommit: string | null
}

export interface DashboardData {
  brainState: BrainState
  workingMemory: WorkingMemory
  graph: { nodeCount: number; edgeCount: number }
  selfImprove: SelfImprove
  whatsapp: { connected: boolean; contactCount: number }
  gmail: { total: number; authenticated: number }
  gmailAccounts: GmailAccount[]
  ssh: SSHStatus
  whitelistCount: number
  scheduledCount: number
  queueDepth: number
  timestamp: number
}

export interface GmailAccount {
  id: string
  email: string
  authenticated: boolean
  lastPoll?: number
}

export interface SSHTarget {
  id: string
  label: string
  host: string
  user: string
  port: number
  lastTestedAt?: number
  lastTestOk?: boolean
}

export interface SSHStatus {
  keyGenerated: boolean
  publicKey: string
  targets: SSHTarget[]
}

export interface AriaStatus {
  brainState: BrainState
  workingMemory: WorkingMemory
  graph: GraphData
  selfImprove: SelfImprove
  timestamp: number
}

export interface WhitelistContact {
  jid: string
  name: string
}

export interface ScheduledMessage {
  targetJid: string
  message: string
  deliverAt: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'error'
  content: string
  timestamp: number
  source?: string
  stats?: ChatStats
}

export interface ChatStats {
  durationMs: number
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  numTurns: number
}
