export interface Skill {
  id: string
  catalogId?: string
  name: string
  description: string
  prompt: string
  icon: string
  category: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface CatalogSkill {
  id: string
  name: string
  description: string
  prompt: string
  icon: string
  category: string
  installed: boolean
}

export type NodeType = 'person' | 'event' | 'insight' | 'fact' | 'emotion' | 'plan' | 'meta' | 'goal' | 'concept'
export type EdgeType = 'causal' | 'temporal' | 'social' | 'topical' | 'emotional' | 'contradicts' | 'hierarchical'

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

export interface GraphEdge {
  from: string
  to: string
  type: EdgeType
  weight: number
}

export interface ConceptTreeNode {
  id: string
  content: string
  strength: number
  childCount: number
  children: GraphNode[]
}

export type RetentionTier = 'core' | 'important' | 'work' | 'standard' | 'ephemeral'

export interface GraphData {
  nodeCount: number
  edgeCount: number
  byType: Record<string, number>
  avgStrength: number
  retentionTiers?: Record<RetentionTier, number>
  archivedCount?: number
  ghostCount?: number
  embeddingCount?: number
  pinnedNodes: GraphNode[]
  strongestNodes: GraphNode[]
  weakestNodes: GraphNode[]
  recentNodes: GraphNode[]
  edges?: GraphEdge[]
  conceptTree?: ConceptTreeNode[]
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

export interface CalendarConfigEntry {
  id: string
  name: string
  tag: 'private' | 'work' | null
}

export interface CalendarConfig {
  calendars: CalendarConfigEntry[]
}

export interface HAWeatherReflexConfig {
  enabled: boolean
  device: string
  actions: string[]
  mediaPlayer: string
  ttsEngine: string
  language: string
  eveningHour: number
  weatherEntity: string
  pushTts: boolean
  ttsVolume: number | null
}

export interface HomeAssistantConfig {
  mode: 'webhook' | 'direct_api' | 'cloud'
  direct_api?: { url: string; token: string }
  cloud?: { url: string; token: string }
  entities: string[]
  pollInterval: number
  webhookToken: string
  digestIntervalMs: number
  location: { lat: number; lon: number }
  reflexes: { weatherBriefing: HAWeatherReflexConfig }
}

export interface HAEventRecord {
  id: string
  receivedAt: number
  ts: number
  type: string
  device?: string
  entityId?: string
  friendlyName?: string
  action?: string
  state?: string
  previousState?: string
  handledBy?: string
  handledSummary?: string
}

export interface HomeAssistantStatus {
  enabled: boolean
  connected: boolean
  receiving?: boolean
  mode?: 'webhook' | 'direct_api' | 'cloud'
  url: string
  webhookUrl?: string
  webhookToken?: string
  entityCount: number
  lastPoll: number
  lastEventAt?: number
  eventsToday?: number
  pendingDigest?: number
  lastDigestAt?: number
  queuedCommands?: number
  recentEvents?: HAEventRecord[]
  config?: HomeAssistantConfig
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

export interface PlayStoreVitalsDay {
  date: string
  crashRate: number | null
  anrRate: number | null
  distinctUsers: number | null
}

export interface PlayStoreReview {
  reviewId: string
  date: string
  lastModifiedMs: number
  stars: number
  text: string
  language: string
  replied: boolean
}

export interface PlayStoreStatus {
  configured: boolean
  appLabel: string
  packageName: string
  snapshot: {
    generatedAt: number
    vitals: PlayStoreVitalsDay[]
    reviews: PlayStoreReview[]
  } | null
}

export interface TwilioCallRecord {
  callSid: string
  to: string
  from: string
  mode: 'simple' | 'agent'
  status: string
  startedAt: number
  endedAt?: number
  duration?: number
  summary?: string
  model?: string
}

export interface TwilioStatus {
  enabled: boolean
  configured: boolean
  phoneNumber: string
  webhookBaseUrl: string
  activeCalls: number
  totalCalls: number
  lastCallAt: number
  recentCalls: TwilioCallRecord[]
  config: {
    accountSid: string
    phoneNumber: string
    webhookBaseUrl: string
    defaultVoice: string
    defaultLanguage: string
    maxCallDurationSec: number
    model: string
  } | null
}

export interface BrowserTaskResult {
  id: string
  taskId: string
  success: boolean
  type: 'navigate' | 'screenshot' | 'extract' | 'fill' | 'click' | 'script'
  url?: string
  title?: string
  content?: string
  screenshotPath?: string
  error?: string
  durationMs: number
  completedAt: number
}

export interface BrowserStatus {
  ready: boolean
  activeSessions: number
  totalTasks: number
  lastTaskAt: number
  recentTasks: BrowserTaskResult[]
}

export interface MoltbookStatus {
  enabled: boolean
  name: string
  profileUrl: string
  karma: number
  followers: number
  postCount: number
  lastActive: string | null
}

export interface DashboardData {
  brainEnabled: boolean
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
  twilio: TwilioStatus
  browser: BrowserStatus
  moltbook: MoltbookStatus
  whitelistCount: number
  scheduledCount: number
  queueDepth: number
  integrationsEnabled: Record<string, boolean>
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

export interface ChannelHealthStatus {
  channelId: string
  connected: boolean
  lastMessageAt: number
  errorCount: number
  lastError?: string
}

export interface AriaStatus {
  brainState: BrainState
  workingMemory: WorkingMemory
  graph: GraphData
  selfImprove: SelfImprove
  channelHealth?: ChannelHealthStatus[]
  timestamp: number
}

export interface ContactPermissions {
  acceptCommands: boolean
  autoActions: string[]
  confirmActions: string[]
  defaultMode: 'confirm' | 'ignore'
}

export interface WhitelistContact {
  jid: string
  name: string
  addedAt?: number
  note?: string
  permissions?: ContactPermissions
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
  ownerTimezone: string
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
  detectionMode: 'regex' | 'prompt' | 'hybrid'
  detectionPrompt: string | null
  selfCritiqueEnabled: boolean
  selfCritiqueThreshold: number
  urgencyInterruptThreshold: number
  activationSpreadFactor: number
  archiveRecallMin: number
  archiveRecallMax: number
  archiveRecallDivisor: number
  maxThinkContextNodes: number
  /** Per-action model: Claude "sonnet"|"haiku"|"opus", Grok "grok"|"grok-mini" */
  models: {
    think: string
    consolidate: string
    reflect: string
    selfCritique: string
    messageEval: string
    driftAudit: string
    selfImprove: string
    vision: string
    newsDigest?: string
    haReflex?: string
    haDigest?: string
  }
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

// ── Directive / Contact Request Types ──

export type DirectiveActionType =
  | 'calendar' | 'reminder' | 'shopping' | 'task'
  | 'logistics' | 'message_relay' | 'information'

export type DirectivePolicy = 'auto-execute' | 'require-confirmation'

export interface Directive {
  id: string
  contactJid: string
  contactName: string
  actionType: DirectiveActionType
  policy: DirectivePolicy
  enabled: boolean
  createdAt: number
  note?: string
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'auto_executed'

export interface ContactRequest {
  id: string
  timestamp: number
  contactJid: string
  contactName: string
  message: string
  actionType: DirectiveActionType
  actionSummary: string
  status: RequestStatus
  appliedPolicy: DirectivePolicy | 'no-directive'
  isGroup: boolean
  groupName?: string
  resolvedAt?: number
  resolutionNote?: string
}

// ── Backup Types ──

export interface BackupMeta {
  timestamp: number
  date: string
  nodeCount: number
  edgeCount: number
  archiveCount: number
  ghostCount: number
  totalSizeBytes: number
  createdBy: 'auto' | 'manual'
}

export interface BackupDetail extends BackupMeta {
  nodeTypeBreakdown: Record<string, number>
  pinnedNodes: { id: string; type: string; content: string }[]
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

// ── Sub-Agent Types ──

export interface SubAgentSchedule {
  hours: number[]
  daysOfWeek?: number[]
}

export interface SubAgentConfig {
  id: string
  name: string
  description: string
  prompt: string
  tools: string
  schedule: SubAgentSchedule
  enabled: boolean
  timeout: number
  maxHistoryRuns: number
  createdAt: number
  lastRunAt: number
  source: 'brain' | 'owner'
}

export interface SubAgentRun {
  id: string
  agentId: string
  startedAt: number
  completedAt: number
  success: boolean
  summary: string
  details: string
  metrics?: Record<string, unknown>
  error?: string
}

export interface SubAgentState {
  runningAgents: Record<string, { pid?: number; startedAt: number }>
}

export interface SubAgentsResponse {
  agents: SubAgentConfig[]
  state: SubAgentState
  recentRuns: Record<string, SubAgentRun[]>
}

// ── Trust / Security Types ──

export interface SourceTrustRule {
  defaultTrust: 'owner' | 'trusted' | 'untrusted'
  jidOverrides?: Record<string, 'owner' | 'trusted' | 'untrusted'>
  ownerAlwaysTrusted?: boolean
}

export interface TrustConfig {
  sources: Record<string, SourceTrustRule>
  ownerJids: string[]
  logInjectionAttempts: boolean
}

export interface InjectionLogEntry {
  t: number
  sender: string
  senderJid: string
  source: string
  isGroup: boolean
  groupName?: string
  labels: string[]
  snippets: string[]
  textPreview: string
}

// ── Audit Log Types ──

export interface AuditEntry {
  timestamp: number
  action: string
  source: string
  details: string
  success: boolean
}

// ── Actionable Request Types ──

export type ActionableRequestStatus = 'auto_executed' | 'pending_confirmation' | 'approved' | 'rejected'

export interface ActionableSignal {
  type: string
  confidence: number
  details?: string
}

export interface ActionableRequest {
  id: string
  timestamp: number
  senderJid: string
  senderName: string
  chatName?: string
  isGroup: boolean
  groupName?: string
  text: string
  signals: ActionableSignal[]
  categories: string[]
  status: ActionableRequestStatus
  resolvedAt?: number
  eventId?: string
}

// ── Captcha Types ──

export interface CaptchaRequest {
  id: string
  imagePath: string
  caption: string
  requestedAt: number
  expiresAt: number
  status: 'pending' | 'answered' | 'expired'
  answer?: string
  answeredAt?: number
}

// ── Memory Relationship Types ──

export interface MemoryRelationship {
  nodeId: string
  nodeType: string
  nodeContent: string
  edgeType: string
  edgeWeight: number
  direction: 'outgoing' | 'incoming'
}

// ── Message Handlers ──

export type HandlerActionType = 'flag' | 'reply' | 'memory' | 'webhook'

export interface HandlerScope {
  sources?: string[]
  senderJids?: string[]
  groupJids?: string[]
  isGroup?: boolean | null
  excludeWhitelisted?: boolean
  excludeFromMe?: boolean
  minTextLength?: number
}

export interface HandlerGate {
  keywords?: string[]
  regexPattern?: string
  regexFlags?: string
}

export interface HandlerAction {
  type: HandlerActionType
  flagLabel?: string
  flagSeverity?: 'info' | 'warning' | 'critical'
  replyPrompt?: string
  memoryTag?: string
  memorySummaryPrompt?: string
  webhookUrl?: string
  webhookHeaders?: Record<string, string>
}

export interface MessageHandler {
  id: string
  name: string
  description?: string
  enabled: boolean
  priority: number
  createdAt: number
  updatedAt: number
  scope: HandlerScope
  gate?: HandlerGate
  filterPrompt: string
  action: HandlerAction
  cooldownMs?: number
  maxLLMCallsPerDay?: number
}

export interface HandlerLogEntry {
  timestamp: number
  handlerId: string
  handlerName: string
  senderJid: string
  senderName: string
  chatJid?: string
  isGroup: boolean
  groupName?: string
  messageSnippet: string
  tier1Passed: boolean
  tier2Passed: boolean
  tier3Result?: boolean
  actionTaken: boolean
  actionType?: HandlerActionType
  actionResult?: string
  error?: string
  llmLatencyMs?: number
}

export interface HandlerStats {
  handlerId: string
  matchesToday: number
  llmCallsToday: number
  actionsTakenToday: number
  lastMatchAt?: number
}

export interface HandlerTestResult {
  tier1: boolean
  tier2: boolean
  tier3?: { match: boolean; reason: string }
  error?: string
}
