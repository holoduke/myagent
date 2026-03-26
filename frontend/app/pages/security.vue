<template>
  <div class="section">
    <LayoutSectionHeader>Trust &amp; Security</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Trust Sources -->
      <UiCard title="Trust Sources" :icon="icons.shield" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Configure default trust level per message source. Owner-level contacts bypass injection filtering.</div>
        <div class="ts-list">
          <div v-for="(rule, source) in trustForm.sources" :key="source" class="ts-row">
            <div class="ts-source">{{ source }}</div>
            <div class="ts-controls">
              <select
                class="intg-input intg-input-sm"
                :value="rule.defaultTrust"
                @change="updateSourceTrust(source as string, ($event.target as HTMLSelectElement).value as any)"
              >
                <option value="owner">Owner</option>
                <option value="trusted">Trusted</option>
                <option value="untrusted">Untrusted</option>
              </select>
              <div class="ts-owner-toggle">
                <span class="ts-toggle-label">Owner always trusted</span>
                <button
                  class="br-toggle"
                  :class="{ on: rule.ownerAlwaysTrusted }"
                  @click="toggleOwnerAlways(source as string)"
                >
                  <span class="br-toggle-knob" />
                </button>
              </div>
            </div>
            <!-- JID Overrides -->
            <div v-if="rule.jidOverrides && Object.keys(rule.jidOverrides).length" class="ts-overrides">
              <div class="ts-overrides-title">JID Overrides</div>
              <div v-for="(level, jid) in rule.jidOverrides" :key="jid" class="ts-override-row">
                <span class="ts-override-jid">{{ jid }}</span>
                <select
                  class="intg-input intg-input-sm"
                  :value="level"
                  @change="updateJidOverride(source as string, jid as string, ($event.target as HTMLSelectElement).value as any)"
                >
                  <option value="owner">Owner</option>
                  <option value="trusted">Trusted</option>
                  <option value="untrusted">Untrusted</option>
                </select>
                <button class="btn danger sm" @click="removeJidOverride(source as string, jid as string)">Remove</button>
              </div>
            </div>
          </div>
        </div>
        <div class="br-footer">
          <div class="br-status">{{ Object.keys(trustForm.sources).length }} source(s) configured</div>
          <button v-if="dirty" class="btn primary" :disabled="saving" @click="saveTrustConfig">
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </UiCard>

      <!-- Owner JIDs -->
      <UiCard title="Owner JIDs" :icon="icons.user" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">JIDs that are always treated as the owner. Messages from these contacts are fully trusted.</div>
        <div class="oj-list">
          <div v-for="(jid, idx) in trustForm.ownerJids" :key="idx" class="oj-row">
            <span class="oj-jid">{{ jid }}</span>
            <button class="btn danger sm" @click="removeOwnerJid(idx)">Remove</button>
          </div>
          <div v-if="trustForm.ownerJids.length === 0" class="si-empty">No owner JIDs configured</div>
        </div>
        <div class="oj-add">
          <input
            v-model="newOwnerJid"
            class="intg-input"
            placeholder="Add JID (e.g. 31612345678@s.whatsapp.net)"
            @keyup.enter="addOwnerJid"
          />
          <button class="btn primary sm" :disabled="!newOwnerJid.trim()" @click="addOwnerJid">Add</button>
        </div>
        <div class="br-footer">
          <div class="br-status">{{ trustForm.ownerJids.length }} owner JID(s)</div>
          <button v-if="dirty" class="btn primary" :disabled="saving" @click="saveTrustConfig">
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </UiCard>

      <!-- Injection Logging -->
      <UiCard title="Injection Logging" :icon="icons.log" style="margin-bottom:16px">
        <div class="br-toggle-row">
          <span class="br-toggle-label">Log injection attempts</span>
          <button
            class="br-toggle"
            :class="{ on: trustForm.logInjectionAttempts }"
            @click="trustForm.logInjectionAttempts = !trustForm.logInjectionAttempts; dirty = true"
          >
            <span class="br-toggle-knob" />
          </button>
        </div>
        <div style="font-size:11px;color:var(--text-ghost)">When enabled, suspected prompt injection attempts are logged for review below.</div>
        <div class="br-footer">
          <div class="br-status">Logging {{ trustForm.logInjectionAttempts ? 'enabled' : 'disabled' }}</div>
          <button v-if="dirty" class="btn primary" :disabled="saving" @click="saveTrustConfig">
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </UiCard>

      <!-- Injection Log -->
      <UiCard title="Injection Log" :icon="icons.alert" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Recent suspected injection attempts detected by the trust layer.</div>
        <div v-if="injectionLog.length === 0" class="si-empty">No injection attempts logged</div>
        <div v-for="(entry, idx) in injectionLog" :key="idx" class="il-entry">
          <div class="il-header">
            <span class="il-sender">{{ entry.sender }}</span>
            <span class="il-source">{{ entry.source }}</span>
            <span v-if="entry.isGroup" class="il-group">{{ entry.groupName || 'group' }}</span>
            <span class="il-time">{{ timeAgo(entry.t) }}</span>
          </div>
          <div class="il-labels">
            <span v-for="label in entry.labels" :key="label" class="il-badge">{{ label }}</span>
          </div>
          <div class="il-preview">{{ entry.textPreview }}</div>
          <div v-if="entry.snippets.length" class="il-snippets">
            <div v-for="(snip, si) in entry.snippets" :key="si" class="il-snippet">{{ snip }}</div>
          </div>
        </div>
      </UiCard>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { TrustConfig, InjectionLogEntry } from '~/types/aria'

const { api } = useApi()

const loaded = ref(false)
const error = ref('')
const dirty = ref(false)
const saving = ref(false)
const newOwnerJid = ref('')

const trustForm = reactive<TrustConfig>({
  sources: {},
  ownerJids: [],
  logInjectionAttempts: false,
})

const injectionLog = ref<InjectionLogEntry[]>([])

const icons = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
}

function updateSourceTrust(source: string, level: 'owner' | 'trusted' | 'untrusted') {
  trustForm.sources[source].defaultTrust = level
  dirty.value = true
}

function toggleOwnerAlways(source: string) {
  trustForm.sources[source].ownerAlwaysTrusted = !trustForm.sources[source].ownerAlwaysTrusted
  dirty.value = true
}

function updateJidOverride(source: string, jid: string, level: 'owner' | 'trusted' | 'untrusted') {
  if (trustForm.sources[source].jidOverrides) {
    trustForm.sources[source].jidOverrides![jid] = level
    dirty.value = true
  }
}

function removeJidOverride(source: string, jid: string) {
  if (trustForm.sources[source].jidOverrides) {
    delete trustForm.sources[source].jidOverrides![jid]
    dirty.value = true
  }
}

function addOwnerJid() {
  const jid = newOwnerJid.value.trim()
  if (!jid) return
  if (!trustForm.ownerJids.includes(jid)) {
    trustForm.ownerJids.push(jid)
    dirty.value = true
  }
  newOwnerJid.value = ''
}

function removeOwnerJid(idx: number) {
  trustForm.ownerJids.splice(idx, 1)
  dirty.value = true
}

async function saveTrustConfig() {
  saving.value = true
  try {
    const resp = await api<TrustConfig>('/api/trust/config', {
      method: 'PUT',
      body: toRaw(trustForm),
    })
    Object.assign(trustForm, resp)
    dirty.value = false
  } catch (e) {
    console.error('Failed to save trust config:', e)
  } finally {
    saving.value = false
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

async function load() {
  try {
    const [config, log] = await Promise.all([
      api<TrustConfig>('/api/trust/config'),
      api<InjectionLogEntry[]>('/api/trust/injection-log'),
    ])
    Object.assign(trustForm, config)
    injectionLog.value = log
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

/* ── Trust Sources ── */
.ts-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ts-row {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.ts-source {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
  text-transform: capitalize;
}
.ts-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.ts-owner-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ts-toggle-label {
  font-size: 12px;
  color: var(--text-muted);
}
.ts-overrides {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.ts-overrides-title {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-muted);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.ts-override-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.ts-override-jid {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-dim);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Toggle (reuse settings pattern) ── */
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

/* ── Footer (reuse settings pattern) ── */
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

/* ── Owner JIDs ── */
.oj-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.oj-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
}
.oj-jid {
  font-size: 13px;
  font-family: var(--mono);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oj-add {
  display: flex;
  gap: 8px;
  align-items: center;
}
.oj-add .intg-input {
  flex: 1;
}

/* ── Injection Log ── */
.il-entry {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.il-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.il-sender {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.il-source {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--accent);
  background: rgba(168,85,247,0.1);
  padding: 1px 6px;
  border-radius: 4px;
}
.il-group {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--cyan);
  background: rgba(6,182,212,0.1);
  padding: 1px 6px;
  border-radius: 4px;
}
.il-time {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  margin-left: auto;
}
.il-labels {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.il-badge {
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(239,68,68,0.15);
  color: #ef4444;
}
.il-preview {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
  word-break: break-word;
}
.il-snippets {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.il-snippet {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-muted);
  background: var(--bg-surface);
  padding: 4px 8px;
  border-radius: 4px;
  margin-bottom: 4px;
  word-break: break-all;
}

/* ── Shared ── */
.si-empty {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 6px 0;
}
.btn.sm {
  font-size: 12px;
  padding: 4px 12px;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .ts-controls { flex-direction: column; align-items: flex-start; }
  .oj-add { flex-direction: column; }
}
</style>
