<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" style="width:20px;height:20px"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <h3>SSH</h3>
      <span class="intg-status" :class="ssh.keyGenerated ? 'online' : 'err'">
        {{ ssh.keyGenerated ? 'Key Ready' : 'No Key' }}
      </span>
    </div>

    <!-- Public Key -->
    <div v-if="ssh.publicKey" class="ssh-pubkey-section">
      <label class="ssh-label">Public Key</label>
      <div class="ssh-pubkey-box">
        <code class="ssh-pubkey">{{ ssh.publicKey }}</code>
        <button class="btn ssh-copy-btn" @click="copyKey">{{ copied ? 'Copied!' : 'Copy' }}</button>
      </div>
    </div>
    <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
      No SSH key generated yet
    </div>

    <!-- Target List -->
    <div v-if="ssh.targets.length" class="ssh-targets">
      <label class="ssh-label">Targets</label>
      <div v-for="t in ssh.targets" :key="t.id" class="ssh-target-row">
        <UiStatusDot :status="targetStatus(t)" />
        <span class="ssh-target-label">{{ t.label }}</span>
        <span class="ssh-target-host">{{ t.user }}@{{ t.host }}:{{ t.port }}</span>
        <button class="btn ssh-action-btn" :disabled="testing === t.id" @click="$emit('test', t.id)">
          {{ testing === t.id ? 'Testing...' : 'Test' }}
        </button>
        <button class="btn ssh-action-btn ssh-remove-btn" @click="$emit('remove', t.id)">Remove</button>
      </div>
    </div>

    <!-- Add Target Form -->
    <div class="ssh-add-form">
      <label class="ssh-label">Add Target</label>
      <div class="ssh-form-row">
        <input v-model="form.label" placeholder="Label" class="ssh-input" />
        <input v-model="form.host" placeholder="Host" class="ssh-input" />
        <input v-model="form.user" placeholder="User" class="ssh-input ssh-input-sm" />
        <input v-model.number="form.port" type="number" placeholder="22" class="ssh-input ssh-input-xs" />
        <button class="btn" :disabled="!canAdd" @click="submitAdd">Add</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SSHStatus } from '~/types/aria'

const props = defineProps<{
  ssh: SSHStatus
  testing?: string
}>()

const emit = defineEmits<{
  test: [id: string]
  remove: [id: string]
  add: [data: { label: string; host: string; user: string; port: number }]
}>()

const copied = ref(false)
const form = reactive({ label: '', host: '', user: 'root', port: 22 })

const canAdd = computed(() => form.label.trim() && form.host.trim() && form.user.trim())

function targetStatus(t: { lastTestedAt?: number; lastTestOk?: boolean }): 'ok' | 'warn' | 'err' {
  if (t.lastTestedAt == null) return 'warn'
  return t.lastTestOk ? 'ok' : 'err'
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(props.ssh.publicKey)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch { /* clipboard not available */ }
}

function submitAdd() {
  if (!canAdd.value) return
  emit('add', { label: form.label.trim(), host: form.host.trim(), user: form.user.trim(), port: form.port || 22 })
  form.label = ''
  form.host = ''
  form.user = 'root'
  form.port = 22
}
</script>

<style scoped>
.ssh-pubkey-section { margin: 8px 0; }
.ssh-label { display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.ssh-pubkey-box { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; padding: 8px; }
.ssh-pubkey { flex: 1; font-size: 11px; color: var(--text); word-break: break-all; line-height: 1.4; overflow: hidden; max-height: 3.6em; }
.ssh-copy-btn { flex-shrink: 0; padding: 4px 10px; font-size: 11px; }
.ssh-targets { margin: 12px 0 8px; }
.ssh-target-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
.ssh-target-label { font-size: 13px; color: var(--text); }
.ssh-target-host { font-family: var(--mono); font-size: 11px; color: var(--text-muted); margin-left: auto; }
.ssh-action-btn { padding: 3px 8px; font-size: 11px; }
.ssh-remove-btn { color: var(--red); }
.ssh-add-form { margin-top: 12px; }
.ssh-form-row { display: flex; gap: 6px; flex-wrap: wrap; }
.ssh-input { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 6px 8px; font-size: 12px; color: var(--text); flex: 1; min-width: 80px; }
.ssh-input-sm { max-width: 80px; flex: 0 0 80px; }
.ssh-input-xs { max-width: 60px; flex: 0 0 60px; }
.ssh-input::placeholder { color: var(--text-ghost); }
</style>
