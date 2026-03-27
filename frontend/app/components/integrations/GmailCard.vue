<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#EA4335" stroke-width="2" style="width:20px;height:20px"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      <h3>Gmail</h3>
      <span class="intg-status" :class="gmail.authenticated > 0 ? 'online' : 'pending'">
        {{ gmail.authenticated }}/{{ gmail.total }} Active
      </span>
    </div>

    <!-- Account list -->
    <template v-if="accounts.length">
      <div v-for="acc in accounts" :key="acc.id" class="gmail-account">
        <UiStatusDot :status="acc.authenticated ? 'ok' : 'warn'" />
        <span class="gmail-email">{{ acc.email }}</span>
        <a v-if="!acc.authenticated" :href="`/gmail/auth/${acc.id}`" class="btn" style="margin-left:auto;padding:4px 10px;font-size:11px">Authorize</a>
        <span v-else class="gmail-poll">Last poll: {{ acc.lastPoll ? timeAgo(acc.lastPoll) : 'never' }}</span>
        <button class="btn danger" style="padding:4px 10px;font-size:11px;margin-left:8px" @click="remove(acc.id)">Remove</button>
      </div>
    </template>
    <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
      No Gmail accounts configured
    </div>

    <!-- Add account form -->
    <div class="gmail-add-section">
      <label class="intg-label">Add Account</label>
      <div class="gmail-form">
        <input v-model="form.email" placeholder="Email address" class="intg-input" />
        <input v-model="form.clientId" placeholder="OAuth Client ID" class="intg-input" />
        <input v-model="form.clientSecret" placeholder="Client Secret" type="password" class="intg-input" />
        <button class="btn" :disabled="!canAdd" @click="add">Add</button>
      </div>
      <p v-if="addError" class="gmail-error">{{ addError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { GmailAccount } from '~/types/aria'

const props = defineProps<{
  gmail: { total: number; authenticated: number }
  accounts: GmailAccount[]
}>()

const emit = defineEmits<{
  reload: []
  error: [msg: string]
}>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const form = reactive({ email: '', clientId: '', clientSecret: '' })
const addError = ref('')

const canAdd = computed(() => form.email.trim() && form.clientId.trim() && form.clientSecret.trim())

async function add() {
  if (!canAdd.value) return
  addError.value = ''
  try {
    const id = (form.email.split('@')[0] ?? form.email).replace(/[^a-z0-9]/gi, '-').toLowerCase()
    await api('/api/gmail/accounts', {
      method: 'POST',
      body: { id, email: form.email.trim(), clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim(), redirectUri: `${window.location.origin}/gmail/callback` },
    })
    form.email = ''
    form.clientId = ''
    form.clientSecret = ''
    emit('reload')
  } catch (e) {
    addError.value = e instanceof Error ? e.message : 'Failed to add account'
  }
}

async function remove(id: string) {
  try {
    await api('/api/gmail/accounts', { method: 'DELETE', body: { id } })
    emit('reload')
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Failed to remove account')
  }
}
</script>

<style scoped>
.gmail-account {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.gmail-email { font-size: 13px; color: var(--text); }
.gmail-poll { font-family: var(--mono); font-size: 10px; color: var(--text-muted); margin-left: auto; }
.gmail-add-section { margin-top: 14px; }
.gmail-form {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.gmail-error { color: var(--red); font-size: 12px; margin-top: 6px; }
</style>
