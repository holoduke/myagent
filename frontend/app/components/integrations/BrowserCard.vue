<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2" style="width:20px;height:20px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
      <h3>Browser</h3>
      <span class="intg-status" :class="browser.ready ? 'online' : 'offline'">
        {{ browser.ready ? 'Ready' : 'Idle' }}
      </span>
    </div>

    <div class="browser-stats">
      <UiKvRow label="Total tasks" :value="String(browser.totalTasks)" />
      <UiKvRow label="Active sessions" :value="String(browser.activeSessions)" />
      <UiKvRow v-if="browser.lastTaskAt" label="Last task" :value="timeAgo(browser.lastTaskAt)" />
    </div>

    <!-- Quick navigate -->
    <div class="browser-action-section">
      <label class="intg-label">Quick Navigate</label>
      <div class="browser-form">
        <input v-model="navUrl" placeholder="https://example.com" class="intg-input" style="flex:1" @keyup.enter="navigate" />
        <button class="btn" :disabled="!navUrl.trim() || loading" @click="navigate">Go</button>
      </div>
    </div>

    <!-- Quick extract -->
    <div class="browser-action-section">
      <label class="intg-label">Extract Text</label>
      <div class="browser-form">
        <input v-model="extractUrl" placeholder="URL" class="intg-input" style="flex:1" @keyup.enter="extract" />
        <input v-model="extractSelector" placeholder="CSS selector" class="intg-input" style="flex:0.6" @keyup.enter="extract" />
        <button class="btn" :disabled="!extractUrl.trim() || !extractSelector.trim() || loading" @click="extract">Extract</button>
      </div>
    </div>

    <!-- Result -->
    <div v-if="lastResult" class="browser-result" :class="{ 'browser-result--error': !lastResult.success }">
      <div class="browser-result-header">
        <span v-if="lastResult.success" class="browser-result-title">{{ lastResult.title || lastResult.url }}</span>
        <span v-else class="browser-result-error">{{ lastResult.error }}</span>
        <span class="browser-result-time">{{ lastResult.durationMs }}ms</span>
      </div>
      <pre v-if="lastResult.content" class="browser-result-content">{{ lastResult.content.slice(0, 2000) }}</pre>
    </div>

    <!-- Recent tasks -->
    <template v-if="browser.recentTasks.length">
      <label class="intg-label" style="margin-top:14px">Recent Tasks</label>
      <div v-for="task in browser.recentTasks.slice(0, 5)" :key="task.id" class="browser-task-row">
        <UiStatusDot :status="task.success ? 'ok' : 'err'" />
        <span class="browser-task-type">{{ task.type }}</span>
        <span class="browser-task-url">{{ task.url ? truncateUrl(task.url) : '—' }}</span>
        <span class="browser-task-meta">{{ task.durationMs }}ms &middot; {{ timeAgo(task.completedAt) }}</span>
      </div>
      <button class="btn danger" style="margin-top:8px;font-size:11px;padding:4px 10px" @click="clearHistory">Clear history</button>
    </template>
    <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
      No browser tasks yet
    </div>

    <p v-if="errorMsg" class="browser-error">{{ errorMsg }}</p>
  </div>
</template>

<script setup lang="ts">
import type { BrowserStatus, BrowserTaskResult } from '~/types/aria'

defineProps<{
  browser: BrowserStatus
}>()

const emit = defineEmits<{
  reload: []
}>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const navUrl = ref('')
const extractUrl = ref('')
const extractSelector = ref('')
const loading = ref(false)
const lastResult = ref<BrowserTaskResult | null>(null)
const errorMsg = ref('')

function truncateUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '...' : u.pathname
    return u.hostname + path
  } catch {
    return url.slice(0, 50)
  }
}

async function navigate() {
  if (!navUrl.value.trim()) return
  loading.value = true
  errorMsg.value = ''
  try {
    const result = await api<BrowserTaskResult>('/api/browser/navigate', {
      method: 'POST',
      body: { url: navUrl.value.trim() },
    })
    lastResult.value = result
    emit('reload')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Navigation failed'
  } finally {
    loading.value = false
  }
}

async function extract() {
  if (!extractUrl.value.trim() || !extractSelector.value.trim()) return
  loading.value = true
  errorMsg.value = ''
  try {
    const result = await api<BrowserTaskResult>('/api/browser/extract', {
      method: 'POST',
      body: { url: extractUrl.value.trim(), selector: extractSelector.value.trim() },
    })
    lastResult.value = result
    emit('reload')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Extraction failed'
  } finally {
    loading.value = false
  }
}

async function clearHistory() {
  try {
    await api('/api/browser/history', { method: 'DELETE' })
    emit('reload')
  } catch {
    // silent
  }
}
</script>

<style scoped>
.browser-stats { padding: 4px 0 8px; }
.browser-action-section { margin-top: 10px; }
.browser-form {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.browser-result {
  margin-top: 10px;
  padding: 10px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.browser-result--error { border-color: var(--red); }
.browser-result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.browser-result-title { font-size: 13px; color: var(--text); font-weight: 500; }
.browser-result-error { font-size: 13px; color: var(--red); }
.browser-result-time { font-family: var(--mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.browser-result-content {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}
.browser-task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.browser-task-type {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
  text-transform: uppercase;
  min-width: 60px;
}
.browser-task-url { font-size: 12px; color: var(--text-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-task-meta { font-family: var(--mono); font-size: 10px; color: var(--text-ghost); flex-shrink: 0; }
.browser-error { color: var(--red); font-size: 12px; margin-top: 8px; }
</style>
