<template>
  <div class="section">
    <LayoutSectionHeader>Integrations</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="dashboard">
      <IntegrationsWhatsAppCard
        :whatsapp="dashboard.whatsapp || { connected: false, contactCount: 0 }"
        @sync-contacts="syncContacts"
        @show-qr="showQr = true"
      />

      <IntegrationsGmailCard
        :gmail="dashboard.gmail || { total: 0, authenticated: 0 }"
        :accounts="dashboard.gmailAccounts || []"
      />

      <IntegrationsSSHCard
        :ssh="dashboard.ssh || { keyGenerated: false, publicKey: '', targets: [] }"
        :testing="sshTesting"
        @test="sshTest"
        @add="sshAdd"
        @remove="sshRemove"
      />

      <IntegrationsScheduledCard :messages="scheduled" />
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>

    <!-- QR Modal -->
    <div v-if="showQr" class="qr-overlay" @click="showQr = false">
      <div class="qr-box" @click.stop>
        <h2>Mobile Access</h2>
        <img :src="qrUrl" alt="QR Code">
        <p>{{ origin }}</p>
        <button class="close-btn" @click="showQr = false">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DashboardData, ScheduledMessage } from '~/types/aria'

const { api } = useApi()

const dashboard = ref<DashboardData | null>(null)
const scheduled = ref<ScheduledMessage[]>([])
const error = ref('')
const showQr = ref(false)
const sshTesting = ref('')

const origin = ref('')
onMounted(() => {
  origin.value = window.location.origin
})

const qrUrl = computed(() => {
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=ff4d2a&bgcolor=0c0c18&data=${encodeURIComponent(origin.value)}`
})

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
