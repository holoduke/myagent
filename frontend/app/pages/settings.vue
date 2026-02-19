<template>
  <div class="section">
    <LayoutSectionHeader>Settings</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="loaded">
      <!-- Contact Whitelist -->
      <UiCard title="Contact Whitelist" :icon="icons.users" style="margin-bottom:16px">
        <template v-if="whitelist.length">
          <div v-for="c in whitelist" :key="c.jid" class="wl-item">
            <div>
              <span class="wl-name">{{ c.name }}</span>
              <span class="wl-jid">{{ c.jid }}</span>
            </div>
            <button class="wl-rm" @click="removeContact(c.jid)">Remove</button>
          </div>
        </template>
        <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
          No whitelisted contacts
        </div>
        <div class="wl-add-form">
          <input v-model="newJid" type="text" placeholder='JID (e.g. 123@s.whatsapp.net)'>
          <input v-model="newName" type="text" placeholder="Name">
          <button class="btn primary" @click="addContact">Add</button>
        </div>
      </UiCard>

      <!-- Self-Improvement -->
      <UiCard title="Self-Improvement" :icon="icons.edit" style="margin-bottom:16px">
        <UiKvRow label="Boot Counter" :value="si.bootCounter || 0" :value-class="(si.bootCounter || 0) > 1 ? 'warn' : ''" />
        <UiKvRow label="Last Good Commit" :value="si.lastGoodCommit ? si.lastGoodCommit.slice(0, 8) : 'none'" />

        <div v-if="si.pendingTask" class="si-task pending" style="margin-top:10px">
          <div class="si-label">Pending Task</div>
          <div class="si-val">{{ si.pendingTask.description }}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--mono)">
            Files: {{ (si.pendingTask.files || []).join(', ') }}
          </div>
        </div>

        <div v-if="si.lastResult" class="si-task" :class="si.lastResult.success ? 'success' : 'failed'" style="margin-top:10px">
          <div class="si-label">
            Last Result &mdash;
            <span :style="{ color: si.lastResult.success ? 'var(--green)' : 'var(--red)' }">
              {{ si.lastResult.success ? 'Success' : 'Failed' }}
            </span>
          </div>
          <div class="si-val">{{ si.lastResult.description }}</div>
          <a v-if="si.lastResult.prUrl" :href="si.lastResult.prUrl" target="_blank" style="color:var(--cyan);text-decoration:none;font-size:12px;font-family:var(--mono)">
            View PR
          </a>
          <div v-if="si.lastResult.completedAt" style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--mono)">
            {{ fmtDate(si.lastResult.completedAt) }}
          </div>
        </div>

        <div v-if="!si.pendingTask && !si.lastResult" style="color:var(--text-ghost);font-size:13px;padding:10px 0">
          No self-improvement activity yet
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
import type { WhitelistContact, DashboardData, SelfImprove } from '~/types/aria'

const { api } = useApi()
const { logout } = useAuth()
const { fmtDate } = useTimeAgo()

const whitelist = ref<WhitelistContact[]>([])
const si = ref<SelfImprove>({ pendingTask: null, lastResult: null, bootCounter: 0, lastGoodCommit: null })
const loaded = ref(false)
const error = ref('')
const newJid = ref('')
const newName = ref('')

const icons = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6m3-3h-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
}

async function load() {
  try {
    const [wl, dash] = await Promise.all([
      api<WhitelistContact[]>('/api/whitelist'),
      api<DashboardData>('/api/dashboard'),
    ])
    whitelist.value = wl
    si.value = dash.selfImprove || { pendingTask: null, lastResult: null, bootCounter: 0, lastGoodCommit: null }
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

async function addContact() {
  const jid = newJid.value.trim()
  const name = newName.value.trim()
  if (!jid || !name) return

  try {
    await api('/api/whitelist', { method: 'POST', body: { jid, name } })
    newJid.value = ''
    newName.value = ''
    await load()
  } catch {
    // Silent
  }
}

async function removeContact(jid: string) {
  try {
    await api('/api/whitelist', { method: 'DELETE', body: { jid } })
    await load()
  } catch {
    // Silent
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

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
}
</style>
