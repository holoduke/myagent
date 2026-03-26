<template>
  <div class="section">
    <LayoutSectionHeader>Audit Log</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Limit selector -->
      <div class="audit-controls">
        <label class="audit-limit-label">Show</label>
        <select v-model="limit" class="audit-limit-select" @change="load()">
          <option v-for="opt in limitOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <span class="audit-limit-label">entries</span>
        <span class="audit-count">{{ entries.length }} loaded</span>
      </div>

      <!-- Entries list -->
      <div v-if="entries.length === 0" class="audit-empty">No audit entries found.</div>
      <div class="audit-list">
        <div v-for="(entry, i) in entries" :key="i" class="audit-entry">
          <div class="audit-entry-header">
            <span class="audit-timestamp">{{ timeAgo(entry.timestamp) }}</span>
            <span class="audit-action">{{ entry.action }}</span>
            <span class="audit-source">{{ entry.source }}</span>
            <span class="audit-status" :class="entry.success ? 'success' : 'fail'">
              {{ entry.success ? 'OK' : 'FAIL' }}
            </span>
          </div>
          <div v-if="entry.details" class="audit-details">{{ entry.details }}</div>
        </div>
      </div>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { AuditEntry } from '~/types/aria'

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const loaded = ref(false)
const error = ref('')
const entries = ref<AuditEntry[]>([])
const limit = ref(100)
const limitOptions = [25, 50, 100, 200]

async function load() {
  try {
    const data = await api<AuditEntry[]>(`/api/audit?limit=${limit.value}`)
    entries.value = data.sort((a, b) => b.timestamp - a.timestamp)
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

/* ── Controls ── */
.audit-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.audit-limit-label {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-muted);
}
.audit-limit-select {
  font-size: 12px;
  font-family: var(--mono);
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.audit-limit-select:focus {
  outline: none;
  border-color: var(--accent);
}
.audit-count {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  margin-left: auto;
}

/* ── Empty State ── */
.audit-empty {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 8px 0;
}

/* ── Entry List ── */
.audit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.audit-entry {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.audit-entry-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.audit-timestamp {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  min-width: 70px;
}
.audit-action {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.audit-source {
  font-size: 10px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(168, 85, 247, 0.1);
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.audit-status {
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: auto;
}
.audit-status.success {
  background: rgba(34, 197, 94, 0.15);
  color: var(--green);
}
.audit-status.fail {
  background: rgba(239, 68, 68, 0.15);
  color: var(--red);
}
.audit-details {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-muted);
  margin-top: 6px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .audit-entry-header { gap: 6px; }
}
</style>
