<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#03A9F4" stroke-width="2" style="width:20px;height:20px"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <h3>Home Assistant</h3>
      <span class="intg-status" :class="statusClass">{{ statusText }}</span>
    </div>

    <UiKvRow label="Mode" :value="modeLabel" />
    <UiKvRow label="Events today" :value="ha.eventsToday ?? 0" />
    <UiKvRow label="Last event" :value="ha.lastEventAt ? timeAgo(ha.lastEventAt) : 'never'" />
    <UiKvRow label="Pending digest" :value="`${ha.pendingDigest ?? 0} events`" />
    <UiKvRow label="Queued commands" :value="ha.queuedCommands ?? 0" />
    <UiKvRow v-if="ha.connected" label="Direct URL" :value="ha.url" />

    <!-- Webhook credentials for the house -->
    <div class="ha-section">
      <div class="ha-section-title">Inbound webhook (house → ARIA)</div>
      <p class="ha-hint">Home Assistant posts events here with the <code>X-ARIA-Token</code> header. See <code>docs/homeassistant/</code> for the package and automations.</p>
      <div class="ha-secret">
        <code class="ha-code">{{ ha.webhookUrl }}</code>
        <button class="btn sm" @click="copy(ha.webhookUrl || '')">Copy</button>
      </div>
      <div class="ha-secret">
        <code class="ha-code">{{ showToken ? ha.webhookToken : '••••••••••••••••' }}</code>
        <button class="btn sm ghost" @click="showToken = !showToken">{{ showToken ? 'Hide' : 'Show' }}</button>
        <button class="btn sm" @click="copy(ha.webhookToken || '')">Copy</button>
        <button class="btn sm danger" :disabled="busy" @click="regenerateToken">Regenerate</button>
      </div>
    </div>

    <!-- Weather reflex -->
    <div class="ha-section">
      <div class="ha-section-title">Reflex: weather briefing on button press</div>
      <div class="ha-grid">
        <label class="intg-label">Enabled
          <input v-model="reflex.enabled" type="checkbox" />
        </label>
        <label class="intg-label">Button device
          <input v-model="reflex.device" class="intg-input" placeholder="Ikea switch 3 silver" />
        </label>
        <label class="intg-label">Actions (comma separated)
          <input v-model="actionsText" class="intg-input" placeholder="on, off, arrow_left_click" />
        </label>
        <label class="intg-label">Speaker (media_player)
          <input v-model="reflex.mediaPlayer" class="intg-input" placeholder="media_player.wiim_amp_ultra_3d72" />
        </label>
        <label class="intg-label">TTS engine
          <input v-model="reflex.ttsEngine" class="intg-input" placeholder="google_translate, cloud or tts.xxx" />
        </label>
        <label class="intg-label">Language
          <input v-model="reflex.language" class="intg-input intg-input-sm" placeholder="nl" />
        </label>
        <label class="intg-label">Tomorrow from (hour)
          <input v-model.number="reflex.eveningHour" type="number" min="0" max="23" class="intg-input intg-input-sm" />
        </label>
        <label class="intg-label">Weather entity
          <input v-model="reflex.weatherEntity" class="intg-input" placeholder="weather.buienradar" />
        </label>
        <label class="intg-label">Also push TTS from server
          <input v-model="reflex.pushTts" type="checkbox" />
        </label>
      </div>
      <div class="btn-row">
        <button class="btn primary" :disabled="busy" @click="saveReflex">Save reflex</button>
        <button class="btn" :disabled="busy" @click="testReflex(false)">Preview briefing</button>
        <button class="btn" :disabled="busy" @click="testReflex(true)">Speak on speaker</button>
      </div>
      <p v-if="preview" class="ha-preview">“{{ preview }}”</p>
    </div>

    <!-- Outbound connection -->
    <div class="ha-section">
      <div class="ha-section-title">Outbound (ARIA → house)</div>
      <p class="ha-hint">Optional. With a reachable URL ARIA calls services directly; otherwise commands are queued and the house pulls them.</p>
      <div class="ha-grid">
        <label class="intg-label">Mode
          <select v-model="conn.mode" class="intg-input">
            <option value="webhook">Webhook only (house pulls commands)</option>
            <option value="direct_api">Direct URL</option>
            <option value="cloud">Nabu Casa cloud URL</option>
          </select>
        </label>
        <label v-if="conn.mode !== 'webhook'" class="intg-label">URL
          <input v-model="conn.url" class="intg-input" placeholder="https://home.example.com:8123" />
        </label>
        <label v-if="conn.mode !== 'webhook'" class="intg-label">Long-lived token
          <input v-model="conn.token" type="password" class="intg-input" placeholder="leave blank to keep current" />
        </label>
      </div>
      <div class="btn-row">
        <button class="btn primary" :disabled="busy" @click="saveConnection">Save connection</button>
        <button v-if="conn.mode !== 'webhook'" class="btn" :disabled="busy || !conn.url || !conn.token" @click="testConnection">Test</button>
      </div>
    </div>

    <!-- Recent events -->
    <div class="ha-section">
      <div class="ha-section-title">Recent events</div>
      <p v-if="!ha.recentEvents?.length" class="ha-hint">No events received yet. Press the button or check the Home Assistant automation trace.</p>
      <ul v-else class="ha-events">
        <li v-for="e in ha.recentEvents" :key="e.id">
          <span class="ha-time">{{ timeAgo(e.receivedAt) }}</span>
          <span class="ha-desc">{{ describe(e) }}</span>
          <span v-if="e.handledBy" class="ha-handled" :title="e.handledSummary">→ {{ e.handledBy }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { HomeAssistantStatus, HAEventRecord, HAWeatherReflexConfig } from '~/types/aria'

const props = defineProps<{ ha: HomeAssistantStatus }>()
const emit = defineEmits<{ reload: []; error: [msg: string]; info: [msg: string] }>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const busy = ref(false)
const showToken = ref(false)
const preview = ref('')

const DEFAULT_REFLEX: HAWeatherReflexConfig = {
  enabled: true, device: 'Ikea switch 3 silver', actions: ['on', 'off', 'arrow_left_click', 'arrow_right_click'],
  mediaPlayer: 'media_player.wiim_amp_ultra_3d72', ttsEngine: 'google_translate', language: 'nl',
  eveningHour: 14, weatherEntity: 'weather.buienradar', pushTts: false,
}

const reflex = reactive<HAWeatherReflexConfig>({ ...DEFAULT_REFLEX })
const actionsText = ref(DEFAULT_REFLEX.actions.join(', '))
const conn = reactive({ mode: 'webhook' as 'webhook' | 'direct_api' | 'cloud', url: '', token: '' })

watch(() => props.ha.config, (cfg) => {
  if (!cfg) return
  Object.assign(reflex, cfg.reflexes?.weatherBriefing ?? DEFAULT_REFLEX)
  actionsText.value = reflex.actions.join(', ')
  conn.mode = cfg.mode
  conn.url = cfg.mode === 'cloud' ? (cfg.cloud?.url ?? '') : (cfg.direct_api?.url ?? '')
  conn.token = ''
}, { immediate: true })

const modeLabel = computed(() => ({ webhook: 'Webhook (house pulls commands)', direct_api: 'Direct URL', cloud: 'Nabu Casa' }[props.ha.mode ?? 'webhook']))
const statusClass = computed(() => (props.ha.connected || props.ha.receiving) ? 'online' : props.ha.enabled ? 'pending' : 'offline')
const statusText = computed(() => props.ha.connected ? 'Connected' : props.ha.receiving ? 'Receiving events' : props.ha.enabled ? 'Waiting for events' : 'Disabled')

function describe(e: HAEventRecord): string {
  const subject = e.friendlyName || e.device || e.entityId || 'unknown'
  if (e.action) return `${subject}: ${e.action}`
  if (e.state !== undefined) return `${subject}: ${e.previousState ? `${e.previousState} → ` : ''}${e.state}`
  return `${subject}: ${e.type}`
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    emit('info', 'Copied to clipboard')
  } catch {
    emit('error', 'Clipboard not available')
  }
}

async function run(label: string, fn: () => Promise<void>) {
  busy.value = true
  try {
    await fn()
  } catch (e: unknown) {
    const err = e as { data?: { error?: string }; message?: string }
    emit('error', `${label}: ${err?.data?.error || err?.message || 'failed'}`)
  } finally {
    busy.value = false
  }
}

function saveReflex() {
  return run('Save reflex', async () => {
    const actions = actionsText.value.split(',').map(s => s.trim()).filter(Boolean)
    await api('/api/homeassistant/config', { method: 'PUT', body: { reflexes: { weatherBriefing: { ...reflex, actions } } } })
    emit('info', 'Reflex saved')
    emit('reload')
  })
}

function testReflex(push: boolean) {
  return run('Briefing', async () => {
    const res = await api<{ result: { speak?: string }; pushed: string | null }>('/api/homeassistant/reflex/test', { method: 'POST', body: { reflexId: 'weather_briefing', push } })
    preview.value = res.result.speak || '(no speech)'
    if (push) emit('info', res.pushed === 'direct' ? 'Spoken via Home Assistant' : 'Queued — the house will pull it')
  })
}

function saveConnection() {
  return run('Save connection', async () => {
    const body: Record<string, unknown> = { mode: conn.mode }
    if (conn.mode === 'direct_api') body.direct_api = { url: conn.url, token: conn.token }
    if (conn.mode === 'cloud') body.cloud = { url: conn.url, token: conn.token }
    await api('/api/homeassistant/config', { method: 'PUT', body })
    emit('info', 'Connection saved')
    emit('reload')
  })
}

function testConnection() {
  return run('Test connection', async () => {
    const res = await api<{ success: boolean; entityCount?: number; error?: string }>('/api/homeassistant/test', { method: 'POST', body: { url: conn.url, token: conn.token } })
    if (res.success) emit('info', `Connected — ${res.entityCount} entities`)
    else emit('error', res.error || 'Connection failed')
  })
}

function regenerateToken() {
  return run('Regenerate token', async () => {
    await api('/api/homeassistant/token/regenerate', { method: 'POST', body: {} })
    emit('info', 'New token generated — update the Home Assistant secret')
    emit('reload')
  })
}
</script>

<style scoped>
.ha-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.ha-section-title { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
.ha-hint { color: var(--text-ghost); font-size: 12px; margin: 0 0 8px; line-height: 1.5; }
.ha-hint code, .ha-code { font-family: var(--mono); font-size: 11px; color: var(--text); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
.ha-secret { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.ha-code { flex: 1 1 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ha-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px 12px; }
.ha-grid .intg-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.ha-grid input[type="checkbox"] { width: 16px; height: 16px; }
.ha-preview { margin: 10px 0 0; padding: 10px 12px; background: rgba(3,169,244,0.08); border-radius: 6px; font-size: 13px; line-height: 1.5; }
.ha-events { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; font-size: 12px; }
.ha-events li { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border); }
.ha-time { color: var(--text-ghost); flex: 0 0 70px; }
.ha-desc { flex: 1; color: var(--text); }
.ha-handled { color: var(--green); }
</style>
