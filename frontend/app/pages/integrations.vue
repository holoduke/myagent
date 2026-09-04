<template>
  <div class="section">
    <div class="section-top">
      <LayoutSectionHeader>Integrations</LayoutSectionHeader>
      <button v-if="dashboard && inactiveIntegrations.length" class="add-btn" aria-label="Add integration" @click="showAddModal = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="dashboard">
      <!-- Active Integration Tiles -->
      <div v-if="activeIntegrations.length" class="intg-tiles">
        <div v-for="intg in activeIntegrations" :key="intg.key" class="intg-tile" :class="{ 'intg-tile--disabled': !isEnabled(intg.key) }" @click="activeModal = intg.key">
          <div class="intg-tile-header">
            <div class="intg-tile-icon" v-html="intg.icon"></div>
            <label class="intg-toggle" @click.stop>
              <input type="checkbox" :checked="isEnabled(intg.key)" role="switch" :aria-checked="isEnabled(intg.key)" :aria-label="'Toggle ' + intg.name" @change="toggleIntegration(intg.key)">
              <span class="intg-toggle-slider"></span>
            </label>
          </div>
          <div class="intg-tile-name">{{ intg.name }}</div>
          <div class="intg-tile-row">
            <span v-if="!isEnabled(intg.key)" class="intg-status offline">Disabled</span>
            <span v-else class="intg-status" :class="intg.statusClass">{{ intg.statusText }}</span>
            <span class="intg-tile-stat">{{ intg.stat }}</span>
          </div>
        </div>
      </div>

      <div v-else class="empty-hint" style="padding:40px">
        No integrations configured yet. Click the <strong>+</strong> button to add one.
      </div>

      <!-- Add Integration Modal -->
      <UiModal :open="showAddModal" title="Add Integration" @close="showAddModal = false">
        <p class="add-hint">Select an integration to configure:</p>
        <div class="add-list">
          <div v-for="intg in inactiveIntegrations" :key="intg.key" class="add-item" @click="activateIntegration(intg.key)">
            <div class="add-item-icon" v-html="intg.icon"></div>
            <div class="add-item-info">
              <div class="add-item-name">{{ intg.name }}</div>
              <div class="add-item-desc">{{ intg.description }}</div>
            </div>
            <svg class="add-item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </div>
      </UiModal>

      <!-- Integration Modals -->
      <UiModal :open="activeModal === 'whatsapp'" title="WhatsApp" @close="activeModal = null">
        <IntegrationsWhatsAppCard :whatsapp="waData" @sync-contacts="syncContacts" @error="(msg: string) => showToast(msg, 'error')" />
      </UiModal>

      <UiModal :open="activeModal === 'gmail'" title="Gmail" @close="activeModal = null">
        <IntegrationsGmailCard :gmail="gmailData" :accounts="dashboard.gmailAccounts || []" @reload="load" @error="(msg: string) => showToast(msg, 'error')" />
      </UiModal>

      <UiModal :open="activeModal === 'ssh'" title="SSH" max-width="640px" @close="activeModal = null">
        <IntegrationsSSHCard :ssh="sshData" :testing="sshTesting" @test="sshTest" @add="sshAdd" @remove="sshRemove" />
      </UiModal>

      <UiModal :open="activeModal === 'scheduled'" title="Scheduled Messages" @close="activeModal = null">
        <IntegrationsScheduledCard :messages="scheduled" />
      </UiModal>

      <UiModal :open="activeModal === 'calendar'" title="Google Calendar" @close="activeModal = null">
        <IntegrationsCalendarCard :calendar="calendarData" @reload="load" @error="(msg: string) => showToast(msg, 'error')" />
      </UiModal>

      <UiModal :open="activeModal === 'homeassistant'" title="Home Assistant" @close="activeModal = null">
        <IntegrationsHomeAssistantCard :ha="haData" @reload="load" @error="(msg: string) => showToast(msg, 'error')" @info="(msg: string) => showToast(msg, 'success')" />
      </UiModal>

      <UiModal :open="activeModal === 'rss'" title="RSS Feeds" max-width="640px" @close="activeModal = null">
        <IntegrationsRSSCard :rss="rssData" @reload="load" @error="(msg: string) => showToast(msg, 'error')" />
      </UiModal>

      <UiModal :open="activeModal === 'news'" title="News Digest" @close="activeModal = null">
        <p class="add-hint">
          Once per day (default 07:00 local) ARIA fetches headlines from the configured news feeds,
          filters them against your interests with a cheap LLM pass, and stores a single short briefing
          as ephemeral memory. It never sends proactive messages. Use the toggle on the tile to enable
          or disable it; feeds live in <code>/data/news/feeds.json</code>.
        </p>
      </UiModal>

      <UiModal :open="activeModal === 'playstore'" title="Play Store" max-width="640px" @close="activeModal = null">
        <IntegrationsPlayStoreCard @error="(msg: string) => showToast(msg, 'error')" />
        <p class="add-hint" style="margin-top:12px">
          ARIA sends a daily WhatsApp report at 09:00 local (<code>PLAYSTORE_DIGEST_HOUR</code> to change)
          and can reply to reviews when you ask her to.
        </p>
      </UiModal>

      <UiModal :open="activeModal === 'owntracks'" title="OwnTracks" @close="activeModal = null">
        <IntegrationsOwnTracksCard :owntracks="otData" />
      </UiModal>

      <UiModal :open="activeModal === 'browser'" title="Browser Automation" max-width="640px" @close="activeModal = null">
        <IntegrationsBrowserCard :browser="browserData" @reload="load" @error="(msg: string) => showToast(msg, 'error')" />
      </UiModal>

      <UiModal :open="activeModal === 'twilio'" title="Twilio Voice" max-width="640px" @close="activeModal = null">
        <IntegrationsTwilioCard :twilio="twilioData" @reload="load" @error="(msg: string) => showToast(msg, 'error')" />
      </UiModal>

      <UiModal :open="activeModal === 'moltbook'" title="Moltbook" @close="activeModal = null">
        <IntegrationsMoltbookCard :moltbook="moltbookData" />
      </UiModal>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { DashboardData, ScheduledMessage, SSHStatus, CalendarStatus, HomeAssistantStatus, RSSStatus, OwnTracksStatus, TwilioStatus, BrowserStatus, MoltbookStatus } from '~/types/aria'

const route = useRoute()
const router = useRouter()
const { api } = useApi()
const { showToast } = useToast()

const dashboard = ref<DashboardData | null>(null)
const scheduled = ref<ScheduledMessage[]>([])
const error = ref('')
const activeModal = ref<string | null>(null)
const showAddModal = ref(false)
const sshTesting = ref('')
const integrationsEnabled = ref<Record<string, boolean>>({})

function isEnabled(key: string): boolean {
  return integrationsEnabled.value[key] !== false
}

async function toggleIntegration(key: string) {
  const prev = isEnabled(key)
  integrationsEnabled.value = { ...integrationsEnabled.value, [key]: !prev }
  try {
    await api<Record<string, boolean>>('/api/integrations/config', {
      method: 'PUT',
      body: { [key]: !prev },
    })
    showToast(`${key} ${!prev ? 'enabled' : 'disabled'}`, 'success')
  } catch {
    integrationsEnabled.value = { ...integrationsEnabled.value, [key]: prev }
    showToast(`Failed to update ${key}`, 'error')
  }
}

const waData = computed(() => dashboard.value?.whatsapp || { connected: false, contactCount: 0 })
const gmailData = computed(() => dashboard.value?.gmail || { total: 0, authenticated: 0 })
const sshData = computed<SSHStatus>(() => dashboard.value?.ssh || { keyGenerated: false, publicKey: '', targets: [] })
const calendarData = computed<CalendarStatus>(() => dashboard.value?.calendar || { enabled: false, accounts: [], nextEventCount: 0 })
const haData = computed<HomeAssistantStatus>(() => dashboard.value?.homeassistant || { enabled: false, connected: false, url: '', entityCount: 0, lastPoll: 0 })
const rssData = computed<RSSStatus>(() => dashboard.value?.rss || { feeds: [] })
const otData = computed<OwnTracksStatus>(() => dashboard.value?.owntracks || { enabled: false, lastLocation: null })
const browserData = computed<BrowserStatus>(() => dashboard.value?.browser || { ready: false, activeSessions: 0, totalTasks: 0, lastTaskAt: 0, recentTasks: [] })
const twilioData = computed<TwilioStatus>(() => dashboard.value?.twilio || { enabled: false, configured: false, phoneNumber: '', webhookBaseUrl: '', activeCalls: 0, totalCalls: 0, lastCallAt: 0, recentCalls: [], config: null })
const moltbookData = computed<MoltbookStatus>(() => dashboard.value?.moltbook || { enabled: false, name: '', profileUrl: '', karma: 0, followers: 0, postCount: 0, lastActive: null })

interface IntegrationDef {
  key: string
  name: string
  description: string
  icon: string
  isActive: () => boolean
  statusClass: string
  statusText: string
  stat: string
}

const integrations = computed<IntegrationDef[]>(() => [
  {
    key: 'whatsapp',
    name: 'WhatsApp',
    description: 'Observe and respond to WhatsApp messages',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
    isActive: () => waData.value.connected || waData.value.contactCount > 0,
    statusClass: waData.value.connected ? 'online' : 'offline',
    statusText: waData.value.connected ? 'Connected' : 'Disconnected',
    stat: `${waData.value.contactCount} contacts`,
  },
  {
    key: 'gmail',
    name: 'Gmail',
    description: 'Monitor email accounts for new messages',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#EA4335" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    isActive: () => gmailData.value.total > 0,
    statusClass: gmailData.value.authenticated > 0 ? 'online' : 'pending',
    statusText: `${gmailData.value.authenticated}/${gmailData.value.total} Active`,
    stat: `${gmailData.value.total} accounts`,
  },
  {
    key: 'ssh',
    name: 'SSH',
    description: 'Manage remote server connections',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    isActive: () => sshData.value.keyGenerated || sshData.value.targets.length > 0,
    statusClass: sshData.value.keyGenerated ? 'online' : 'err',
    statusText: sshData.value.keyGenerated ? 'Key Ready' : 'No Key',
    stat: `${sshData.value.targets.length} targets`,
  },
  {
    key: 'scheduled',
    name: 'Scheduled',
    description: 'Schedule messages for future delivery',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    isActive: () => scheduled.value.length > 0,
    statusClass: scheduled.value.length ? 'pending' : 'online',
    statusText: `${scheduled.value.length} pending`,
    stat: 'messages',
  },
  {
    key: 'calendar',
    name: 'Calendar',
    description: 'Track upcoming Google Calendar events',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#4285F4" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    isActive: () => calendarData.value.enabled || calendarData.value.accounts.length > 0,
    statusClass: calendarData.value.enabled ? 'online' : 'offline',
    statusText: calendarData.value.enabled ? 'Active' : 'Disabled',
    stat: `${calendarData.value.accounts.length} accounts`,
  },
  {
    key: 'homeassistant',
    name: 'Home Assistant',
    description: 'Monitor smart home device states',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#03A9F4" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    isActive: () => haData.value.enabled,
    statusClass: (haData.value.connected || haData.value.receiving) ? 'online' : haData.value.enabled ? 'pending' : 'offline',
    statusText: haData.value.connected ? 'Connected' : haData.value.receiving ? 'Receiving' : haData.value.enabled ? 'Waiting for events' : 'Disabled',
    stat: `${haData.value.eventsToday ?? 0} events today`,
  },
  {
    key: 'rss',
    name: 'RSS Feeds',
    description: 'Follow news and content from RSS feeds',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#FF9800" stroke-width="2"><path d="M4 11a9 9 0 019 9"/><path d="M4 4a16 16 0 0116 16"/><circle cx="5" cy="19" r="1"/></svg>',
    isActive: () => rssData.value.feeds.length > 0,
    statusClass: rssData.value.feeds.length ? 'online' : 'offline',
    statusText: `${rssData.value.feeds.filter(f => f.enabled).length} active`,
    stat: `${rssData.value.feeds.length} feeds`,
  },
  {
    key: 'news',
    name: 'News Digest',
    description: 'Daily filtered news briefing for ambient awareness',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2"><path d="M4 22h16a2 2 0 002-2V4a2 2 0 00-2-2H8a2 2 0 00-2 2v16a2 2 0 01-4 0V11a2 2 0 012-2h2"/><line x1="10" y1="7" x2="18" y2="7"/><line x1="10" y1="11" x2="18" y2="11"/><line x1="10" y1="15" x2="18" y2="15"/></svg>',
    isActive: () => isEnabled('news'),
    statusClass: isEnabled('news') ? 'online' : 'offline',
    statusText: isEnabled('news') ? 'Daily' : 'Disabled',
    stat: 'once per day',
  },
  {
    key: 'playstore',
    name: 'Play Store',
    description: 'Daily Football Mania vitals and reviews via WhatsApp',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#34A853" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/><line x1="5" y1="3" x2="14" y2="12"/><line x1="5" y1="21" x2="14" y2="12"/></svg>',
    isActive: () => isEnabled('playstore'),
    statusClass: isEnabled('playstore') ? 'online' : 'offline',
    statusText: isEnabled('playstore') ? 'Daily' : 'Disabled',
    stat: 'vitals + reviews',
  },
  {
    key: 'owntracks',
    name: 'OwnTracks',
    description: 'Track location via OwnTracks app',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#E91E63" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    isActive: () => otData.value.enabled || otData.value.lastLocation !== null,
    statusClass: otData.value.lastLocation ? 'online' : otData.value.enabled ? 'pending' : 'offline',
    statusText: otData.value.lastLocation ? 'Tracking' : otData.value.enabled ? 'Waiting' : 'Not configured',
    stat: otData.value.lastLocation ? 'Location known' : 'No data',
  },
  {
    key: 'browser',
    name: 'Browser',
    description: 'Headless browser automation with Playwright',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
    isActive: () => browserData.value.ready || browserData.value.totalTasks > 0,
    statusClass: browserData.value.ready ? 'online' : browserData.value.totalTasks > 0 ? 'pending' : 'offline',
    statusText: browserData.value.ready ? 'Ready' : browserData.value.totalTasks > 0 ? 'Idle' : 'Not used',
    stat: `${browserData.value.totalTasks} tasks`,
  },
  {
    key: 'twilio',
    name: 'Twilio Voice',
    description: 'Make AI-powered voice calls',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#06B6D4" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>',
    isActive: () => twilioData.value.configured,
    statusClass: twilioData.value.configured ? (twilioData.value.activeCalls > 0 ? 'pending' : 'online') : 'offline',
    statusText: twilioData.value.configured ? (twilioData.value.activeCalls > 0 ? `${twilioData.value.activeCalls} active` : 'Ready') : 'Not configured',
    stat: `${twilioData.value.totalCalls} calls`,
  },
  {
    key: 'moltbook',
    name: 'Moltbook',
    description: 'AI social network — post, comment, and interact with other agents',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#F97316" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
    isActive: () => moltbookData.value.enabled,
    statusClass: moltbookData.value.enabled ? 'online' : 'offline',
    statusText: moltbookData.value.enabled ? 'Active' : 'Not configured',
    stat: moltbookData.value.enabled ? `${moltbookData.value.karma} karma` : '',
  },
])

const activeIntegrations = computed(() => integrations.value.filter(i => i.isActive()))
const inactiveIntegrations = computed(() => integrations.value.filter(i => !i.isActive()))

function activateIntegration(key: string) {
  showAddModal.value = false
  activeModal.value = key
}

async function load() {
  try {
    const [dash, sched] = await Promise.all([
      api<DashboardData>('/api/dashboard'),
      api<ScheduledMessage[]>('/api/scheduled'),
    ])
    dashboard.value = dash
    scheduled.value = sched
    integrationsEnabled.value = dash.integrationsEnabled || {}
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
    showToast('Failed to sync WhatsApp contacts', 'error')
  }
}

async function sshTest(id: string) {
  sshTesting.value = id
  try {
    await api<{ success: boolean; error?: string }>('/api/ssh/test', { method: 'POST', body: { id } })
    await load()
  } catch {
    showToast('SSH connection test failed', 'error')
  } finally {
    sshTesting.value = ''
  }
}

async function sshAdd(data: { label: string; host: string; user: string; port: number }) {
  try {
    await api<{ success: boolean }>('/api/ssh/targets', { method: 'POST', body: data })
    await load()
  } catch {
    showToast('Failed to add SSH target', 'error')
  }
}

async function sshRemove(id: string) {
  try {
    await api<{ success: boolean }>('/api/ssh/targets', { method: 'DELETE', body: { id } })
    await load()
  } catch {
    showToast('Failed to remove SSH target', 'error')
  }
}

useVisibilityRefresh(load)

onMounted(async () => {
  await load()

  if (route.query.gmail_connected) {
    showToast(`Gmail account "${route.query.gmail_connected}" connected successfully`, 'success')
    router.replace({ query: { ...route.query, gmail_connected: undefined } })
  } else if (route.query.gmail_error) {
    showToast(`Gmail auth failed: ${route.query.gmail_error}`, 'error')
    router.replace({ query: { ...route.query, gmail_error: undefined } })
  }
})
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

.section-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.section-top :deep(.section-header) {
  margin-bottom: 0;
}

.add-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all .2s;
}
.add-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: var(--glow-accent);
}
.add-btn svg {
  width: 18px;
  height: 18px;
}

.empty-hint {
  color: var(--text-ghost);
  text-align: center;
  font-size: 14px;
}
.empty-hint strong {
  color: var(--accent);
}

.add-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.add-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.add-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: all .2s;
}
.add-item:hover {
  border-color: var(--border-glow);
  background: var(--bg-card);
  box-shadow: var(--glow-card);
}
.add-item-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}
.add-item-icon :deep(svg) {
  width: 28px;
  height: 28px;
}
.add-item-info {
  flex: 1;
  min-width: 0;
}
.add-item-name {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
}
.add-item-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.add-item-arrow {
  width: 16px;
  height: 16px;
  color: var(--text-ghost);
  flex-shrink: 0;
  transition: color .2s;
}
.add-item:hover .add-item-arrow {
  color: var(--accent);
}

.intg-tile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.intg-tile--disabled {
  opacity: 0.45;
  filter: saturate(0.3);
}
.intg-tile--disabled .intg-toggle {
  opacity: 1;
  filter: saturate(3);
}

.intg-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  cursor: pointer;
}
.intg-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.intg-toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 10px;
  transition: background .2s;
}
.intg-toggle-slider::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  left: 3px;
  bottom: 3px;
  background: var(--text-muted);
  border-radius: 50%;
  transition: transform .2s, background .2s;
}
.intg-toggle input:checked + .intg-toggle-slider {
  background: var(--accent);
}
.intg-toggle input:checked + .intg-toggle-slider::before {
  transform: translateX(16px);
  background: #fff;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
}
</style>
