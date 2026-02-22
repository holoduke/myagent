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

export interface CalendarStatus {
  enabled: boolean
  accounts: Array<{ id: string; email: string; lastSync: number }>
  nextEventCount: number
}

export interface HomeAssistantStatus {
  enabled: boolean
  connected: boolean
  url: string
  entityCount: number
  lastPoll: number
}

export interface RSSFeedStatus {
  id: string
  name: string
  url: string
  enabled: boolean
  lastPoll: number
  itemCount: number
}

export interface RSSStatus {
  feeds: RSSFeedStatus[]
}

export interface OwnTracksStatus {
  enabled: boolean
  lastLocation: { lat: number; lon: number; timestamp: number; battery?: number } | null
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
  calendar: CalendarStatus
  homeassistant: HomeAssistantStatus
  rss: RSSStatus
  owntracks: OwnTracksStatus
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
  provider?: string
  model?: string
}

export interface BrainConfig {
  enabled: boolean
  maxMessagesPerDay: number
  minMessageInterval: number
  quietStart: number
  quietEnd: number
  thinkCooldown: number
  consolidateInterval: number
  reflectInterval: number
  tickInterval: number
  preset: string | null
  selfImproveEnabled: boolean
  selfImproveAutoApprove: boolean
  selfImproveMaxPerWeek: number
  characterType: string
  characterCustomPrompt: string | null
}

export interface CharacterPreset {
  name: string
  label: string
  description: string
  traits: string
  voice: string
}

export interface BrainPreset {
  name: string
  label: string
  description: string
  values: Partial<BrainConfig>
}

export interface BrainConfigResponse {
  config: BrainConfig
  activePreset: string | null
  presets: BrainPreset[]
  characterPresets: CharacterPreset[]
}

export interface AgentProfile {
  id: string
  name: string
  provider: 'claude' | 'codex' | 'grok'
  isDefault: boolean
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ImproveQueueItem {
  id: string
  task: { type: string; description: string; rationale: string; files: string[]; createdAt: number }
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed'
  createdAt: number
  reviewedAt?: number
  completedAt?: number
  result?: { success: boolean; description: string; prUrl?: string; branch?: string; wasRollback?: boolean }
}

export interface ImproveQueueResponse {
  queue: ImproveQueueItem[]
  history: ImproveQueueItem[]
  weeklyCount: number
}

// ── Brain Dashboard Types ──

export interface RecurringTask {
  id: string
  type: 'message' | 'think_trigger' | 'digest'
  label: string
  pattern: { hours: number[]; daysOfWeek?: number[] }
  action: { type: string; targetJid?: string; template?: string; topic?: string; context?: string }
  enabled: boolean
  createdAt: number
  lastRunAt: number
  source: 'brain' | 'owner'
}

export interface InitiativeSignal {
  type: 'follow_up_due' | 'person_absent' | 'goal_deadline' | 'conversation_stale'
  priority: number
  description: string
  relatedNodeIds: string[]
  suggestedAction?: string
}

export interface GoalCheckpoint {
  label: string
  done: boolean
}

export interface GoalData {
  title: string
  description: string
  status: 'active' | 'completed' | 'abandoned' | 'paused'
  priority: 1 | 2 | 3
  deadline?: number
  progress: number
  checkpoints: GoalCheckpoint[]
  createdBy: 'brain' | 'owner'
  lastCheckedAt: number
}

export interface Goal {
  nodeId: string
  data: GoalData
}

export interface PendingFollowUp {
  id: string
  question: string
  targetPerson?: string
  context: string
  createdAt: number
  dueAt?: number
}

export interface BrainDashboardData {
  goals: Goal[]
  recurringTasks: RecurringTask[]
  signals: InitiativeSignal[]
  followUps: PendingFollowUp[]
}
