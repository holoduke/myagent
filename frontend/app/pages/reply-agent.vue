<template>
  <div class="section">
    <LayoutSectionHeader>Reply Agent</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Directive Cards grouped by category -->
      <div v-for="group in groupedDirectives" :key="group.category" style="margin-bottom:16px">
        <UiCard :title="group.label" :icon="icons.directive">
          <div
            v-for="dir in group.directives"
            :key="dir.id"
            class="rd-card"
            :class="{ disabled: !dir.enabled }"
          >
            <div class="rd-header">
              <label class="toggle-wrap" @click.stop>
                <input type="checkbox" :checked="dir.enabled" @change="toggleDirective(dir)">
                <span class="toggle-slider"></span>
              </label>
              <span class="rd-category">{{ dir.category }}</span>
              <div class="rd-actions">
                <button
                  v-if="!builtinCategories.includes(dir.category)"
                  class="btn-link danger"
                  @click="deleteDirective(dir.id)"
                >Delete</button>
              </div>
            </div>

            <div class="field">
              <label>Filter prompt</label>
              <textarea
                v-model="dir.filterPrompt"
                rows="2"
                placeholder="Describe which messages this directive matches..."
              ></textarea>
            </div>

            <div class="field">
              <label>Reply prompt</label>
              <textarea
                v-model="dir.replyPrompt"
                rows="2"
                placeholder="Instructions for generating the reply..."
              ></textarea>
            </div>

            <button
              class="btn primary sm"
              :disabled="savingId === dir.id"
              @click="saveDirective(dir)"
            >
              {{ savingId === dir.id ? 'Saving...' : 'Save' }}
            </button>
          </div>

          <div v-if="group.directives.length === 0" class="empty">
            No {{ group.label.toLowerCase() }} directives.
          </div>
        </UiCard>
      </div>

      <!-- Add Custom Directive -->
      <UiCard title="Add Custom Directive" :icon="icons.add" style="margin-bottom:16px">
        <div class="field">
          <label>Category</label>
          <input v-model="newForm.category" type="text" placeholder="e.g. vip, work, family">
        </div>
        <div class="field">
          <label>Filter prompt</label>
          <textarea v-model="newForm.filterPrompt" rows="2" placeholder="Describe which messages this directive matches..."></textarea>
        </div>
        <div class="field">
          <label>Reply prompt</label>
          <textarea v-model="newForm.replyPrompt" rows="2" placeholder="Instructions for generating the reply..."></textarea>
        </div>
        <div class="field">
          <label class="checkbox-label">
            <input v-model="newForm.enabled" type="checkbox">
            Enabled
          </label>
        </div>
        <button
          class="btn primary"
          :disabled="creating || !newForm.category || !newForm.filterPrompt || !newForm.replyPrompt"
          @click="createDirective"
        >
          {{ creating ? 'Creating...' : '+ Add Directive' }}
        </button>
      </UiCard>

      <!-- Recent Log -->
      <UiCard title="Recent Reply Log" :icon="icons.log">
        <div v-if="logEntries.length === 0" class="empty">No recent log entries.</div>
        <div v-for="entry in logEntries" :key="entry.timestamp + entry.from" class="log-entry">
          <div class="log-header">
            <span class="log-sender">{{ entry.from }}</span>
            <span
              class="log-decision"
              :class="entry.decision.action === 'reply' ? 'replied' : 'skipped'"
            >
              {{ entry.decision.action }}
            </span>
            <span class="log-time">{{ timeAgo(entry.timestamp) }}</span>
          </div>
          <div class="log-message">{{ entry.message }}</div>
          <div v-if="entry.decision.reply" class="log-reply">{{ entry.decision.reply }}</div>
          <div v-if="entry.decision.reason" class="log-reason">{{ entry.decision.reason }}</div>
        </div>
      </UiCard>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
const { api } = useApi()

interface ReplyDirective {
  id: string
  category: string
  filterPrompt: string
  replyPrompt: string
  enabled: boolean
}

interface ReplyLogEntry {
  timestamp: number
  from: string
  message: string
  decision: {
    action: string
    reply?: string
    reason?: string
  }
}

const loaded = ref(false)
const error = ref('')
const directives = ref<ReplyDirective[]>([])
const logEntries = ref<ReplyLogEntry[]>([])
const savingId = ref('')
const creating = ref(false)

const builtinCategories = ['stranger', 'known', 'group']

const newForm = reactive({
  category: '',
  filterPrompt: '',
  replyPrompt: '',
  enabled: true,
})

const icons = {
  directive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
}

const groupedDirectives = computed(() => {
  const categoryOrder = ['stranger', 'known', 'group']
  const groups: Record<string, ReplyDirective[]> = {}

  for (const dir of directives.value) {
    if (!groups[dir.category]) groups[dir.category] = []
    groups[dir.category].push(dir)
  }

  const result: { category: string; label: string; directives: ReplyDirective[] }[] = []

  for (const cat of categoryOrder) {
    if (groups[cat]) {
      result.push({ category: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1), directives: groups[cat] })
      delete groups[cat]
    }
  }

  for (const [cat, dirs] of Object.entries(groups)) {
    result.push({ category: cat, label: cat.charAt(0).toUpperCase() + cat.slice(1), directives: dirs })
  }

  return result
})

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

async function toggleDirective(dir: ReplyDirective) {
  try {
    await api(`/api/reply-directives/${dir.id}`, { method: 'PATCH', body: { enabled: !dir.enabled } })
    await loadData()
  } catch (e) {
    console.error('Toggle failed:', e)
  }
}

async function saveDirective(dir: ReplyDirective) {
  savingId.value = dir.id
  try {
    await api(`/api/reply-directives/${dir.id}`, {
      method: 'PATCH',
      body: {
        filterPrompt: dir.filterPrompt,
        replyPrompt: dir.replyPrompt,
      },
    })
    await loadData()
  } catch (e) {
    console.error('Save failed:', e)
  } finally {
    savingId.value = ''
  }
}

async function deleteDirective(id: string) {
  if (!confirm('Delete this directive?')) return
  try {
    await api(`/api/reply-directives/${id}`, { method: 'DELETE' })
    await loadData()
  } catch (e) {
    console.error('Delete failed:', e)
  }
}

async function createDirective() {
  creating.value = true
  try {
    await api('/api/reply-directives', {
      method: 'POST',
      body: {
        category: newForm.category,
        filterPrompt: newForm.filterPrompt,
        replyPrompt: newForm.replyPrompt,
        enabled: newForm.enabled,
      },
    })
    newForm.category = ''
    newForm.filterPrompt = ''
    newForm.replyPrompt = ''
    newForm.enabled = true
    await loadData()
  } catch (e) {
    console.error('Create failed:', e)
  } finally {
    creating.value = false
  }
}

async function loadData() {
  try {
    const [dirs, log] = await Promise.all([
      api<ReplyDirective[]>('/api/reply-directives'),
      api<ReplyLogEntry[]>('/api/reply-directives/log?limit=50'),
    ])
    directives.value = dirs
    logEntries.value = log
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

onMounted(loadData)
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

.empty {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 12px 0;
}

/* Directive cards */
.rd-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 10px;
  transition: opacity 0.15s;
}
.rd-card.disabled {
  opacity: 0.5;
}
.rd-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.rd-category {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.rd-actions {
  margin-left: auto;
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

/* Fields */
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
.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.checkbox-label input[type="checkbox"] {
  width: auto;
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
.btn.sm {
  padding: 4px 10px;
  font-size: 11px;
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
.log-sender {
  font-weight: 600;
  color: var(--text);
}
.log-decision {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}
.log-decision.replied {
  background: rgba(34,197,94,0.15);
  color: #22c55e;
}
.log-decision.skipped {
  background: rgba(255,255,255,0.05);
  color: var(--text-ghost);
}
.log-time {
  margin-left: auto;
  color: var(--text-ghost);
}
.log-message {
  color: var(--text-dim);
  margin-top: 4px;
  padding: 4px 8px;
  background: var(--bg-surface);
  border-radius: 4px;
}
.log-reply {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
  margin-top: 4px;
  padding: 4px 8px;
  background: rgba(168,85,247,0.06);
  border-radius: 4px;
  border-left: 2px solid var(--accent);
}
.log-reason {
  color: var(--text-ghost);
  font-size: 11px;
  margin-top: 2px;
  font-style: italic;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
}
</style>
