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
      <button class="btn" @click="emit('syncContacts')">Sync Contacts</button>
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
      <div v-for="c in whitelist" :key="c.jid" class="wl-item-wrap">
        <div class="wl-item">
          <div>
            <span class="wl-name">{{ c.name }}</span>
            <span class="wl-jid">{{ c.jid }}</span>
            <span class="perm-badge" :class="c.permissions?.acceptCommands ? 'badge-active' : 'badge-observe'">
              {{ c.permissions?.acceptCommands ? 'commands enabled' : 'observe only' }}
            </span>
          </div>
          <div class="wl-actions">
            <button class="wl-rm" @click="togglePermEditor(c.jid)">
              {{ expandedJid === c.jid ? 'Close' : 'Permissions' }}
            </button>
            <button class="wl-rm" @click="removeContact(c.jid)">Remove</button>
          </div>
        </div>

        <!-- Permissions Editor -->
        <div v-if="expandedJid === c.jid" class="perm-editor">
          <div class="perm-toggle-row">
            <span class="perm-label">Accept Commands</span>
            <button
              class="perm-toggle-btn"
              :class="{ active: editPerms[c.jid]?.acceptCommands }"
              @click="toggleAcceptCommands(c.jid)"
            >
              {{ editPerms[c.jid]?.acceptCommands ? 'ON' : 'OFF' }}
            </button>
          </div>

          <template v-if="editPerms[c.jid]?.acceptCommands">
            <div class="perm-section-label">Category Permissions</div>
            <div class="perm-grid">
              <button
                v-for="cat in categories"
                :key="cat"
                class="perm-cat-btn"
                :class="getCatMode(c.jid, cat)"
                @click="cycleCatMode(c.jid, cat)"
              >
                <span class="perm-cat-name">{{ cat.replace('_', ' ') }}</span>
                <span class="perm-cat-mode">{{ getCatModeLabel(c.jid, cat) }}</span>
              </button>
            </div>

            <div class="perm-toggle-row">
              <span class="perm-label">Default Mode</span>
              <div class="perm-mode-toggle">
                <button
                  class="perm-mode-btn"
                  :class="{ selected: editPerms[c.jid]?.defaultMode === 'confirm' }"
                  @click="setDefaultMode(c.jid, 'confirm')"
                >confirm</button>
                <button
                  class="perm-mode-btn"
                  :class="{ selected: editPerms[c.jid]?.defaultMode === 'ignore' }"
                  @click="setDefaultMode(c.jid, 'ignore')"
                >ignore</button>
              </div>
            </div>
          </template>

          <div class="perm-save-row">
            <button class="btn primary" @click="savePermissions(c.jid)" :disabled="savingJid === c.jid">
              {{ savingJid === c.jid ? 'Saving...' : 'Save' }}
            </button>
            <button
              v-if="editPerms[c.jid]?.acceptCommands"
              class="btn danger"
              @click="disablePermissions(c.jid)"
            >Disable Commands</button>
          </div>
        </div>
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
    <p v-if="errorMsg" class="wa-error">{{ errorMsg }}</p>
  </div>
</template>

<script setup lang="ts">
import type { WhitelistContact, ContactPermissions } from '~/types/aria'

const categories = ['event', 'invitation', 'logistics', 'request', 'deadline', 'action_item'] as const

const props = defineProps<{
  whatsapp: { connected: boolean; contactCount: number }
}>()

const emit = defineEmits<{
  syncContacts: []
  reload: []
  error: [msg: string]
}>()

const { api } = useApi()
const qrData = ref<string | null>(null)
const qrLoading = ref(false)
const whitelist = ref<WhitelistContact[]>([])
const newJid = ref('')
const newName = ref('')
const expandedJid = ref<string | null>(null)
const editPerms = ref<Record<string, ContactPermissions>>({})
const savingJid = ref<string | null>(null)
const errorMsg = ref('')

const qrImageUrl = computed(() => {
  if (!qrData.value) return ''
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=25D366&bgcolor=0c0c18&data=${encodeURIComponent(qrData.value)}`
})

function defaultPermissions(): ContactPermissions {
  return {
    acceptCommands: true,
    autoActions: ['event', 'logistics'],
    confirmActions: ['request', 'deadline', 'action_item'],
    defaultMode: 'confirm',
  }
}

function togglePermEditor(jid: string) {
  if (expandedJid.value === jid) {
    expandedJid.value = null
    return
  }
  expandedJid.value = jid
  const contact = whitelist.value.find(c => c.jid === jid)
  if (contact?.permissions) {
    editPerms.value[jid] = { ...contact.permissions, autoActions: [...contact.permissions.autoActions], confirmActions: [...contact.permissions.confirmActions] }
  } else {
    editPerms.value[jid] = { acceptCommands: false, autoActions: [], confirmActions: [], defaultMode: 'confirm' }
  }
}

function toggleAcceptCommands(jid: string) {
  const p = editPerms.value[jid]
  if (!p) return
  if (!p.acceptCommands) {
    const defaults = defaultPermissions()
    p.acceptCommands = true
    p.autoActions = defaults.autoActions
    p.confirmActions = defaults.confirmActions
    p.defaultMode = defaults.defaultMode
  } else {
    p.acceptCommands = false
    p.autoActions = []
    p.confirmActions = []
  }
}

function getCatMode(jid: string, cat: string): string {
  const p = editPerms.value[jid]
  if (!p) return 'mode-default'
  if (p.autoActions.includes(cat)) return 'mode-auto'
  if (p.confirmActions.includes(cat)) return 'mode-confirm'
  return 'mode-default'
}

function getCatModeLabel(jid: string, cat: string): string {
  const p = editPerms.value[jid]
  if (!p) return 'default'
  if (p.autoActions.includes(cat)) return 'auto'
  if (p.confirmActions.includes(cat)) return 'confirm'
  return 'default'
}

function cycleCatMode(jid: string, cat: string) {
  const p = editPerms.value[jid]
  if (!p) return
  const inAuto = p.autoActions.includes(cat)
  const inConfirm = p.confirmActions.includes(cat)
  // Cycle: auto -> confirm -> default -> auto
  if (inAuto) {
    p.autoActions = p.autoActions.filter(a => a !== cat)
    p.confirmActions = [...p.confirmActions, cat]
  } else if (inConfirm) {
    p.confirmActions = p.confirmActions.filter(a => a !== cat)
  } else {
    p.autoActions = [...p.autoActions, cat]
  }
}

function setDefaultMode(jid: string, mode: 'confirm' | 'ignore') {
  const p = editPerms.value[jid]
  if (p) p.defaultMode = mode
}

async function savePermissions(jid: string) {
  const p = editPerms.value[jid]
  if (!p) return
  savingJid.value = jid
  try {
    await api('/api/whitelist/permissions', { method: 'PUT', body: { jid, permissions: p } })
    await loadWhitelist()
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Failed to save permissions')
  } finally {
    savingJid.value = null
  }
}

async function disablePermissions(jid: string) {
  savingJid.value = jid
  try {
    await api('/api/whitelist/permissions', { method: 'PUT', body: { jid, permissions: null } })
    editPerms.value[jid] = { acceptCommands: false, autoActions: [], confirmActions: [], defaultMode: 'confirm' }
    await loadWhitelist()
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Failed to disable permissions')
  } finally {
    savingJid.value = null
  }
}

async function fetchQr() {
  qrLoading.value = true
  try {
    const res = await api<{ qr: string | null }>('/api/whatsapp/qr')
    qrData.value = res.qr
  } catch (e) {
    qrData.value = null
    errorMsg.value = e instanceof Error ? e.message : 'Failed to load QR code'
  } finally {
    qrLoading.value = false
  }
}

async function loadWhitelist() {
  try {
    whitelist.value = await api<WhitelistContact[]>('/api/whitelist')
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Failed to load whitelist')
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
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Failed to add contact'
  }
}

async function removeContact(jid: string) {
  if (!confirm(`Remove contact "${jid}" from the whitelist?`)) return
  try {
    await api('/api/whitelist', { method: 'DELETE', body: { jid } })
    if (expandedJid.value === jid) expandedJid.value = null
    await loadWhitelist()
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Failed to remove contact')
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null

watch(() => props.whatsapp.connected, (connected) => {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
  if (!connected) {
    fetchQr()
    refreshInterval = setInterval(fetchQr, 15000)
  } else {
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

/* ── Whitelist item wrapper ── */
.wl-item-wrap {
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.wl-item-wrap:last-child { border-bottom: none; }

.wl-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

/* ── Permission badge ── */
.perm-badge {
  display: inline-block;
  font-size: 10px;
  font-family: var(--mono);
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 8px;
  vertical-align: middle;
}
.badge-observe {
  color: var(--text-muted);
  background: rgba(80,80,110,0.2);
  border: 1px solid var(--border);
}
.badge-active {
  color: var(--green);
  background: rgba(34,197,94,0.1);
  border: 1px solid rgba(34,197,94,0.25);
}

/* ── Permissions editor ── */
.perm-editor {
  padding: 12px 0;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
.perm-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}
.perm-label {
  font-size: 13px;
  color: var(--text-dim);
  font-family: var(--mono);
}
.perm-toggle-btn {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-muted);
  padding: 4px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  transition: all .15s;
}
.perm-toggle-btn.active {
  border-color: var(--green);
  color: var(--green);
  background: rgba(34,197,94,0.08);
}

.perm-section-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-family: var(--mono);
  margin: 10px 0 6px;
}

.perm-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}
.perm-cat-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  transition: all .15s;
}
.perm-cat-btn:hover { border-color: var(--border-glow); }
.perm-cat-name {
  font-size: 11px;
  color: var(--text);
  font-family: var(--mono);
  text-transform: capitalize;
}
.perm-cat-mode {
  font-size: 10px;
  font-family: var(--mono);
}

/* Category mode colors */
.perm-cat-btn.mode-auto {
  border-color: rgba(34,197,94,0.4);
  background: rgba(34,197,94,0.06);
}
.perm-cat-btn.mode-auto .perm-cat-mode { color: var(--green); }
.perm-cat-btn.mode-confirm {
  border-color: rgba(234,179,8,0.4);
  background: rgba(234,179,8,0.06);
}
.perm-cat-btn.mode-confirm .perm-cat-mode { color: var(--yellow); }
.perm-cat-btn.mode-default .perm-cat-mode { color: var(--text-muted); }

/* ── Default mode toggle ── */
.perm-mode-toggle {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.perm-mode-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 4px 12px;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  transition: all .15s;
}
.perm-mode-btn.selected {
  background: var(--bg-elevated);
  color: var(--text);
}

/* ── Save row ── */
.perm-save-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.wa-error { color: var(--red); font-size: 12px; margin-top: 8px; }

@media (max-width: 600px) {
  .perm-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
