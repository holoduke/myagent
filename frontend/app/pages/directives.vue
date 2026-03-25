<template>
  <div class="section">
    <LayoutSectionHeader>Directives</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Incoming Requests -->
      <UiCard title="Incoming Requests" :icon="icons.inbox" style="margin-bottom:16px">
        <!-- Filter tabs -->
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

      <!-- Directives / Rules -->
      <UiCard title="Directive Rules" :icon="icons.rules" style="margin-bottom:16px">
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">
          Per-contact rules that control how incoming requests are handled.
        </div>

        <!-- Existing directives -->
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

        <!-- Editor -->
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
import type { ContactRequest, Directive, DirectiveActionType, DirectivePolicy, WhitelistContact } from '~/types/aria'

const { api } = useApi()

const loaded = ref(false)
const error = ref('')
const requests = ref<ContactRequest[]>([])
const directives = ref<Directive[]>([])
const contacts = ref<WhitelistContact[]>([])
const activeFilter = ref<'all' | 'pending' | 'auto_executed' | 'approved' | 'rejected'>('all')
const actingId = ref('')

// Directive editor state
const showEditor = ref(false)
const editingDirective = ref<Directive | undefined>(undefined)
const directiveSaving = ref(false)

const icons = {
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>',
  rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  contacts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
}

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

function directiveCountForContact(jid: string): number {
  return directives.value.filter(d => d.contactJid === jid).length
}

function editDirective(dir: Directive) {
  editingDirective.value = dir
  showEditor.value = true
}

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

async function loadRequests() {
  try {
    requests.value = await api<ContactRequest[]>('/api/contact-requests')
  } catch {}
}

async function loadDirectives() {
  try {
    directives.value = await api<Directive[]>('/api/directives')
  } catch {}
}

async function load() {
  try {
    const [reqs, dirs, cts] = await Promise.all([
      api<ContactRequest[]>('/api/contact-requests'),
      api<Directive[]>('/api/directives'),
      api<WhitelistContact[]>('/api/whitelist'),
    ])
    requests.value = reqs
    directives.value = dirs
    contacts.value = cts
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
.dir-item-contact {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
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
.dir-item-note {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
  line-height: 1.4;
}
.dir-item-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
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
.ct-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.ct-jid {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-muted);
}
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

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .rq-filters { gap: 4px; }
  .ct-row { flex-wrap: wrap; }
}
</style>
