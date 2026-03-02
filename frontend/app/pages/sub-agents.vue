<template>
  <div class="section">
    <div class="section-top">
      <LayoutSectionHeader>Sub-Agents</LayoutSectionHeader>
      <button class="add-btn" @click="openCreate">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="data">
      <!-- Stats row -->
      <div class="stats-row">
        <UiStatCard label="Total" :value="data.agents.length" />
        <UiStatCard label="Enabled" :value="data.agents.filter(a => a.enabled).length" />
        <UiStatCard label="Running" :value="Object.keys(data.state.runningAgents).length" />
      </div>

      <!-- Agent tiles -->
      <div v-if="data.agents.length" class="agent-tiles">
        <div
          v-for="agent in data.agents"
          :key="agent.id"
          class="sa-tile"
          @click="selectAgent(agent)"
        >
          <div class="sa-tile-header">
            <UiStatusDot :status="agentStatus(agent)" />
            <span class="sa-tile-name">{{ agent.name }}</span>
            <button class="toggle-btn" :class="{ on: agent.enabled }" @click.stop="doToggle(agent)">
              {{ agent.enabled ? 'ON' : 'OFF' }}
            </button>
          </div>
          <div class="sa-tile-desc">{{ agent.description }}</div>
          <div class="sa-tile-meta">
            <span>{{ scheduleLabel(agent.schedule) }}</span>
            <span v-if="agent.lastRunAt">Last: {{ timeAgo(agent.lastRunAt) }}</span>
            <span v-else>Never run</span>
          </div>
          <!-- Last run badge -->
          <div v-if="lastRun(agent.id)" class="sa-tile-result" :class="{ success: lastRun(agent.id)!.success, fail: !lastRun(agent.id)!.success }">
            {{ lastRun(agent.id)!.success ? 'PASS' : 'FAIL' }}: {{ lastRun(agent.id)!.summary.slice(0, 80) }}
          </div>
          <div class="sa-tile-actions">
            <button class="btn-small" :disabled="isAgentRunning(agent.id)" @click.stop="doManualRun(agent.id)">
              {{ isAgentRunning(agent.id) ? 'Running...' : 'Run Now' }}
            </button>
            <button class="btn-small btn-edit" @click.stop="openEdit(agent)">Edit</button>
          </div>
        </div>
      </div>

      <div v-else class="empty-hint" style="padding:40px">
        No sub-agents configured yet. Click <strong>+</strong> to create one.
      </div>

      <!-- Selected agent: Run History -->
      <div v-if="selectedAgent" class="history-panel">
        <h3>{{ selectedAgent.name }} &mdash; Run History</h3>
        <div v-if="!runs.length" class="empty-hint">No runs yet.</div>
        <div v-for="run in runs" :key="run.id" class="run-row" @click="showRunDetail = run">
          <UiStatusDot :status="run.success ? 'ok' : 'err'" />
          <span class="run-time">{{ fmtDate(run.completedAt) }}</span>
          <span class="run-summary" :class="{ fail: !run.success }">{{ run.summary.slice(0, 100) }}</span>
        </div>
      </div>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>

    <!-- Create Modal -->
    <UiModal :open="showCreate" title="New Sub-Agent" max-width="640px" @close="showCreate = false">
      <div class="modal-form">
        <div class="field">
          <label>Name</label>
          <input v-model="form.name" type="text" placeholder="Website Tester" />
        </div>
        <div class="field">
          <label>Description</label>
          <input v-model="form.description" type="text" placeholder="What does this agent do?" />
        </div>
        <div class="field">
          <label>Prompt</label>
          <textarea v-model="form.prompt" rows="8" placeholder="The task prompt Claude will execute..." />
        </div>
        <div class="field">
          <label>Tools</label>
          <input v-model="form.tools" type="text" placeholder="Bash,WebFetch,WebSearch" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>Schedule Hours (comma-sep)</label>
            <input v-model="form.hoursStr" type="text" placeholder="9,21" />
          </div>
          <div class="field">
            <label>Days (0=Sun, empty=daily)</label>
            <input v-model="form.daysStr" type="text" placeholder="1,2,3,4,5" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Timeout (seconds)</label>
            <input v-model.number="form.timeout" type="number" placeholder="300" />
          </div>
          <div class="field">
            <label>Max History Runs</label>
            <input v-model.number="form.maxHistoryRuns" type="number" placeholder="20" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="showCreate = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!form.name.trim() || saving" @click="doCreate">
            {{ saving ? 'Creating...' : 'Create Agent' }}
          </button>
        </div>
      </div>
    </UiModal>

    <!-- Edit Modal -->
    <UiModal :open="!!editAgent" :title="editAgent?.name || 'Edit'" max-width="640px" @close="editAgent = null">
      <template v-if="editAgent">
        <div class="modal-form">
          <div class="field">
            <label>Name</label>
            <input v-model="editForm.name" type="text" />
          </div>
          <div class="field">
            <label>Description</label>
            <input v-model="editForm.description" type="text" />
          </div>
          <div class="field">
            <label>Prompt</label>
            <textarea v-model="editForm.prompt" rows="8" />
          </div>
          <div class="field">
            <label>Tools</label>
            <input v-model="editForm.tools" type="text" />
          </div>
          <div class="field-row">
            <div class="field">
              <label>Schedule Hours</label>
              <input v-model="editForm.hoursStr" type="text" />
            </div>
            <div class="field">
              <label>Days</label>
              <input v-model="editForm.daysStr" type="text" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Timeout (s)</label>
              <input v-model.number="editForm.timeout" type="number" />
            </div>
            <div class="field">
              <label>Max History</label>
              <input v-model.number="editForm.maxHistoryRuns" type="number" />
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-primary" :disabled="saving" @click="doUpdate">
              {{ saving ? 'Saving...' : 'Save' }}
            </button>
          </div>
          <div class="modal-danger">
            <button class="btn btn-danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Deleting...' : 'Delete Agent' }}
            </button>
          </div>
        </div>
      </template>
    </UiModal>

    <!-- Run Detail Modal -->
    <UiModal :open="!!showRunDetail" :title="showRunDetail?.success ? 'Run Passed' : 'Run Failed'" max-width="720px" @close="showRunDetail = null">
      <template v-if="showRunDetail">
        <div class="run-detail">
          <div class="run-detail-meta">
            <UiKvRow label="Status" :value="showRunDetail.success ? 'SUCCESS' : 'FAILED'" />
            <UiKvRow label="Started" :value="fmtDate(showRunDetail.startedAt)" />
            <UiKvRow label="Completed" :value="fmtDate(showRunDetail.completedAt)" />
            <UiKvRow v-if="showRunDetail.error" label="Error" :value="showRunDetail.error" />
          </div>
          <div class="run-detail-summary">{{ showRunDetail.summary }}</div>
          <div v-if="showRunDetail.metrics" class="run-detail-metrics">
            <h4>Metrics</h4>
            <div v-for="(val, key) in showRunDetail.metrics" :key="key" class="metric-row">
              <span class="metric-key">{{ key }}</span>
              <span class="metric-val">{{ val }}</span>
            </div>
          </div>
          <div class="run-detail-body">
            <h4>Details</h4>
            <pre>{{ showRunDetail.details }}</pre>
          </div>
        </div>
      </template>
    </UiModal>
  </div>
</template>

<script setup lang="ts">
import type { SubAgentConfig, SubAgentRun, SubAgentsResponse } from '~/types/aria'

const { api } = useApi()
const { timeAgo, fmtDate } = useTimeAgo()

const data = ref<SubAgentsResponse | null>(null)
const error = ref('')
const selectedAgent = ref<SubAgentConfig | null>(null)
const runs = ref<SubAgentRun[]>([])

// Create
const showCreate = ref(false)
const saving = ref(false)
const form = reactive({
  name: '', description: '', prompt: '', tools: 'Bash,WebFetch',
  hoursStr: '9,21', daysStr: '', timeout: 300, maxHistoryRuns: 20,
})

// Edit
const editAgent = ref<SubAgentConfig | null>(null)
const editForm = reactive({
  name: '', description: '', prompt: '', tools: '',
  hoursStr: '', daysStr: '', timeout: 300, maxHistoryRuns: 20,
})
const deleting = ref(false)

// Run detail
const showRunDetail = ref<SubAgentRun | null>(null)

function agentStatus(agent: SubAgentConfig): 'ok' | 'warn' | 'err' {
  if (!agent.enabled) return 'err'
  if (data.value?.state.runningAgents[agent.id]) return 'warn'
  return 'ok'
}

function isAgentRunning(id: string): boolean {
  return !!data.value?.state.runningAgents[id]
}

function lastRun(agentId: string): SubAgentRun | null {
  const agentRuns = data.value?.recentRuns[agentId]
  return agentRuns?.[0] || null
}

function scheduleLabel(schedule: { hours: number[]; daysOfWeek?: number[] }): string {
  const h = schedule.hours.map(h => `${h}:00`).join(', ')
  if (schedule.daysOfWeek?.length) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const d = schedule.daysOfWeek.map(d => days[d]).join(', ')
    return `${h} on ${d}`
  }
  return `Daily at ${h}`
}

function parseHours(str: string): number[] {
  return str.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 23)
}

function parseDays(str: string): number[] | undefined {
  if (!str.trim()) return undefined
  const days = str.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 6)
  return days.length ? days : undefined
}

function openCreate() {
  form.name = ''; form.description = ''; form.prompt = ''; form.tools = 'Bash,WebFetch'
  form.hoursStr = '9,21'; form.daysStr = ''; form.timeout = 300; form.maxHistoryRuns = 20
  showCreate.value = true
}

function openEdit(agent: SubAgentConfig) {
  editAgent.value = agent
  editForm.name = agent.name
  editForm.description = agent.description
  editForm.prompt = agent.prompt
  editForm.tools = agent.tools
  editForm.hoursStr = agent.schedule.hours.join(',')
  editForm.daysStr = agent.schedule.daysOfWeek?.join(',') || ''
  editForm.timeout = Math.round(agent.timeout / 1000)
  editForm.maxHistoryRuns = agent.maxHistoryRuns
}

async function selectAgent(agent: SubAgentConfig) {
  selectedAgent.value = agent
  try {
    runs.value = await api<SubAgentRun[]>(`/api/sub-agents/${agent.id}/history`)
  } catch {
    runs.value = []
  }
}

async function doCreate() {
  saving.value = true
  try {
    await api('/api/sub-agents', {
      method: 'POST',
      body: {
        name: form.name, description: form.description, prompt: form.prompt, tools: form.tools,
        schedule: { hours: parseHours(form.hoursStr), daysOfWeek: parseDays(form.daysStr) },
        timeout: form.timeout * 1000, maxHistoryRuns: form.maxHistoryRuns,
      },
    })
    showCreate.value = false
    await load()
  } catch { /* silent */ } finally { saving.value = false }
}

async function doUpdate() {
  if (!editAgent.value) return
  saving.value = true
  try {
    await api(`/api/sub-agents/${editAgent.value.id}`, {
      method: 'PUT',
      body: {
        name: editForm.name, description: editForm.description, prompt: editForm.prompt, tools: editForm.tools,
        schedule: { hours: parseHours(editForm.hoursStr), daysOfWeek: parseDays(editForm.daysStr) },
        timeout: editForm.timeout * 1000, maxHistoryRuns: editForm.maxHistoryRuns,
      },
    })
    editAgent.value = null
    await load()
  } catch { /* silent */ } finally { saving.value = false }
}

async function doDelete() {
  if (!editAgent.value || !confirm(`Delete "${editAgent.value.name}"?`)) return
  deleting.value = true
  try {
    await api(`/api/sub-agents/${editAgent.value.id}`, { method: 'DELETE' })
    editAgent.value = null
    selectedAgent.value = null
    await load()
  } catch { /* silent */ } finally { deleting.value = false }
}

async function doToggle(agent: SubAgentConfig) {
  try {
    await api(`/api/sub-agents/${agent.id}/toggle`, { method: 'POST' })
    await load()
  } catch { /* silent */ }
}

async function doManualRun(agentId: string) {
  try {
    await api(`/api/sub-agents/${agentId}/run`, { method: 'POST' })
    await load()
  } catch { /* silent */ }
}

async function load() {
  try {
    data.value = await api<SubAgentsResponse>('/api/sub-agents')
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

useVisibilityRefresh(load)
onMounted(load)
</script>

<style scoped>
.section { flex: 1; overflow-y: auto; padding: 24px; animation: fadeSection .2s ease; }
.section-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.section-top :deep(.section-header) { margin-bottom: 0; }

.add-btn {
  width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-card); color: var(--text-muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all .2s;
}
.add-btn:hover { border-color: var(--accent); color: var(--accent); box-shadow: var(--glow-accent); }
.add-btn svg { width: 18px; height: 18px; }

.stats-row { display: flex; gap: 12px; margin: 16px 0; }

/* ── Agent Tiles ── */
.agent-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin-top: 16px; }

.sa-tile {
  padding: 16px; background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 12px; cursor: pointer; transition: all .2s;
}
.sa-tile:hover { border-color: var(--border-glow); box-shadow: var(--glow-card); }

.sa-tile-header { display: flex; align-items: center; gap: 8px; }
.sa-tile-name { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--text); flex: 1; }

.toggle-btn {
  font-family: var(--mono); font-size: 10px; padding: 2px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: transparent; color: var(--text-muted);
  cursor: pointer; text-transform: uppercase; letter-spacing: 1px; transition: all .2s;
}
.toggle-btn.on { background: rgba(16,185,129,0.15); color: #10b981; border-color: rgba(16,185,129,0.3); }

.sa-tile-desc { font-size: 12px; color: var(--text-muted); margin-top: 6px; line-height: 1.4; }
.sa-tile-meta { display: flex; gap: 16px; font-family: var(--mono); font-size: 11px; color: var(--text-ghost); margin-top: 8px; }

.sa-tile-result {
  margin-top: 8px; padding: 6px 10px; border-radius: 6px; font-family: var(--mono); font-size: 11px; line-height: 1.4;
}
.sa-tile-result.success { background: rgba(16,185,129,0.08); color: #10b981; }
.sa-tile-result.fail { background: rgba(239,68,68,0.08); color: var(--red); }

.sa-tile-actions { display: flex; gap: 8px; margin-top: 10px; }

.btn-small {
  padding: 4px 12px; border-radius: 6px; font-family: var(--mono); font-size: 11px;
  border: 1px solid var(--border); background: transparent; color: var(--text-muted);
  cursor: pointer; transition: all .15s;
}
.btn-small:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-small:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-small.btn-edit:hover { border-color: var(--text-dim); color: var(--text-dim); }

/* ── History Panel ── */
.history-panel {
  margin-top: 24px; padding: 16px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 12px;
}
.history-panel h3 { font-family: var(--mono); font-size: 14px; color: var(--text); margin-bottom: 12px; }

.run-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 8px; cursor: pointer; transition: background .15s;
}
.run-row:hover { background: rgba(255,255,255,0.02); }
.run-time { font-family: var(--mono); font-size: 11px; color: var(--text-ghost); min-width: 120px; }
.run-summary { font-size: 12px; color: var(--text-muted); flex: 1; }
.run-summary.fail { color: var(--red); }

/* ── Run Detail Modal ── */
.run-detail { display: flex; flex-direction: column; gap: 16px; }
.run-detail-summary { font-size: 14px; color: var(--text); font-weight: 500; }
.run-detail-metrics { font-family: var(--mono); font-size: 12px; }
.run-detail-metrics h4 { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.metric-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border); }
.metric-key { color: var(--text-muted); }
.metric-val { color: var(--accent); }
.run-detail-body h4 { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.run-detail-body pre {
  font-family: var(--mono); font-size: 12px; color: var(--text-dim); background: var(--bg);
  padding: 12px; border-radius: 8px; border: 1px solid var(--border);
  white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto;
}

/* ── Modals ── */
.modal-form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-family: var(--mono); font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
.field input, .field textarea {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); font-family: var(--mono); font-size: 13px; padding: 8px 12px;
  outline: none; transition: border-color .15s; resize: vertical;
}
.field input:focus, .field textarea:focus { border-color: var(--accent); }
.field input::placeholder, .field textarea::placeholder { color: var(--text-ghost); }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }

.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }

.btn { padding: 8px 16px; border-radius: 8px; font-family: var(--mono); font-size: 12px; cursor: pointer; transition: all .15s; border: 1px solid var(--border); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--text-muted); }
.btn-ghost:hover:not(:disabled) { color: var(--text); border-color: var(--border-glow); }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover:not(:disabled) { box-shadow: var(--glow-accent); }
.btn-danger { background: transparent; color: var(--red); border-color: var(--red); }
.btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.1); }

.modal-danger { padding-top: 12px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; }

.empty-hint { color: var(--text-ghost); text-align: center; font-size: 14px; }
.empty-hint strong { color: var(--accent); }

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .agent-tiles { grid-template-columns: 1fr; }
  .stats-row { flex-wrap: wrap; }
  .field-row { flex-direction: column; }
}
</style>
