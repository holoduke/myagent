<template>
  <div class="section">
    <LayoutSectionHeader>Directives</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Reply Directives (grouped by category) -->
      <div v-for="group in groupedReplyDirectives" :key="group.category" style="margin-bottom:16px">
        <UiCard :title="group.label" :icon="icons.reply">
          <div
            v-for="dir in group.directives"
            :key="dir.id"
            class="rd-card"
            :class="{ disabled: !dir.enabled }"
          >
            <div class="rd-header">
              <label class="toggle-wrap" @click.stop>
                <input type="checkbox" :checked="dir.enabled" @change="toggleReplyDirective(dir)">
                <span class="toggle-slider"></span>
              </label>
              <span class="rd-category">{{ dir.category }}</span>
              <div class="rd-actions">
                <button
                  v-if="!builtinCategories.includes(dir.category)"
                  class="btn-link danger"
                  @click="deleteReplyDirective(dir.id)"
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
              :disabled="rdSavingId === dir.id"
              @click="saveReplyDirective(dir)"
            >
              {{ rdSavingId === dir.id ? 'Saving...' : 'Save' }}
            </button>
          </div>

          <div v-if="group.directives.length === 0" class="rq-empty">
            No {{ group.label.toLowerCase() }} directives.
          </div>
        </UiCard>
      </div>

      <!-- Add Custom Reply Directive -->
      <UiCard title="Add Custom Directive" :icon="icons.add" style="margin-bottom:16px">
        <div class="field">
          <label>Category</label>
          <input v-model="newReplyForm.category" type="text" placeholder="e.g. vip, work, family">
        </div>
        <div class="field">
          <label>Filter prompt</label>
          <textarea v-model="newReplyForm.filterPrompt" rows="2" placeholder="Describe which messages this directive matches..."></textarea>
        </div>
        <div class="field">
          <label>Reply prompt</label>
          <textarea v-model="newReplyForm.replyPrompt" rows="2" placeholder="Instructions for generating the reply..."></textarea>
        </div>
        <div class="field">
          <label class="checkbox-label">
            <input v-model="newReplyForm.enabled" type="checkbox">
            Enabled
          </label>
        </div>
        <button
          class="btn primary"
          :disabled="rdCreating || !newReplyForm.category || !newReplyForm.filterPrompt || !newReplyForm.replyPrompt"
          @click="createReplyDirective"
        >
          {{ rdCreating ? 'Creating...' : '+ Add Directive' }}
        </button>
      </UiCard>

      <!-- Recent Reply Log -->
      <UiCard title="Recent Reply Log" :icon="icons.log" style="margin-bottom:16px">
        <div v-if="replyLogEntries.length === 0" class="rq-empty">No recent log entries.</div>
        <div v-for="entry in replyLogEntries" :key="entry.timestamp + entry.from" class="log-entry">
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

      <!-- Incoming Requests -->
      <UiCard title="Incoming Requests" :icon="icons.inbox" style="margin-bottom:16px">
        <div class="rq-filters">
          <button
            v-for="f in filters"
            :key="f.value"
            class="rq-filter"
            :class="{ active: activeFilter === f.value }"
            @click="activeFilter = f.value"
          >
            {{ f.label }}
            <span v-if="f.count > 0" class="rq-filter-count">{{ f.count }}</span>
          </button>
        </div>

        <div v-if="filteredRequests.length === 0" class="rq-empty">
          No {{ activeFilter === 'all' ? '' : activeFilter.replace('_', ' ') + ' ' }}requests
        </div>
        <DirectivesRequestCard
          v-for="req in filteredRequests"
          :key="req.id"
          :request="req"
          :acting="actingId === req.id"
          @approve="handleApprove"
          @reject="handleReject"
        />
      </UiCard>

      <!-- Actionable Requests -->
      <UiCard title="Actionable Requests" :icon="icons.actionable" style="margin-bottom:16px">
        <div class="rq-filters">
          <button
            v-for="f in arFilters"
            :key="f.value"
            class="rq-filter"
            :class="{ active: arActiveFilter === f.value }"
            @click="arActiveFilter = f.value"
          >
            {{ f.label }}
            <span v-if="f.count > 0" class="rq-filter-count">{{ f.count }}</span>
          </button>
        </div>

        <div v-if="filteredActionableRequests.length === 0" class="rq-empty">
          No {{ arActiveFilter === 'all' ? '' : arActiveFilter.replace('_', ' ') + ' ' }}actionable requests
        </div>

        <div
          v-for="ar in filteredActionableRequests"
          :key="ar.id"
          class="ar-card"
          :class="ar.status"
        >
          <div class="req-header">
            <span class="req-badge" :class="ar.status === 'pending_confirmation' ? 'pending' : ar.status">
              <span v-if="ar.status === 'auto_executed'" class="ar-check">&#10003;</span>
              {{ arStatusLabel(ar.status) }}
            </span>
            <span class="req-time">{{ timeAgo(ar.timestamp) }}</span>
          </div>
          <div class="req-contact">
            {{ ar.senderName }}
            <span v-if="ar.isGroup && ar.groupName" class="req-group">in {{ ar.groupName }}</span>
          </div>
          <div class="ar-text">{{ ar.text }}</div>
          <div v-if="ar.categories.length" class="ar-categories">
            <span v-for="cat in ar.categories" :key="cat" class="ar-cat-badge">{{ cat }}</span>
          </div>
          <div v-if="ar.status === 'pending_confirmation'" class="req-actions">
            <button class="btn primary sm" :disabled="arActingId === ar.id" @click="handleArApprove(ar.id)">Approve</button>
            <button class="btn danger sm" :disabled="arActingId === ar.id" @click="handleArReject(ar.id)">Reject</button>
          </div>
          <div v-if="ar.resolvedAt" class="req-note">Resolved {{ timeAgo(ar.resolvedAt) }}</div>
        </div>
      </UiCard>

      <!-- Directive Rules -->
      <UiCard title="Directive Rules" :icon="icons.rules" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">
          Per-contact rules that control how incoming requests are handled.
        </div>

        <div v-if="directives.length === 0 && !showEditor" class="rq-empty">
          No directives configured yet.
        </div>
        <div v-for="dir in directives" :key="dir.id" class="dir-item">
          <div class="dir-item-header">
            <span class="dir-item-contact">{{ dir.contactName }}</span>
            <span class="dir-item-action">{{ dir.actionType.replace('_', ' ') }}</span>
            <span class="dir-item-policy" :class="dir.policy">{{ dir.policy === 'auto-execute' ? 'auto' : 'confirm' }}</span>
            <span v-if="!dir.enabled" class="dir-item-disabled">disabled</span>
          </div>
          <div v-if="dir.note" class="dir-item-note">{{ dir.note }}</div>
          <div class="dir-item-actions">
            <button class="btn-link" @click="editDirective(dir)">Edit</button>
            <button class="btn-link danger" @click="handleDeleteDirective(dir.id)">Delete</button>
          </div>
        </div>

        <DirectivesDirectiveEditor
          v-if="showEditor"
          :directive="editingDirective"
          :contacts="contacts"
          :saving="directiveSaving"
          @save="handleSaveDirective"
          @cancel="showEditor = false; editingDirective = undefined"
          @delete="handleDeleteDirective"
        />

        <button v-if="!showEditor" class="btn primary" style="margin-top:8px" @click="showEditor = true; editingDirective = undefined">
          + Add Directive
        </button>
      </UiCard>

      <!-- Trusted Contacts -->
      <UiCard title="Trusted Contacts" :icon="icons.contacts">
        <div v-if="contacts.length === 0" class="rq-empty">No whitelisted contacts.</div>
        <div v-for="c in contacts" :key="c.jid" class="ct-row">
          <div class="ct-name">{{ c.name }}</div>
          <div class="ct-jid">{{ c.jid.split('@')[0] }}</div>
          <span v-if="c.permissions?.acceptCommands" class="ct-perm-badge commands">commands</span>
          <span v-else class="ct-perm-badge observe">observe only</span>
          <div class="ct-directives">
            {{ directiveCountForContact(c.jid) }} directive{{ directiveCountForContact(c.jid) === 1 ? '' : 's' }}
          </div>
        </div>
      </UiCard>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { ActionableRequest, ActionableRequestStatus, ContactRequest, Directive, DirectiveActionType, DirectivePolicy, WhitelistContact } from '~/types/aria'

const { api } = useApi()

// ── State ──
const loaded = ref(false)
const error = ref('')

// Contact requests
const requests = ref<ContactRequest[]>([])
const activeFilter = ref<'all' | 'pending' | 'auto_executed' | 'approved' | 'rejected'>('all')
const actingId = ref('')

// Actionable requests
const actionableRequests = ref<ActionableRequest[]>([])
const arActiveFilter = ref<'all' | 'pending_confirmation'>('pending_confirmation')
const arActingId = ref('')

// Contact directives
const directives = ref<Directive[]>([])
const contacts = ref<WhitelistContact[]>([])
const showEditor = ref(false)
const editingDirective = ref<Directive | undefined>(undefined)
const directiveSaving = ref(false)

// Reply directives
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

const replyDirectives = ref<ReplyDirective[]>([])
const replyLogEntries = ref<ReplyLogEntry[]>([])
const rdSavingId = ref('')
const rdCreating = ref(false)
const builtinCategories = ['stranger', 'known', 'group']

const newReplyForm = reactive({
  category: '',
  filterPrompt: '',
  replyPrompt: '',
  enabled: true,
})

// ── Icons ──
const icons = {
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>',
  rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  contacts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  actionable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
}

// ── Computed ──
const filters = computed(() => {
  const counts = { all: requests.value.length, pending: 0, auto_executed: 0, approved: 0, rejected: 0 }
  for (const r of requests.value) {
    if (r.status in counts) counts[r.status as keyof typeof counts]++
  }
  return [
    { value: 'all' as const, label: 'All', count: counts.all },
    { value: 'pending' as const, label: 'Pending', count: counts.pending },
    { value: 'auto_executed' as const, label: 'Auto-executed', count: counts.auto_executed },
    { value: 'approved' as const, label: 'Approved', count: counts.approved },
    { value: 'rejected' as const, label: 'Rejected', count: counts.rejected },
  ]
})

const filteredRequests = computed(() => {
  if (activeFilter.value === 'all') return requests.value
  return requests.value.filter(r => r.status === activeFilter.value)
})

const arFilters = computed(() => {
  const all = actionableRequests.value.length
  const pending = actionableRequests.value.filter(r => r.status === 'pending_confirmation').length
  return [
    { value: 'pending_confirmation' as const, label: 'Pending', count: pending },
    { value: 'all' as const, label: 'All', count: all },
  ]
})

const filteredActionableRequests = computed(() => {
  if (arActiveFilter.value === 'all') return actionableRequests.value
  return actionableRequests.value.filter(r => r.status === arActiveFilter.value)
})

const groupedReplyDirectives = computed(() => {
  const categoryOrder = ['stranger', 'known', 'group']
  const groups: Record<string, ReplyDirective[]> = {}

  for (const dir of replyDirectives.value) {
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

// ── Helpers ──
const arStatusLabels: Record<string, string> = {
  pending_confirmation: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  auto_executed: 'Auto-executed',
}

function arStatusLabel(status: ActionableRequestStatus): string {
  return arStatusLabels[status] || status
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function directiveCountForContact(jid: string): number {
  return directives.value.filter(d => d.contactJid === jid).length
}

function editDirective(dir: Directive) {
  editingDirective.value = dir
  showEditor.value = true
}

// ── Contact Request Actions ──
async function handleApprove(id: string) {
  actingId.value = id
  try {
    await api(`/api/contact-requests/${id}/approve`, { method: 'POST' })
    await loadRequests()
  } catch (e) {
    console.error('Failed to approve request:', e)
  } finally {
    actingId.value = ''
  }
}

async function handleReject(id: string) {
  actingId.value = id
  try {
    await api(`/api/contact-requests/${id}/reject`, { method: 'POST' })
    await loadRequests()
  } catch (e) {
    console.error('Failed to reject request:', e)
  } finally {
    actingId.value = ''
  }
}

// ── Actionable Request Actions ──
async function handleArApprove(id: string) {
  arActingId.value = id
  try {
    await api(`/api/actionable-requests/${id}/approve`, { method: 'POST' })
    await loadActionableRequests()
  } catch (e) {
    console.error('Failed to approve actionable request:', e)
  } finally {
    arActingId.value = ''
  }
}

async function handleArReject(id: string) {
  arActingId.value = id
  try {
    await api(`/api/actionable-requests/${id}/reject`, { method: 'POST' })
    await loadActionableRequests()
  } catch (e) {
    console.error('Failed to reject actionable request:', e)
  } finally {
    arActingId.value = ''
  }
}

// ── Directive CRUD ──
async function handleSaveDirective(data: { contactJid: string; contactName: string; actionType: DirectiveActionType; policy: DirectivePolicy; enabled: boolean; note?: string; id?: string }) {
  directiveSaving.value = true
  try {
    if (data.id) {
      await api(`/api/directives/${data.id}`, {
        method: 'PATCH',
        body: { policy: data.policy, enabled: data.enabled, note: data.note },
      })
    } else {
      await api('/api/directives', {
        method: 'POST',
        body: {
          contactJid: data.contactJid,
          contactName: data.contactName,
          actionType: data.actionType,
          policy: data.policy,
          note: data.note,
        },
      })
    }
    showEditor.value = false
    editingDirective.value = undefined
    await loadDirectives()
  } catch (e) {
    console.error('Failed to save directive:', e)
  } finally {
    directiveSaving.value = false
  }
}

async function handleDeleteDirective(id: string) {
  try {
    await api(`/api/directives/${id}`, { method: 'DELETE' })
    showEditor.value = false
    editingDirective.value = undefined
    await loadDirectives()
  } catch (e) {
    console.error('Failed to delete directive:', e)
  }
}

// ── Reply Directive Actions ──
async function toggleReplyDirective(dir: ReplyDirective) {
  try {
    await api(`/api/reply-directives/${dir.id}`, { method: 'PATCH', body: { enabled: !dir.enabled } })
    await loadReplyDirectives()
  } catch (e) {
    console.error('Toggle failed:', e)
  }
}

async function saveReplyDirective(dir: ReplyDirective) {
  rdSavingId.value = dir.id
  try {
    await api(`/api/reply-directives/${dir.id}`, {
      method: 'PATCH',
      body: { filterPrompt: dir.filterPrompt, replyPrompt: dir.replyPrompt },
    })
    await loadReplyDirectives()
  } catch (e) {
    console.error('Save failed:', e)
  } finally {
    rdSavingId.value = ''
  }
}

async function deleteReplyDirective(id: string) {
  if (!confirm('Delete this directive?')) return
  try {
    await api(`/api/reply-directives/${id}`, { method: 'DELETE' })
    await loadReplyDirectives()
  } catch (e) {
    console.error('Delete failed:', e)
  }
}

async function createReplyDirective() {
  rdCreating.value = true
  try {
    await api('/api/reply-directives', {
      method: 'POST',
      body: {
        category: newReplyForm.category,
        filterPrompt: newReplyForm.filterPrompt,
        replyPrompt: newReplyForm.replyPrompt,
        enabled: newReplyForm.enabled,
      },
    })
    newReplyForm.category = ''
    newReplyForm.filterPrompt = ''
    newReplyForm.replyPrompt = ''
    newReplyForm.enabled = true
    await loadReplyDirectives()
  } catch (e) {
    console.error('Create failed:', e)
  } finally {
    rdCreating.value = false
  }
}

// ── Loaders ──
async function loadRequests() {
  try { requests.value = await api<ContactRequest[]>('/api/contact-requests') } catch {}
}

async function loadDirectives() {
  try { directives.value = await api<Directive[]>('/api/directives') } catch {}
}

async function loadActionableRequests() {
  try { actionableRequests.value = await api<ActionableRequest[]>('/api/actionable-requests') } catch {}
}

async function loadReplyDirectives() {
  try {
    const [dirs, log] = await Promise.all([
      api<ReplyDirective[]>('/api/reply-directives'),
      api<ReplyLogEntry[]>('/api/reply-directives/log?limit=50'),
    ])
    replyDirectives.value = dirs
    replyLogEntries.value = log
  } catch {}
}

async function load() {
  try {
    const [reqs, dirs, cts, arReqs, rdDirs, rdLog] = await Promise.all([
      api<ContactRequest[]>('/api/contact-requests'),
      api<Directive[]>('/api/directives'),
      api<WhitelistContact[]>('/api/whitelist'),
      api<ActionableRequest[]>('/api/actionable-requests'),
      api<ReplyDirective[]>('/api/reply-directives'),
      api<ReplyLogEntry[]>('/api/reply-directives/log?limit=50'),
    ])
    requests.value = reqs
    directives.value = dirs
    contacts.value = cts
    actionableRequests.value = arReqs
    replyDirectives.value = rdDirs
    replyLogEntries.value = rdLog
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

/* ── Request Filters ── */
.rq-filters {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.rq-filter {
  font-size: 11px;
  font-family: var(--mono);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-muted);
  cursor: pointer;
  transition: all .15s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.rq-filter:hover { border-color: var(--border-glow); color: var(--text-dim); }
.rq-filter.active {
  border-color: var(--accent);
  background: rgba(168,85,247,0.06);
  color: var(--accent);
}
.rq-filter-count {
  font-size: 10px;
  background: rgba(168,85,247,0.15);
  padding: 1px 5px;
  border-radius: 3px;
}
.rq-empty {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 8px 0;
}

/* ── Reply Directive Cards ── */
.rd-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 10px;
  transition: opacity 0.15s;
}
.rd-card.disabled { opacity: 0.5; }
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
.rd-actions { margin-left: auto; }

/* ── Toggle Switch ── */
.toggle-wrap {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle-wrap input { opacity: 0; width: 0; height: 0; position: absolute; }
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
.toggle-wrap input:checked + .toggle-slider { background: var(--accent); }
.toggle-wrap input:checked + .toggle-slider::before { transform: translateX(14px); }

/* ── Fields ── */
.field { margin-bottom: 10px; }
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
.field textarea { resize: vertical; }
.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.checkbox-label input[type="checkbox"] { width: auto; }

/* ── Directive Items ── */
.dir-item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.dir-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dir-item-contact { font-size: 13px; font-weight: 600; color: var(--text); }
.dir-item-action {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.dir-item-policy {
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
}
.dir-item-policy.auto-execute { background: rgba(59,130,246,0.15); color: #3b82f6; }
.dir-item-policy.require-confirmation { background: rgba(234,179,8,0.15); color: #eab308; }
.dir-item-disabled {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--text-ghost);
  text-transform: uppercase;
}
.dir-item-note { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.4; }
.dir-item-actions { display: flex; gap: 10px; margin-top: 6px; }

/* ── Buttons ── */
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
.btn:hover { color: var(--text); border-color: var(--text-muted); }
.btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn.primary:hover { opacity: 0.9; }
.btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.sm { padding: 4px 10px; font-size: 11px; }
.btn-link {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: opacity .15s;
}
.btn-link:hover { opacity: 0.7; }
.btn-link.danger { color: var(--red); }

/* ── Contacts ── */
.ct-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.ct-row:last-child { border-bottom: none; }
.ct-name { font-size: 13px; font-weight: 600; color: var(--text); }
.ct-jid { font-size: 11px; font-family: var(--mono); color: var(--text-muted); }
.ct-perm-badge {
  font-size: 10px;
  font-family: var(--mono);
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: auto;
}
.ct-perm-badge.commands { background: rgba(34,197,94,0.15); color: #22c55e; }
.ct-perm-badge.observe { background: rgba(107,114,128,0.15); color: #6b7280; }
.ct-directives {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  white-space: nowrap;
}

/* ── Actionable Requests ── */
.ar-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  transition: border-color .15s;
}
.ar-card.pending_confirmation { border-left: 3px solid #eab308; }
.ar-card.approved { border-left: 3px solid #22c55e; }
.ar-card.rejected { border-left: 3px solid #6b7280; }
.ar-card.auto_executed { border-left: 3px solid #3b82f6; }
.ar-text {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
  margin-bottom: 6px;
  padding: 6px 8px;
  background: var(--bg-surface);
  border-radius: 6px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.ar-categories { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.ar-cat-badge {
  font-size: 10px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(168,85,247,0.12);
  color: var(--accent);
  text-transform: lowercase;
}
.ar-check { color: #22c55e; margin-right: 2px; }

/* ── Reply Log ── */
.log-entry {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.log-entry:last-child { border-bottom: none; }
.log-header { display: flex; align-items: center; gap: 8px; }
.log-sender { font-weight: 600; color: var(--text); }
.log-decision {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}
.log-decision.replied { background: rgba(34,197,94,0.15); color: #22c55e; }
.log-decision.skipped { background: rgba(255,255,255,0.05); color: var(--text-ghost); }
.log-time { margin-left: auto; color: var(--text-ghost); }
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
  .rq-filters { gap: 4px; }
  .ct-row { flex-wrap: wrap; }
}
</style>
