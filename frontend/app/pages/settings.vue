<template>
  <div class="section">
    <LayoutSectionHeader>Settings</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Character Type -->
      <UiCard title="Character" :icon="icons.character" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Choose a personality preset or write your own.</div>
        <div class="ch-presets">
          <button
            v-for="p in characterPresets"
            :key="p.name"
            class="ch-preset"
            :class="{ active: characterType === p.name }"
            @click="selectCharacter(p.name)"
          >
            <div class="ch-preset-name">{{ p.label }}</div>
            <div class="ch-preset-desc">{{ p.description }}</div>
          </button>
          <button
            class="ch-preset"
            :class="{ active: characterType === 'custom' }"
            @click="selectCharacter('custom')"
          >
            <div class="ch-preset-name">Custom</div>
            <div class="ch-preset-desc">Write your own personality description.</div>
          </button>
        </div>
        <div v-if="characterType === 'custom'" style="margin-top:8px">
          <textarea
            v-model="characterCustomPrompt"
            rows="6"
            class="intg-input"
            style="width:100%;resize:vertical;font-size:12px;font-family:var(--mono)"
            placeholder="Describe the personality traits and voice..."
            @input="characterDirty = true"
          />
        </div>
        <div class="br-footer">
          <div class="br-status">
            {{ characterType === 'custom' ? 'Custom personality' : `Preset: ${characterPresets.find(p => p.name === characterType)?.label || characterType}` }}
          </div>
          <button v-if="characterDirty" class="btn primary" :disabled="characterSaving" @click="saveCharacter">
            {{ characterSaving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </UiCard>

      <!-- Brain Responsiveness -->
      <UiCard title="Brain Responsiveness" :icon="icons.brain" style="margin-bottom:16px">
        <!-- Enable toggle -->
        <div class="br-toggle-row">
          <span class="br-toggle-label">Autonomous messaging</span>
          <button class="br-toggle" :class="{ on: brainForm.enabled }" @click="brainForm.enabled = !brainForm.enabled; brainDirty = true">
            <span class="br-toggle-knob" />
          </button>
        </div>

        <!-- Preset tiles -->
        <div class="br-presets">
          <button
            v-for="p in brainPresets"
            :key="p.name"
            class="br-preset"
            :class="{ active: brainForm.preset === p.name }"
            @click="selectPreset(p.name)"
          >
            <div class="br-preset-name">{{ p.label }}</div>
            <div class="br-preset-desc">{{ p.description }}</div>
          </button>
        </div>

        <!-- Advanced toggle -->
        <button class="br-adv-toggle" @click="showAdvanced = !showAdvanced">
          Advanced
          <svg :class="{ open: showAdvanced }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>

        <div v-if="showAdvanced" class="br-adv">
          <div class="br-field">
            <label class="intg-label">Max messages / day</label>
            <input type="number" class="intg-input intg-input-sm" v-model.number="brainForm.maxMessagesPerDay" min="0" max="50" @input="onAdvancedChange">
          </div>
          <div class="br-field">
            <label class="intg-label">Min interval between messages</label>
            <select class="intg-input" v-model.number="brainForm.minMessageInterval" @change="onAdvancedChange">
              <option :value="1800000">30 min</option>
              <option :value="3600000">1 hour</option>
              <option :value="7200000">2 hours</option>
              <option :value="14400000">4 hours</option>
              <option :value="28800000">8 hours</option>
              <option :value="86400000">24 hours</option>
            </select>
          </div>
          <div class="br-field">
            <label class="intg-label">Quiet hours start</label>
            <select class="intg-input intg-input-sm" v-model.number="brainForm.quietStart" @change="onAdvancedChange">
              <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option>
            </select>
          </div>
          <div class="br-field">
            <label class="intg-label">Quiet hours end</label>
            <select class="intg-input intg-input-sm" v-model.number="brainForm.quietEnd" @change="onAdvancedChange">
              <option v-for="h in 25" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option>
            </select>
          </div>
          <div class="br-field">
            <label class="intg-label">Think cooldown</label>
            <select class="intg-input" v-model.number="brainForm.thinkCooldown" @change="onAdvancedChange">
              <option :value="60000">1 min</option>
              <option :value="300000">5 min</option>
              <option :value="900000">15 min</option>
              <option :value="1800000">30 min</option>
            </select>
          </div>
          <div class="br-field">
            <label class="intg-label">Consolidate interval</label>
            <select class="intg-input" v-model.number="brainForm.consolidateInterval" @change="onAdvancedChange">
              <option :value="3600000">1 hour</option>
              <option :value="7200000">2 hours</option>
              <option :value="14400000">4 hours</option>
              <option :value="28800000">8 hours</option>
            </select>
          </div>
          <div class="br-field">
            <label class="intg-label">Reflect interval</label>
            <select class="intg-input" v-model.number="brainForm.reflectInterval" @change="onAdvancedChange">
              <option :value="14400000">4 hours</option>
              <option :value="28800000">8 hours</option>
              <option :value="43200000">12 hours</option>
              <option :value="86400000">24 hours</option>
            </select>
          </div>
        </div>

        <!-- Save + status -->
        <div class="br-footer">
          <div class="br-status">
            {{ brainForm.preset ? `Preset: ${brainPresets.find(p => p.name === brainForm.preset)?.label || brainForm.preset}` : 'Custom' }}
          </div>
          <button v-if="brainDirty" class="btn primary" :disabled="brainSaving" @click="saveBrainConfig">
            {{ brainSaving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </UiCard>

      <!-- Self-Improvement -->
      <UiCard title="Self-Improvement" :icon="icons.edit" style="margin-bottom:16px">
        <!-- Controls -->
        <div class="si-controls">
          <div class="br-toggle-row">
            <span class="br-toggle-label">Enable self-improvement</span>
            <button class="br-toggle" :class="{ on: brainForm.selfImproveEnabled }" @click="brainForm.selfImproveEnabled = !brainForm.selfImproveEnabled; brainDirty = true">
              <span class="br-toggle-knob" />
            </button>
          </div>
          <div class="br-toggle-row">
            <span class="br-toggle-label">Auto-approve tasks</span>
            <button class="br-toggle" :class="{ on: brainForm.selfImproveAutoApprove }" @click="brainForm.selfImproveAutoApprove = !brainForm.selfImproveAutoApprove; brainDirty = true">
              <span class="br-toggle-knob" />
            </button>
          </div>
          <div class="si-max-row">
            <label class="intg-label">Max improvements / week</label>
            <input type="number" class="intg-input intg-input-sm" v-model.number="brainForm.selfImproveMaxPerWeek" min="0" max="20" @input="brainDirty = true" style="width:70px">
          </div>
          <div class="si-week-count">
            This week: {{ improveWeeklyCount }}/{{ brainForm.selfImproveMaxPerWeek }}
          </div>
          <div v-if="brainDirty" style="padding-top:8px">
            <button class="btn primary" :disabled="brainSaving" @click="saveBrainConfig">
              {{ brainSaving ? 'Saving...' : 'Save' }}
            </button>
          </div>
        </div>

        <!-- Pending Queue -->
        <div class="si-section">
          <div class="si-section-title">Pending Queue</div>
          <div v-if="improveQueue.length === 0" class="si-empty">No pending tasks</div>
          <div v-for="item in improveQueue" :key="item.id" class="si-queue-item">
            <div class="si-queue-desc">{{ item.task.description }}</div>
            <div v-if="item.task.files?.length" class="si-queue-files">Files: {{ item.task.files.join(', ') }}</div>
            <div v-if="item.task.rationale" class="si-queue-rationale">{{ item.task.rationale }}</div>
            <div class="si-queue-meta">
              <span class="si-badge" :class="item.status">{{ item.status }}</span>
              <span class="si-queue-time">{{ timeAgo(item.createdAt) }}</span>
            </div>
            <div v-if="item.status === 'pending'" class="si-queue-actions">
              <button class="btn primary sm" @click="handleApprove(item.id)">Approve</button>
              <button class="btn danger sm" @click="handleReject(item.id)">Reject</button>
            </div>
          </div>
        </div>

        <!-- History (collapsible) -->
        <div class="si-section">
          <button class="br-adv-toggle" @click="showHistory = !showHistory">
            History ({{ improveHistory.length }})
            <svg :class="{ open: showHistory }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div v-if="showHistory" class="si-history">
            <div v-if="improveHistory.length === 0" class="si-empty">No history yet</div>
            <div v-for="item in improveHistory.slice(0, 10)" :key="item.id" class="si-history-item">
              <span class="si-badge" :class="item.status">{{ item.status === 'completed' ? '\u2713' : item.status === 'failed' ? '\u2717' : '\u2014' }}</span>
              <span class="si-history-desc">{{ item.task.description }}</span>
              <a v-if="item.result?.prUrl" :href="item.result.prUrl" target="_blank" class="si-history-pr">PR</a>
              <span class="si-history-time">{{ timeAgo(item.completedAt || item.reviewedAt || item.createdAt) }}</span>
            </div>
          </div>
        </div>

        <!-- Boot / commit info -->
        <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:10px">
          <UiKvRow label="Boot Counter" :value="si.bootCounter || 0" :value-class="(si.bootCounter || 0) > 1 ? 'warn' : ''" />
          <UiKvRow label="Last Good Commit" :value="si.lastGoodCommit ? si.lastGoodCommit.slice(0, 8) : 'none'" />
        </div>
      </UiCard>

      <!-- Session -->
      <UiCard title="Session" :icon="icons.logout">
        <UiKvRow label="Status" value="Active" value-class="good" />
        <div class="btn-row">
          <button class="btn danger" @click="logout()">Logout</button>
        </div>
      </UiCard>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { DashboardData, SelfImprove, BrainConfig, BrainPreset, BrainConfigResponse, CharacterPreset, ImproveQueueItem, ImproveQueueResponse } from '~/types/aria'

const { api } = useApi()
const { logout } = useAuth()

const si = ref<SelfImprove>({ pendingTask: null, lastResult: null, bootCounter: 0, lastGoodCommit: null })
const loaded = ref(false)
const error = ref('')

// Brain config state
const brainPresets = ref<BrainPreset[]>([])
const brainForm = reactive<BrainConfig>({
  enabled: true,
  maxMessagesPerDay: 5,
  minMessageInterval: 7200000,
  quietStart: 23,
  quietEnd: 7,
  thinkCooldown: 300000,
  consolidateInterval: 14400000,
  reflectInterval: 43200000,
  tickInterval: 60000,
  preset: null,
  selfImproveEnabled: true,
  selfImproveAutoApprove: false,
  selfImproveMaxPerWeek: 3,
})
const brainDirty = ref(false)
const brainSaving = ref(false)
const showAdvanced = ref(false)

// Character state
const characterPresets = ref<CharacterPreset[]>([])
const characterType = ref('default')
const characterCustomPrompt = ref('')
const characterDirty = ref(false)
const characterSaving = ref(false)

// Improve queue state
const improveQueue = ref<ImproveQueueItem[]>([])
const improveHistory = ref<ImproveQueueItem[]>([])
const improveWeeklyCount = ref(0)
const showHistory = ref(false)

const icons = {
  character: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 0-7 7c0 3 2 5.5 4 7l1 1.5V21h4v-3.5L15 16c2-1.5 4-4 4-7a7 7 0 0 0-7-7z"/><line x1="10" y1="21" x2="14" y2="21"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
}

function selectPreset(name: string) {
  const preset = brainPresets.value.find(p => p.name === name)
  if (!preset) return
  Object.assign(brainForm, preset.values)
  brainForm.preset = name
  brainDirty.value = true
}

function selectCharacter(name: string) {
  characterType.value = name
  characterDirty.value = true
}

async function saveCharacter() {
  characterSaving.value = true
  try {
    const payload: Record<string, string | null> = { characterType: characterType.value }
    if (characterType.value === 'custom') {
      payload.characterCustomPrompt = characterCustomPrompt.value
    } else {
      payload.characterCustomPrompt = null
    }
    const resp = await api<BrainConfigResponse>('/api/brain-config', { method: 'PUT', body: payload })
    characterType.value = resp.config.characterType || 'default'
    characterCustomPrompt.value = resp.config.characterCustomPrompt || ''
    characterPresets.value = resp.characterPresets
    characterDirty.value = false
  } catch (e) {
    console.error('Failed to save character:', e)
  } finally {
    characterSaving.value = false
  }
}

function onAdvancedChange() {
  brainForm.preset = null
  brainDirty.value = true
}

async function saveBrainConfig() {
  brainSaving.value = true
  try {
    const payload = brainForm.preset
      ? { preset: brainForm.preset, enabled: brainForm.enabled, selfImproveEnabled: brainForm.selfImproveEnabled, selfImproveAutoApprove: brainForm.selfImproveAutoApprove, selfImproveMaxPerWeek: brainForm.selfImproveMaxPerWeek }
      : { ...toRaw(brainForm) }
    const resp = await api<BrainConfigResponse>('/api/brain-config', { method: 'PUT', body: payload })
    Object.assign(brainForm, resp.config)
    brainPresets.value = resp.presets
    brainDirty.value = false
  } catch (e) {
    console.error('Failed to save brain config:', e)
  } finally {
    brainSaving.value = false
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

async function loadQueue() {
  try {
    const resp = await api<ImproveQueueResponse>('/api/improve-queue')
    improveQueue.value = resp.queue
    improveHistory.value = resp.history
    improveWeeklyCount.value = resp.weeklyCount
  } catch {}
}

async function handleApprove(id: string) {
  try {
    await api(`/api/improve-queue/${id}/approve`, { method: 'POST' })
    await loadQueue()
  } catch (e) {
    console.error('Failed to approve:', e)
  }
}

async function handleReject(id: string) {
  try {
    await api(`/api/improve-queue/${id}/reject`, { method: 'POST' })
    await loadQueue()
  } catch (e) {
    console.error('Failed to reject:', e)
  }
}

async function load() {
  try {
    const [dash, brainResp, queueResp] = await Promise.all([
      api<DashboardData>('/api/dashboard'),
      api<BrainConfigResponse>('/api/brain-config'),
      api<ImproveQueueResponse>('/api/improve-queue'),
    ])
    si.value = dash.selfImprove || { pendingTask: null, lastResult: null, bootCounter: 0, lastGoodCommit: null }
    Object.assign(brainForm, brainResp.config)
    brainPresets.value = brainResp.presets
    characterPresets.value = brainResp.characterPresets || []
    characterType.value = brainResp.config.characterType || 'default'
    characterCustomPrompt.value = brainResp.config.characterCustomPrompt || ''
    improveQueue.value = queueResp.queue
    improveHistory.value = queueResp.history
    improveWeeklyCount.value = queueResp.weeklyCount
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

useVisibilityRefresh(load)

onMounted(load)
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

/* ── Character Presets ── */
.ch-presets {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.ch-preset {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 10px;
  cursor: pointer;
  transition: all .15s;
  text-align: left;
}
.ch-preset:hover {
  border-color: var(--border-glow);
  background: var(--bg-surface);
}
.ch-preset.active {
  border-color: var(--accent);
  background: rgba(168,85,247,0.06);
  box-shadow: 0 0 8px rgba(168,85,247,0.1);
}
.ch-preset-name {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.ch-preset.active .ch-preset-name {
  color: var(--accent-warm);
}
.ch-preset-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

/* ── Brain Responsiveness ── */
.br-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0 14px;
}
.br-toggle-label {
  font-size: 14px;
  color: var(--text-dim);
}
.br-toggle {
  width: 44px;
  height: 24px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  position: relative;
  transition: all .2s;
  padding: 0;
}
.br-toggle.on {
  background: rgba(168,85,247,0.2);
  border-color: var(--accent);
}
.br-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: all .2s;
}
.br-toggle.on .br-toggle-knob {
  left: 23px;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(168,85,247,0.4);
}

/* Preset tiles */
.br-presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}
.br-preset {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 10px;
  cursor: pointer;
  transition: all .15s;
  text-align: left;
}
.br-preset:hover {
  border-color: var(--border-glow);
  background: var(--bg-surface);
}
.br-preset.active {
  border-color: var(--accent);
  background: rgba(168,85,247,0.06);
  box-shadow: 0 0 8px rgba(168,85,247,0.1);
}
.br-preset-name {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.br-preset.active .br-preset-name {
  color: var(--accent-warm);
}
.br-preset-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

/* Advanced toggle */
.br-adv-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  padding: 6px 0;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  transition: color .15s;
}
.br-adv-toggle:hover { color: var(--text-dim); }
.br-adv-toggle svg {
  width: 14px;
  height: 14px;
  transition: transform .2s;
}
.br-adv-toggle svg.open { transform: rotate(180deg); }

/* Advanced fields */
.br-adv {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  margin-top: 8px;
}
.br-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Footer */
.br-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-top: 10px;
}
.br-status {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-muted);
  letter-spacing: 0.5px;
}

/* ── Self-Improvement ── */
.si-controls {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.si-max-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}
.si-week-count {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-muted);
  padding: 4px 0;
}
.si-section {
  padding: 8px 0;
}
.si-section-title {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-muted);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.si-empty {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 6px 0;
}
.si-queue-item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.si-queue-desc {
  font-size: 13px;
  color: var(--text);
  margin-bottom: 4px;
}
.si-queue-files {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-muted);
  margin-bottom: 4px;
}
.si-queue-rationale {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
  line-height: 1.4;
}
.si-queue-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.si-queue-time {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
}
.si-queue-actions {
  display: flex;
  gap: 8px;
}
.si-badge {
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
  display: inline-block;
}
.si-badge.pending { background: rgba(234,179,8,0.15); color: #eab308; }
.si-badge.approved { background: rgba(59,130,246,0.15); color: #3b82f6; }
.si-badge.running { background: rgba(168,85,247,0.15); color: #a855f7; animation: pulse 2s infinite; }
.si-badge.completed { background: rgba(34,197,94,0.15); color: #22c55e; }
.si-badge.failed { background: rgba(239,68,68,0.15); color: #ef4444; }
.si-badge.rejected { background: rgba(107,114,128,0.15); color: #6b7280; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.si-history {
  padding-top: 8px;
}
.si-history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}
.si-history-item:last-child { border-bottom: none; }
.si-history-desc {
  flex: 1;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-history-pr {
  color: var(--cyan);
  text-decoration: none;
  font-family: var(--mono);
  font-size: 11px;
}
.si-history-time {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  white-space: nowrap;
}
.btn.sm {
  font-size: 12px;
  padding: 4px 12px;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .ch-presets { grid-template-columns: repeat(2, 1fr); }
  .br-presets { grid-template-columns: repeat(2, 1fr); }
  .br-adv { grid-template-columns: 1fr; }
}
</style>
