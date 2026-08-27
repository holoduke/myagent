<template>
  <div class="section">
    <LayoutSectionHeader>Message Handlers</LayoutSectionHeader>

    <UiLoadState :loading="!loaded" :error="error" @retry="loadData()" />

    <template v-if="loaded && !error">
      <!-- Stats Overview -->
      <div v-if="handlers.length > 0" class="stats-row">
        <div class="stat-mini">
          <span class="stat-val">{{ handlers.length }}</span>
          <span class="stat-label">handlers</span>
        </div>
        <div class="stat-mini">
          <span class="stat-val">{{ handlers.filter(h => h.enabled).length }}</span>
          <span class="stat-label">active</span>
        </div>
        <div class="stat-mini">
          <span class="stat-val">{{ totalMatchesToday }}</span>
          <span class="stat-label">matches today</span>
        </div>
        <div class="stat-mini">
          <span class="stat-val">{{ totalLLMCallsToday }}</span>
          <span class="stat-label">LLM calls today</span>
        </div>
      </div>

      <!-- Handler List -->
      <UiCard title="Handlers" :icon="icons.filter" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">
          User-defined rules that filter and act on incoming messages. 3-tier pipeline: scope &rarr; keyword gate &rarr; LLM filter.
        </div>

        <div v-if="handlers.length === 0 && !showEditor" class="empty">
          No handlers configured yet.
        </div>

        <div v-for="h in handlers" :key="h.id" class="handler-item" :class="{ disabled: !h.enabled }">
          <div class="handler-header">
            <label class="toggle-wrap" @click.stop>
              <input type="checkbox" :checked="h.enabled" @change="toggleHandler(h)">
              <span class="toggle-slider"></span>
            </label>
            <span class="handler-name">{{ h.name }}</span>
            <span class="action-badge" :class="h.action.type">{{ h.action.type }}</span>
            <span v-if="getStats(h.id)" class="handler-stat">{{ getStats(h.id)!.matchesToday }} match{{ getStats(h.id)!.matchesToday === 1 ? '' : 'es' }} today</span>
          </div>
          <div v-if="h.description" class="handler-desc">{{ h.description }}</div>
          <div class="handler-meta">
            <span v-if="h.gate?.keywords?.length" class="meta-tag">{{ h.gate.keywords.length }} keyword{{ h.gate.keywords.length === 1 ? '' : 's' }}</span>
            <span v-if="h.gate?.regexPattern" class="meta-tag">regex</span>
            <span v-if="h.scope.isGroup === true" class="meta-tag">groups only</span>
            <span v-if="h.scope.isGroup === false" class="meta-tag">DMs only</span>
            <span v-if="h.scope.excludeWhitelisted" class="meta-tag">excl. whitelisted</span>
            <span v-if="h.maxLLMCallsPerDay" class="meta-tag">max {{ h.maxLLMCallsPerDay }}/day</span>
          </div>
          <div class="handler-actions">
            <button class="btn-link" @click="editHandler(h)">Edit</button>
            <button class="btn-link" @click="startTest(h)">Test</button>
            <button class="btn-link danger" @click="deleteHandler(h.id)">Delete</button>
          </div>
        </div>

        <!-- Editor -->
        <div v-if="showEditor" class="editor">
          <h4 class="editor-title">{{ editing ? 'Edit Handler' : 'New Handler' }}</h4>

          <div class="field">
            <label>Name</label>
            <input v-model="form.name" type="text" placeholder="e.g. Flag project mentions">
          </div>

          <div class="field">
            <label>Description <span class="optional">(optional)</span></label>
            <input v-model="form.description" type="text" placeholder="What this handler does">
          </div>

          <!-- Scope -->
          <fieldset class="fieldset">
            <legend>Scope</legend>
            <div class="field-row">
              <div class="field">
                <label>Message type</label>
                <select v-model="form.scopeIsGroup">
                  <option :value="null">All (groups + DMs)</option>
                  <option :value="true">Groups only</option>
                  <option :value="false">DMs only</option>
                </select>
              </div>
              <div class="field">
                <label>Min text length</label>
                <input v-model.number="form.scopeMinTextLength" type="number" min="1" max="1000" style="width:80px">
              </div>
            </div>
            <div class="field">
              <label class="checkbox-label">
                <input v-model="form.scopeExcludeWhitelisted" type="checkbox">
                Exclude whitelisted contacts
              </label>
            </div>
          </fieldset>

          <!-- Gate -->
          <fieldset class="fieldset">
            <legend>Keyword / Regex Gate <span class="optional">(pre-filter, free)</span></legend>
            <div class="field">
              <label>Keywords <span class="optional">(one per line, OR logic)</span></label>
              <textarea v-model="form.gateKeywords" rows="3" placeholder="project&#10;deadline&#10;urgent"></textarea>
            </div>
            <div class="field">
              <label>Regex pattern <span class="optional">(optional)</span></label>
              <input v-model="form.gateRegex" type="text" placeholder="e.g. meeting\s+at\s+\d">
            </div>
          </fieldset>

          <!-- Filter Prompt -->
          <fieldset class="fieldset">
            <legend>LLM Filter Prompt</legend>
            <div class="field">
              <label>Describe what messages should match</label>
              <textarea v-model="form.filterPrompt" rows="4" placeholder="Return true if this message mentions a deadline or urgent request that needs immediate attention."></textarea>
            </div>
          </fieldset>

          <!-- Action -->
          <fieldset class="fieldset">
            <legend>Action</legend>
            <div class="field">
              <label>Action type</label>
              <select v-model="form.actionType">
                <option value="flag">Flag for attention</option>
                <option value="reply">Auto-reply</option>
                <option value="memory">Store in memory</option>
                <option value="webhook">Webhook (POST)</option>
              </select>
            </div>

            <!-- Flag fields -->
            <template v-if="form.actionType === 'flag'">
              <div class="field-row">
                <div class="field">
                  <label>Label</label>
                  <input v-model="form.flagLabel" type="text" placeholder="e.g. Urgent">
                </div>
                <div class="field">
                  <label>Severity</label>
                  <select v-model="form.flagSeverity">
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>
            </template>

            <!-- Reply fields -->
            <template v-if="form.actionType === 'reply'">
              <div class="field">
                <label>Reply instructions</label>
                <textarea v-model="form.replyPrompt" rows="3" placeholder="Reply briefly acknowledging the message. Be professional."></textarea>
              </div>
            </template>

            <!-- Memory fields -->
            <template v-if="form.actionType === 'memory'">
              <div class="field">
                <label>Memory tag</label>
                <input v-model="form.memoryTag" type="text" placeholder="e.g. project-update">
              </div>
            </template>

            <!-- Webhook fields -->
            <template v-if="form.actionType === 'webhook'">
              <div class="field">
                <label>Webhook URL</label>
                <input v-model="form.webhookUrl" type="text" placeholder="https://...">
              </div>
            </template>
          </fieldset>

          <!-- Cost Controls -->
          <fieldset class="fieldset">
            <legend>Cost Controls <span class="optional">(optional)</span></legend>
            <div class="field-row">
              <div class="field">
                <label>Cooldown (seconds)</label>
                <input v-model.number="form.cooldownSec" type="number" min="0" placeholder="60">
              </div>
              <div class="field">
                <label>Max LLM calls/day</label>
                <input v-model.number="form.maxLLMCallsPerDay" type="number" min="0" placeholder="50">
              </div>
            </div>
          </fieldset>

          <div class="editor-actions">
            <button class="btn primary" :disabled="saving || !form.name || !form.filterPrompt" @click="saveHandler">
              {{ saving ? 'Saving...' : (editing ? 'Update' : 'Create') }}
            </button>
            <button class="btn" @click="cancelEdit">Cancel</button>
          </div>
        </div>

        <button v-if="!showEditor" class="btn primary" style="margin-top:8px" @click="showEditor = true; editing = null">
          + Add Handler
        </button>
      </UiCard>

      <!-- Test Panel -->
      <UiCard v-if="testHandler" title="Test Handler" :icon="icons.test" style="margin-bottom:16px">
        <div class="field">
          <label>Testing: <strong>{{ testHandler.name }}</strong></label>
        </div>
        <div class="field">
          <label>Test message</label>
          <textarea v-model="testMessage" rows="2" placeholder="Type a test message..."></textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Sender name</label>
            <input v-model="testSenderName" type="text" placeholder="John">
          </div>
          <div class="field">
            <label>
              <input v-model="testIsGroup" type="checkbox"> Group message
            </label>
          </div>
        </div>
        <div class="editor-actions">
          <button class="btn primary" :disabled="testing || !testMessage" @click="runTest">
            {{ testing ? 'Testing...' : 'Run Test' }}
          </button>
          <button class="btn" @click="testHandler = null">Close</button>
        </div>
        <div v-if="testResult" class="test-result">
          <div class="test-tier" :class="{ pass: testResult.tier1 }">Tier 1 (Scope): {{ testResult.tier1 ? 'PASS' : 'FAIL' }}</div>
          <div class="test-tier" :class="{ pass: testResult.tier2 }">Tier 2 (Gate): {{ testResult.tier2 ? 'PASS' : 'FAIL' }}</div>
          <div v-if="testResult.tier3" class="test-tier" :class="{ pass: testResult.tier3.match }">Tier 3 (LLM): {{ testResult.tier3.match ? 'MATCH' : 'NO MATCH' }} — {{ testResult.tier3.reason }}</div>
          <div v-if="testResult.error" class="test-error">{{ testResult.error }}</div>
        </div>
      </UiCard>

      <!-- Recent Activity Log -->
      <UiCard title="Recent Activity" :icon="icons.log">
        <div v-if="logEntries.length === 0" class="empty">No activity yet.</div>
        <div v-for="entry in logEntries" :key="entry.timestamp + entry.handlerId" class="log-entry">
          <div class="log-header">
            <span class="log-handler">{{ entry.handlerName }}</span>
            <span class="log-result" :class="{ match: entry.tier3Result, nomatch: entry.tier3Result === false }">
              {{ entry.tier3Result ? (entry.actionTaken ? entry.actionType : 'matched') : 'no match' }}
            </span>
            <span class="log-time">{{ timeAgo(entry.timestamp) }}</span>
          </div>
          <div class="log-detail">
            <span class="log-sender">{{ entry.senderName }}</span>
            <span v-if="entry.isGroup && entry.groupName" class="log-group">in {{ entry.groupName }}</span>
            — {{ entry.messageSnippet }}
          </div>
          <div v-if="entry.actionResult" class="log-action">{{ entry.actionResult }}</div>
          <div v-if="entry.error" class="log-error">{{ entry.error }}</div>
        </div>
      </UiCard>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { MessageHandler, HandlerLogEntry, HandlerStats, HandlerTestResult, HandlerActionType } from '~/types/aria'

const { api } = useApi()
const { showToast } = useToast()

const loaded = ref(false)
const error = ref('')
const handlers = ref<MessageHandler[]>([])
const stats = ref<HandlerStats[]>([])
const logEntries = ref<HandlerLogEntry[]>([])
const saving = ref(false)

// Editor state
const showEditor = ref(false)
const editing = ref<MessageHandler | null>(null)

const form = reactive({
  name: '',
  description: '',
  scopeIsGroup: null as boolean | null,
  scopeMinTextLength: 1,
  scopeExcludeWhitelisted: false,
  gateKeywords: '',
  gateRegex: '',
  filterPrompt: '',
  actionType: 'flag' as HandlerActionType,
  flagLabel: '',
  flagSeverity: 'info' as 'info' | 'warning' | 'critical',
  replyPrompt: '',
  memoryTag: '',
  webhookUrl: '',
  cooldownSec: 0,
  maxLLMCallsPerDay: 0,
})

// Test state
const testHandler = ref<MessageHandler | null>(null)
const testMessage = ref('')
const testSenderName = ref('Test User')
const testIsGroup = ref(false)
const testing = ref(false)
const testResult = ref<HandlerTestResult | null>(null)

const icons = {
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
  test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
}

const totalMatchesToday = computed(() => stats.value.reduce((sum, s) => sum + s.matchesToday, 0))
const totalLLMCallsToday = computed(() => stats.value.reduce((sum, s) => sum + s.llmCallsToday, 0))

function getStats(handlerId: string): HandlerStats | undefined {
  return stats.value.find(s => s.handlerId === handlerId)
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function resetForm() {
  form.name = ''
  form.description = ''
  form.scopeIsGroup = null
  form.scopeMinTextLength = 1
  form.scopeExcludeWhitelisted = false
  form.gateKeywords = ''
  form.gateRegex = ''
  form.filterPrompt = ''
  form.actionType = 'flag'
  form.flagLabel = ''
  form.flagSeverity = 'info'
  form.replyPrompt = ''
  form.memoryTag = ''
  form.webhookUrl = ''
  form.cooldownSec = 0
  form.maxLLMCallsPerDay = 0
}

function editHandler(h: MessageHandler) {
  editing.value = h
  form.name = h.name
  form.description = h.description || ''
  form.scopeIsGroup = h.scope.isGroup ?? null
  form.scopeMinTextLength = h.scope.minTextLength ?? 1
  form.scopeExcludeWhitelisted = h.scope.excludeWhitelisted ?? false
  form.gateKeywords = h.gate?.keywords?.join('\n') || ''
  form.gateRegex = h.gate?.regexPattern || ''
  form.filterPrompt = h.filterPrompt
  form.actionType = h.action.type
  form.flagLabel = h.action.flagLabel || ''
  form.flagSeverity = h.action.flagSeverity || 'info'
  form.replyPrompt = h.action.replyPrompt || ''
  form.memoryTag = h.action.memoryTag || ''
  form.webhookUrl = h.action.webhookUrl || ''
  form.cooldownSec = h.cooldownMs ? Math.round(h.cooldownMs / 1000) : 0
  form.maxLLMCallsPerDay = h.maxLLMCallsPerDay || 0
  showEditor.value = true
}

function cancelEdit() {
  showEditor.value = false
  editing.value = null
  resetForm()
}

function buildPayload() {
  const keywords = form.gateKeywords.split('\n').map(k => k.trim()).filter(Boolean)
  return {
    name: form.name,
    description: form.description || undefined,
    scope: {
      isGroup: form.scopeIsGroup,
      minTextLength: form.scopeMinTextLength,
      excludeWhitelisted: form.scopeExcludeWhitelisted,
      excludeFromMe: true,
    },
    gate: (keywords.length > 0 || form.gateRegex)
      ? { keywords: keywords.length > 0 ? keywords : undefined, regexPattern: form.gateRegex || undefined }
      : undefined,
    filterPrompt: form.filterPrompt,
    action: {
      type: form.actionType,
      ...(form.actionType === 'flag' ? { flagLabel: form.flagLabel || undefined, flagSeverity: form.flagSeverity } : {}),
      ...(form.actionType === 'reply' ? { replyPrompt: form.replyPrompt } : {}),
      ...(form.actionType === 'memory' ? { memoryTag: form.memoryTag || undefined } : {}),
      ...(form.actionType === 'webhook' ? { webhookUrl: form.webhookUrl } : {}),
    },
    cooldownMs: form.cooldownSec > 0 ? form.cooldownSec * 1000 : undefined,
    maxLLMCallsPerDay: form.maxLLMCallsPerDay > 0 ? form.maxLLMCallsPerDay : undefined,
  }
}

async function saveHandler() {
  saving.value = true
  try {
    if (editing.value) {
      await api(`/api/message-handlers/${editing.value.id}`, { method: 'PATCH', body: buildPayload() })
    } else {
      await api('/api/message-handlers', { method: 'POST', body: buildPayload() })
    }
    await loadData()
    cancelEdit()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to save handler', 'error')
  } finally {
    saving.value = false
  }
}

async function toggleHandler(h: MessageHandler) {
  try {
    await api(`/api/message-handlers/${h.id}`, { method: 'PATCH', body: { enabled: !h.enabled } })
    await loadData()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to toggle handler', 'error')
  }
}

async function deleteHandler(id: string) {
  if (!confirm('Delete this handler?')) return
  try {
    await api(`/api/message-handlers/${id}`, { method: 'DELETE' })
    await loadData()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to delete handler', 'error')
  }
}

function startTest(h: MessageHandler) {
  testHandler.value = h
  testResult.value = null
  testMessage.value = ''
}

async function runTest() {
  if (!testHandler.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await api<HandlerTestResult>('/api/message-handlers/test', {
      method: 'POST',
      body: {
        handlerId: testHandler.value.id,
        testMessage: testMessage.value,
        senderName: testSenderName.value,
        isGroup: testIsGroup.value,
      },
    })
  } catch (e) {
    testResult.value = { tier1: false, tier2: false, error: String(e) }
  } finally {
    testing.value = false
  }
}

async function loadData() {
  try {
    const [h, s, l] = await Promise.all([
      api<MessageHandler[]>('/api/message-handlers'),
      api<HandlerStats[]>('/api/message-handlers/stats'),
      api<HandlerLogEntry[]>('/api/message-handlers/log?limit=50'),
    ])
    handlers.value = h
    stats.value = s
    logEntries.value = l.reverse()
    loaded.value = true
  } catch (e) {
    error.value = String(e)
  }
}

onMounted(loadData)
</script>

<style scoped>
.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.stat-mini {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 70px;
}
.stat-val {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
}
.stat-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.empty {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 12px 0;
}

/* Handler items */
.handler-item {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  transition: opacity 0.15s;
}
.handler-item.disabled {
  opacity: 0.5;
}
.handler-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.handler-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
}
.action-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.action-badge.flag { background: rgba(234,179,8,0.15); color: #eab308; }
.action-badge.reply { background: rgba(59,130,246,0.15); color: #3b82f6; }
.action-badge.memory { background: rgba(139,92,246,0.15); color: var(--accent); }
.action-badge.webhook { background: rgba(34,197,94,0.15); color: #22c55e; }
.handler-stat {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}
.handler-desc {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}
.handler-meta {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.meta-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
  color: var(--text-muted);
  font-family: var(--mono);
}
.handler-actions {
  margin-top: 8px;
  display: flex;
  gap: 12px;
}

/* Toggle switch */
.toggle-wrap {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle-wrap input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 9px;
  transition: 0.2s;
}
.toggle-slider::before {
  content: '';
  position: absolute;
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}
.toggle-wrap input:checked + .toggle-slider {
  background: var(--accent);
}
.toggle-wrap input:checked + .toggle-slider::before {
  transform: translateX(14px);
}

/* Editor */
.editor {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-top: 12px;
}
.editor-title {
  font-size: 14px;
  color: var(--text);
  margin: 0 0 12px;
}
.field {
  margin-bottom: 10px;
}
.field label {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
  font-family: var(--mono);
}
.field input[type="text"],
.field input[type="number"],
.field select,
.field textarea {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  font-family: var(--mono);
}
.field textarea {
  resize: vertical;
}
.field-row {
  display: flex;
  gap: 12px;
}
.field-row .field {
  flex: 1;
}
.fieldset {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.fieldset legend {
  font-size: 12px;
  color: var(--accent);
  font-family: var(--mono);
  padding: 0 6px;
}
.optional {
  color: var(--text-ghost);
  font-weight: normal;
}
.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.checkbox-label input[type="checkbox"] {
  width: auto;
}
.editor-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

/* Buttons */
.btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  transition: all 0.15s;
}
.btn:hover {
  color: var(--text);
  border-color: var(--text-muted);
}
.btn.primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.btn.primary:hover {
  opacity: 0.9;
}
.btn.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn-link {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  padding: 0;
}
.btn-link:hover { color: var(--accent); }
.btn-link.danger:hover { color: var(--red); }

/* Test result */
.test-result {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 12px;
}
.test-tier {
  padding: 4px 0;
  color: var(--red);
}
.test-tier.pass {
  color: #22c55e;
}
.test-error {
  color: var(--red);
  margin-top: 4px;
}

/* Log entries */
.log-entry {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.log-entry:last-child {
  border-bottom: none;
}
.log-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-handler {
  font-weight: 600;
  color: var(--text);
}
.log-result {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}
.log-result.match {
  background: rgba(34,197,94,0.15);
  color: #22c55e;
}
.log-result.nomatch {
  background: rgba(255,255,255,0.05);
  color: var(--text-ghost);
}
.log-time {
  margin-left: auto;
  color: var(--text-ghost);
}
.log-detail {
  color: var(--text-dim);
  margin-top: 2px;
}
.log-sender {
  font-weight: 500;
  color: var(--text-muted);
}
.log-group {
  color: var(--text-ghost);
}
.log-action {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
  margin-top: 2px;
}
.log-error {
  color: var(--red);
  font-size: 11px;
  margin-top: 2px;
}
</style>
