<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#06B6D4" stroke-width="2" style="width:20px;height:20px"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>
      <h3>Twilio Voice</h3>
      <span class="intg-status" :class="statusClass">{{ statusText }}</span>
    </div>

    <!-- Status display (when configured) -->
    <template v-if="twilio.configured">
      <UiKvRow label="Phone" :value="twilio.phoneNumber" />
      <UiKvRow label="Total Calls" :value="twilio.totalCalls" />
      <UiKvRow label="Active" :value="twilio.activeCalls" />
      <UiKvRow v-if="twilio.lastCallAt" label="Last Call" :value="timeAgo(twilio.lastCallAt)" />
      <UiKvRow v-if="twilio.config" label="Model" :value="twilio.config.model" />

      <!-- Make a call -->
      <div class="tw-section">
        <div class="tw-tabs">
          <button class="tw-tab" :class="{ active: callMode === 'simple' }" @click="callMode = 'simple'">Simple</button>
          <button class="tw-tab" :class="{ active: callMode === 'agent' }" @click="callMode = 'agent'">Agent</button>
        </div>

        <input v-model="callForm.to" placeholder="Phone number (+31...)" class="intg-input" />

        <template v-if="callMode === 'simple'">
          <textarea v-model="callForm.message" placeholder="Message to speak" class="intg-input tw-textarea" rows="3" />
        </template>

        <template v-else>
          <textarea v-model="callForm.systemPrompt" placeholder="System prompt (instructions for the AI)" class="intg-input tw-textarea" rows="3" />
          <input v-model="callForm.greeting" placeholder="Greeting (first thing said)" class="intg-input" />
          <div class="tw-model-row">
            <label class="intg-label">Model</label>
            <select v-model="callForm.model" class="intg-input tw-select">
              <option value="">Default</option>
              <option value="claude-haiku-4-5-20251001">Haiku 4.5 (fastest)</option>
              <option value="claude-sonnet-4-20250514">Sonnet 4 (balanced)</option>
              <option value="claude-opus-4-20250514">Opus 4</option>
              <option value="claude-opus-4-7">Opus 4.7</option>
              <option value="claude-fable-5">Fable 5 (latest)</option>
            </select>
          </div>
        </template>

        <button class="btn" :disabled="!canCall || calling" @click="makeCall">
          {{ calling ? 'Calling...' : 'Make Call' }}
        </button>
        <p v-if="callError" class="tw-error">{{ callError }}</p>
        <p v-if="callSuccess" class="tw-success">{{ callSuccess }}</p>
      </div>

      <!-- Recent calls -->
      <div v-if="twilio.recentCalls.length" class="tw-section">
        <label class="intg-label">Recent Calls</label>
        <div v-for="call in twilio.recentCalls" :key="call.callSid" class="tw-call">
          <div class="tw-call-row">
            <span class="tw-call-to">{{ call.to }}</span>
            <UiTypeBadge :label="call.mode" />
            <span class="tw-call-status" :class="call.status">{{ call.status }}</span>
          </div>
          <div class="tw-call-meta">
            {{ timeAgo(call.startedAt) }}
            <span v-if="call.duration"> &middot; {{ formatDuration(call.duration) }}</span>
            <span v-if="call.model"> &middot; {{ call.model.replace('claude-', '').split('-2')[0] }}</span>
          </div>
        </div>
      </div>

      <!-- Reconfigure -->
      <button class="btn" style="margin-top:12px;width:100%" @click="showConfig = !showConfig">
        {{ showConfig ? 'Hide Config' : 'Edit Config' }}
      </button>
    </template>

    <!-- Configuration form -->
    <div v-if="!twilio.configured || showConfig" class="tw-config">
      <label class="intg-label">Account SID</label>
      <input v-model="configForm.accountSid" placeholder="ACxxxxxxxxxxxxxxxx" class="intg-input" />

      <label class="intg-label">Auth Token</label>
      <input v-model="configForm.authToken" type="password" placeholder="Auth token" class="intg-input" />

      <label class="intg-label">Phone Number</label>
      <input v-model="configForm.phoneNumber" placeholder="+31612345678" class="intg-input" />

      <label class="intg-label">Webhook Base URL</label>
      <input v-model="configForm.webhookBaseUrl" placeholder="https://aria.example.com" class="intg-input" />

      <div class="tw-row">
        <div class="tw-col">
          <label class="intg-label">Voice</label>
          <select v-model="configForm.defaultVoice" class="intg-input tw-select">
            <option value="Polly.Lotte">Polly.Lotte (Dutch)</option>
            <option value="Polly.Ruben">Polly.Ruben (Dutch Male)</option>
            <option value="Polly.Joanna">Polly.Joanna (English)</option>
            <option value="Polly.Matthew">Polly.Matthew (English Male)</option>
            <option value="Google.nl-NL-Standard-A">Google Dutch A</option>
            <option value="Google.nl-NL-Standard-B">Google Dutch B</option>
          </select>
        </div>
        <div class="tw-col">
          <label class="intg-label">Language</label>
          <select v-model="configForm.defaultLanguage" class="intg-input tw-select">
            <option value="nl-NL">Dutch (nl-NL)</option>
            <option value="en-US">English (en-US)</option>
            <option value="en-GB">English UK (en-GB)</option>
            <option value="de-DE">German (de-DE)</option>
          </select>
        </div>
      </div>

      <div class="tw-row">
        <div class="tw-col">
          <label class="intg-label">Default Model</label>
          <select v-model="configForm.model" class="intg-input tw-select">
            <option value="claude-haiku-4-5-20251001">Haiku 4.5 (fastest)</option>
            <option value="claude-sonnet-4-20250514">Sonnet 4 (balanced)</option>
            <option value="claude-opus-4-20250514">Opus 4</option>
            <option value="claude-opus-4-7">Opus 4.7</option>
            <option value="claude-fable-5">Fable 5 (latest)</option>
          </select>
        </div>
        <div class="tw-col">
          <label class="intg-label">Max Duration (s)</label>
          <input v-model.number="configForm.maxCallDurationSec" type="number" class="intg-input" />
        </div>
      </div>

      <button class="btn" :disabled="!canSaveConfig || saving" style="width:100%;margin-top:8px" @click="saveConfig">
        {{ saving ? 'Saving...' : 'Save Configuration' }}
      </button>
      <p v-if="configError" class="tw-error">{{ configError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TwilioStatus } from '~/types/aria'

const props = defineProps<{
  twilio: TwilioStatus
}>()

const emit = defineEmits<{
  reload: []
  error: [msg: string]
}>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const showConfig = ref(false)
const callMode = ref<'simple' | 'agent'>('simple')
const calling = ref(false)
const callError = ref('')
const callSuccess = ref('')
const saving = ref(false)
const configError = ref('')

const configForm = reactive({
  accountSid: '',
  authToken: '',
  phoneNumber: '',
  webhookBaseUrl: '',
  defaultVoice: 'Polly.Lotte',
  defaultLanguage: 'nl-NL',
  maxCallDurationSec: 600,
  model: 'claude-opus-4-7',
})

const callForm = reactive({
  to: '',
  message: '',
  systemPrompt: '',
  greeting: '',
  model: '',
})

const statusClass = computed(() =>
  props.twilio.configured ? (props.twilio.activeCalls > 0 ? 'pending' : 'online') : 'offline'
)

const statusText = computed(() =>
  props.twilio.configured ? (props.twilio.activeCalls > 0 ? `${props.twilio.activeCalls} active` : 'Ready') : 'Not configured'
)

const canSaveConfig = computed(() =>
  configForm.accountSid.trim() && configForm.authToken.trim() && configForm.phoneNumber.trim() && configForm.webhookBaseUrl.trim()
)

const canCall = computed(() => {
  if (!callForm.to.trim()) return false
  if (callMode.value === 'simple' && !callForm.message.trim()) return false
  return true
})

// Load existing config when configured
onMounted(() => {
  if (props.twilio.config) {
    configForm.accountSid = props.twilio.config.accountSid || ''
    configForm.phoneNumber = props.twilio.config.phoneNumber || ''
    configForm.webhookBaseUrl = props.twilio.config.webhookBaseUrl || ''
    configForm.defaultVoice = props.twilio.config.defaultVoice || 'Polly.Lotte'
    configForm.defaultLanguage = props.twilio.config.defaultLanguage || 'nl-NL'
    configForm.maxCallDurationSec = props.twilio.config.maxCallDurationSec || 600
    configForm.model = props.twilio.config.model || 'claude-opus-4-7'
    // Don't populate authToken — it's sensitive
  }
})

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

async function saveConfig() {
  saving.value = true
  configError.value = ''
  try {
    await api('/api/twilio/config', {
      method: 'PUT',
      body: { ...configForm },
    })
    showConfig.value = false
    emit('reload')
  } catch (e) {
    configError.value = e instanceof Error ? e.message : 'Failed to save'
  } finally {
    saving.value = false
  }
}

async function makeCall() {
  calling.value = true
  callError.value = ''
  callSuccess.value = ''
  try {
    const body: Record<string, string> = { to: callForm.to.trim(), mode: callMode.value }
    if (callMode.value === 'simple') {
      body.message = callForm.message.trim()
    } else {
      if (callForm.systemPrompt.trim()) body.systemPrompt = callForm.systemPrompt.trim()
      if (callForm.greeting.trim()) body.greeting = callForm.greeting.trim()
      if (callForm.model) body.model = callForm.model
    }
    await api('/api/twilio/call', { method: 'POST', body })
    callSuccess.value = `Call initiated to ${callForm.to}`
    setTimeout(() => emit('reload'), 3000)
  } catch (e) {
    callError.value = e instanceof Error ? e.message : 'Failed to initiate call'
  } finally {
    calling.value = false
  }
}
</script>

<style scoped>
.tw-section {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tw-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.tw-tab {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
  border-radius: 6px;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  transition: all .2s;
}
.tw-tab.active {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(6,182,212,0.08);
}
.tw-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: var(--mono);
  font-size: 12px;
}
.tw-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tw-model-row .intg-label {
  margin: 0;
  white-space: nowrap;
  font-size: 11px;
}
.tw-select {
  appearance: auto;
  cursor: pointer;
}
.tw-error { color: var(--red); font-size: 12px; margin-top: 4px; }
.tw-success { color: var(--green, #22c55e); font-size: 12px; margin-top: 4px; }
.tw-call {
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.tw-call-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tw-call-to { font-size: 13px; color: var(--text); font-family: var(--mono); }
.tw-call-status {
  font-size: 10px;
  font-family: var(--mono);
  text-transform: uppercase;
  margin-left: auto;
}
.tw-call-status.completed { color: var(--green, #22c55e); }
.tw-call-status.failed, .tw-call-status.busy, .tw-call-status.no-answer { color: var(--red); }
.tw-call-status.initiated, .tw-call-status.ringing, .tw-call-status.in-progress { color: var(--amber, #f59e0b); }
.tw-call-meta {
  font-size: 11px;
  color: var(--text-ghost);
  margin-top: 2px;
}
.tw-config {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tw-row {
  display: flex;
  gap: 8px;
}
.tw-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
</style>
