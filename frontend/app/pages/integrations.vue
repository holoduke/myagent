<template>
  <div class="section">
    <LayoutSectionHeader>Integrations</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="dashboard">
      <!-- Tile Grid -->
      <div class="intg-tiles">
        <!-- WhatsApp -->
        <div class="intg-tile" @click="activeModal = 'whatsapp'">
          <div class="intg-tile-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
          </div>
          <div class="intg-tile-name">WhatsApp</div>
          <div class="intg-tile-row">
            <span class="intg-status" :class="waData.connected ? 'online' : 'offline'">
              {{ waData.connected ? 'Connected' : 'Disconnected' }}
            </span>
            <span class="intg-tile-stat">{{ waData.contactCount }} contacts</span>
          </div>
        </div>

        <!-- Gmail -->
        <div class="intg-tile" @click="activeModal = 'gmail'">
          <div class="intg-tile-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#EA4335" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          </div>
          <div class="intg-tile-name">Gmail</div>
          <div class="intg-tile-row">
            <span class="intg-status" :class="gmailData.authenticated > 0 ? 'online' : 'pending'">
              {{ gmailData.authenticated }}/{{ gmailData.total }} Active
            </span>
            <span class="intg-tile-stat">{{ gmailData.total }} accounts</span>
          </div>
        </div>

        <!-- SSH -->
        <div class="intg-tile" @click="activeModal = 'ssh'">
          <div class="intg-tile-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="intg-tile-name">SSH</div>
          <div class="intg-tile-row">
            <span class="intg-status" :class="sshData.keyGenerated ? 'online' : 'err'">
              {{ sshData.keyGenerated ? 'Key Ready' : 'No Key' }}
            </span>
            <span class="intg-tile-stat">{{ sshData.targets.length }} targets</span>
          </div>
        </div>

        <!-- Scheduled -->
        <div class="intg-tile" @click="activeModal = 'scheduled'">
          <div class="intg-tile-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div class="intg-tile-name">Scheduled</div>
          <div class="intg-tile-row">
            <span class="intg-status" :class="scheduled.length ? 'pending' : 'online'">
              {{ scheduled.length }} pending
            </span>
            <span class="intg-tile-stat">messages</span>
          </div>
        </div>
      </div>

      <!-- WhatsApp Modal -->
      <UiModal :open="activeModal === 'whatsapp'" title="WhatsApp" @close="activeModal = null">
        <IntegrationsWhatsAppCard
          :whatsapp="waData"
          @sync-contacts="syncContacts"
        />
      </UiModal>

      <!-- Gmail Modal -->
      <UiModal :open="activeModal === 'gmail'" title="Gmail" @close="activeModal = null">
        <IntegrationsGmailCard
          :gmail="gmailData"
          :accounts="dashboard.gmailAccounts || []"
          @reload="load"
        />
      </UiModal>

      <!-- SSH Modal -->
      <UiModal :open="activeModal === 'ssh'" title="SSH" max-width="640px" @close="activeModal = null">
        <IntegrationsSSHCard
          :ssh="sshData"
          :testing="sshTesting"
          @test="sshTest"
          @add="sshAdd"
          @remove="sshRemove"
        />
      </UiModal>

      <!-- Scheduled Modal -->
      <UiModal :open="activeModal === 'scheduled'" title="Scheduled Messages" @close="activeModal = null">
        <IntegrationsScheduledCard :messages="scheduled" />
      </UiModal>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { DashboardData, ScheduledMessage, SSHStatus } from '~/types/aria'

const { api } = useApi()

const dashboard = ref<DashboardData | null>(null)
const scheduled = ref<ScheduledMessage[]>([])
const error = ref('')
const activeModal = ref<string | null>(null)
const sshTesting = ref('')

const waData = computed(() => dashboard.value?.whatsapp || { connected: false, contactCount: 0 })
const gmailData = computed(() => dashboard.value?.gmail || { total: 0, authenticated: 0 })
const sshData = computed<SSHStatus>(() => dashboard.value?.ssh || { keyGenerated: false, publicKey: '', targets: [] })

async function load() {
  try {
    const [dash, sched] = await Promise.all([
      api<DashboardData>('/api/dashboard'),
      api<ScheduledMessage[]>('/api/scheduled'),
    ])
    dashboard.value = dash
    scheduled.value = sched
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

async function syncContacts() {
  try {
    await api<{ success: boolean }>('/api/sync-contacts', { method: 'POST' })
    await load()
  } catch {
    // Silent
  }
}

async function sshTest(id: string) {
  sshTesting.value = id
  try {
    await api<{ success: boolean; error?: string }>('/api/ssh/test', { method: 'POST', body: { id } })
    await load()
  } catch {
    // Silent
  } finally {
    sshTesting.value = ''
  }
}

async function sshAdd(data: { label: string; host: string; user: string; port: number }) {
  try {
    await api<{ success: boolean }>('/api/ssh/targets', { method: 'POST', body: data })
    await load()
  } catch {
    // Silent
  }
}

async function sshRemove(id: string) {
  try {
    await api<{ success: boolean }>('/api/ssh/targets', { method: 'DELETE', body: { id } })
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
