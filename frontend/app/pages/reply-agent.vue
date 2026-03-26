<template>
  <div class="section">
    <LayoutSectionHeader>Reply Agent</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Directives by category -->
      <div v-for="cat in orderedCategories" :key="cat" style="margin-bottom:16px">
        <UiCard :title="categoryLabel(cat)" :icon="icons.inbox">
          <div v-if="directivesByCategory(cat).length === 0" class="empty">
            No directives in this category.
          </div>

          <div v-for="d in directivesByCategory(cat)" :key="d.id" class="directive-item" :class="{ disabled: !d.enabled }">
            <div class="directive-header">
              <label class="toggle-wrap" @click.stop>
                <input type="checkbox" :checked="d.enabled" @change="toggleDirective(d)">
                <span class="toggle-slider"></span>
              </label>
              <span class="directive-cat">{{ d.category }}</span>
              <div class="directive-actions">
                <button class="btn-link" @click="editDirective(d)">Edit</button>
                <button class="btn-link danger" @click="deleteDirective(d.id)">Delete</button>
              </div>
            </div>

            <div class="directive-field">
              <div class="directive-label">Filter Prompt</div>
              <div class="directive-val">{{ d.filterPrompt }}</div>
            </div>
            <div class="directive-field">
              <div class="directive-label">Reply Prompt</div>
              <div class="directive-val">{{ d.replyPrompt }}</div>
            </div>
          </div>
        </UiCard>
      </div>

      <!-- Editor -->
      <UiCard v-if="showEditor" title="Directive Editor" :icon="icons.edit" style="margin-bottom:16px">
        <div class="editor">
          <div class="field">
            <label>Category</label>
            <input v-model="form.category" type="text" placeholder="stranger, known, group, or custom name">
          </div>
          <div class="field">
            <label>Filter Prompt</label>
            <textarea v-model="form.filterPrompt" rows="3" placeholder="Describe which messages this directive should match..."></textarea>
          </div>
          <div class="field">
            <label>Reply Prompt</label>
            <textarea v-model="form.replyPrompt" rows="3" placeholder="Instructions for how to reply when matched..."></textarea>
          </div>
          <div class="field">
            <label class="checkbox-label">
              <input v-model="form.enabled" type="checkbox">
              Enabled
            </label>
          </div>
          <div class="editor-actions">
            <button class="btn primary" :disabled="saving || !form.category || !form.filterPrompt || !form.replyPrompt" @click="saveDirective">
              {{ saving ? 'Saving...' : (editing ? 'Update' : 'Create') }}
            </button>
            <button class="btn" @click="cancelEdit">Cancel</button>
          </div>
        </div>
      </UiCard>

      <button v-if="!showEditor" class="btn primary" style="margin-bottom:16px" @click="startNew">
        + Add Directive
      </button>

      <!-- Recent Log -->
      <UiCard title="Recent Reply Log" :icon="icons.log">
        <div v-if="logEntries.length === 0" class="empty">No log entries yet.</div>
        <div v-for="entry in logEntries" :key="entry.timestamp + entry.from" class="log-entry">
          <div class="log-header">
            <span class="log-sender">{{ entry.from }}</span>
            <span class="log-action" :class="{ reply: entry.decision?.action === 'reply', ignore: entry.decision?.action !== 'reply' }">
              {{ entry.decision?.action || 'unknown' }}
            </span>
            <span class="log-time">{{ timeAgo(entry.timestamp) }}</span>
          </div>
          <div class="log-message">{{ entry.message }}</div>
          <div v-if="entry.decision?.reply" class="log-reply">{{ entry.decision.reply }}</div>
          <div v-if="entry.decision?.reason" class="log-reason">{{ entry.decision.reason }}</div>
        </div>
      </UiCard>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
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
  decision?: {
    action: string
    reply?: string
    reason?: string
  }
}

const { api } = useApi()

const loaded = ref(false)
const error = ref('')
const directives = ref<ReplyDirective[]>([])
const logEntries = ref<ReplyLogEntry[]>([])
const saving = ref(false)

// Editor state
const showEditor = ref(false)
const editing = ref<ReplyDirective | null>(null)

const form = reactive({
  category: '',
  filterPrompt: '',
  replyPrompt: '',
  enabled: true,
})

const icons = {
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
}

const STANDARD_CATEGORIES = ['stranger', 'known', 'group']

const orderedCategories = computed(() => {
  const cats = new Set(directives.value.map(d => d.category))
  const ordered: string[] = []
  for (const c of STANDARD_CATEGORIES) {
    if (cats.has(c)) {
      ordered.push(c)
      cats.delete(c)
    }
  }
  // Add remaining custom categories sorted
  for (const c of [...cats].sort()) {
    ordered.push(c)
  }
  return ordered
})

function directivesByCategory(cat: string): ReplyDirective[] {
  return directives.value.filter(d => d.category === cat)
}

function categoryLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1)
}

function timeAgo(ts: number | string): string {
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts
  const diff = Date.now() - t
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function startNew() {
  editing.value = null
  form.category = ''
  form.filterPrompt = ''
  form.replyPrompt = ''
  form.enabled = true
  showEditor.value = true
}

function editDirective(d: ReplyDirective) {
  editing.value = d
  form.category = d.category
  form.filterPrompt = d.filterPrompt
  form.replyPrompt = d.replyPrompt
  form.enabled = d.enabled
  showEditor.value = true
}

function cancelEdit() {
  showEditor.value = false
  editing.value = null
}

async function saveDirective() {
  saving.value = true
  try {
    const body = {
      category: form.category,
      filterPrompt: form.filterPrompt,
      replyPrompt: form.replyPrompt,
      enabled: form.enabled,
    }
    if (editing.value) {
      await api(`/api/reply-directives/${editing.value.id}`, { method: 'PATCH', body })
    } else {
      await api('/api/reply-directives', { method: 'POST', body })
    }
    await loadData()
    cancelEdit()
  } catch (e) {
    console.error('Save failed:', e)
  } finally {
    saving.value = false
  }
}

async function toggleDirective(d: ReplyDirective) {
  try {
    await api(`/api/reply-directives/${d.id}`, { method: 'PATCH', body: { enabled: !d.enabled } })
    await loadData()
  } catch (e) {
    console.error('Toggle failed:', e)
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

async function loadData() {
  try {
    const [d, l] = await Promise.all([
      api<ReplyDirective[]>('/api/reply-directives'),
      api<ReplyLogEntry[]>('/api/reply-directives/log?limit=50'),
    ])
    directives.value = d
    logEntries.value = l
    loaded.value = true
  } catch (e) {
    error.value = String(e)
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

/* Directive items */
.directive-item {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  transition: opacity 0.15s;
}
.directive-item.disabled {
  opacity: 0.5;
}
.directive-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.directive-cat {
  font-weight: 600;
  font-size: 14px;
  color: var(--text);
  font-family: var(--mono);
}
.directive-actions {
  margin-left: auto;
  display: flex;
  gap: 12px;
}
.directive-field {
  background: var(--bg);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
}
.directive-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  font-family: var(--mono);
  margin-bottom: 2px;
}
.directive-val {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.5;
  white-space: pre-wrap;
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
  padding: 4px 0;
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
.log-action {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}
.log-action.reply {
  background: rgba(34,197,94,0.15);
  color: #22c55e;
}
.log-action.ignore {
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
  font-size: 13px;
}
.log-reply {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
  margin-top: 4px;
  padding-left: 10px;
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
