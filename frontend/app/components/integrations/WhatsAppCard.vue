<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2" style="width:20px;height:20px"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
      <h3>WhatsApp</h3>
      <span class="intg-status" :class="whatsapp.connected ? 'online' : 'offline'">
        {{ whatsapp.connected ? 'Connected' : 'Disconnected' }}
      </span>
    </div>
    <UiKvRow label="Contacts" :value="whatsapp.contactCount || 0" />
    <div class="btn-row">
      <button class="btn" @click="$emit('syncContacts')">Sync Contacts</button>
    </div>

    <!-- WhatsApp Pairing QR -->
    <div v-if="!whatsapp.connected" class="wa-qr-section">
      <label class="ssh-label">Pair Device</label>
      <div v-if="qrLoading" class="wa-qr-placeholder">
        <div class="spin" /> Loading QR...
      </div>
      <div v-else-if="qrData" class="wa-qr-display">
        <img :src="qrImageUrl" alt="WhatsApp QR" class="wa-qr-img" />
        <p class="wa-qr-hint">Scan with WhatsApp to connect</p>
      </div>
      <div v-else class="wa-qr-placeholder">
        <p>No QR available — waiting for generation</p>
        <button class="btn" @click="fetchQr">Retry</button>
      </div>
    </div>
    <div v-else class="wa-connected-note">
      <span class="status-dot ok" /> Already connected
    </div>

    <!-- Contact Whitelist -->
    <h4 class="wl-heading">Contact Whitelist</h4>
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
  </div>
</template>

<script setup lang="ts">
import type { WhitelistContact } from '~/types/aria'

const props = defineProps<{
  whatsapp: { connected: boolean; contactCount: number }
}>()

defineEmits(['syncContacts', 'reload'])

const { api } = useApi()
const qrData = ref<string | null>(null)
const qrLoading = ref(false)
const whitelist = ref<WhitelistContact[]>([])
const newJid = ref('')
const newName = ref('')

const qrImageUrl = computed(() => {
  if (!qrData.value) return ''
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=25D366&bgcolor=0c0c18&data=${encodeURIComponent(qrData.value)}`
})

async function fetchQr() {
  qrLoading.value = true
  try {
    const res = await api<{ qr: string | null }>('/api/whatsapp/qr')
    qrData.value = res.qr
  } catch {
    qrData.value = null
  } finally {
    qrLoading.value = false
  }
}

async function loadWhitelist() {
  try {
    whitelist.value = await api<WhitelistContact[]>('/api/whitelist')
  } catch {
    // Silent
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
    await loadWhitelist()
  } catch {
    // Silent
  }
}

async function removeContact(jid: string) {
  try {
    await api('/api/whitelist', { method: 'DELETE', body: { jid } })
    await loadWhitelist()
  } catch {
    // Silent
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null

watch(() => props.whatsapp.connected, (connected) => {
  if (!connected) {
    fetchQr()
    refreshInterval = setInterval(fetchQr, 15000)
  } else {
    if (refreshInterval) clearInterval(refreshInterval)
    qrData.value = null
  }
}, { immediate: true })

onMounted(loadWhitelist)

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})
</script>

<style scoped>
.wa-qr-section { margin-top: 14px; }
.wa-qr-placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-ghost);
  font-size: 13px;
  padding: 12px 0;
}
.wa-qr-display { text-align: center; padding: 12px 0; }
.wa-qr-img { border-radius: 10px; width: 180px; height: 180px; }
.wa-qr-hint { font-size: 12px; color: var(--text-muted); margin-top: 8px; }
.wa-connected-note {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--green);
  margin-top: 12px;
}
.wl-heading {
  margin: 16px 0 8px;
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-family: var(--mono);
}
</style>
