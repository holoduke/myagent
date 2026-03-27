<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#4285F4" stroke-width="2" style="width:20px;height:20px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <h3>Google Calendar</h3>
      <span class="intg-status" :class="calendar.enabled ? 'online' : 'offline'">
        {{ calendar.enabled ? 'Active' : 'Disabled' }}
      </span>
    </div>

    <template v-if="calendar.accounts.length">
      <div v-for="acc in calendar.accounts" :key="acc.id" class="cal-account">
        <UiStatusDot status="ok" />
        <span class="cal-email">{{ acc.email }}</span>
        <span class="cal-sync">Last sync: {{ timeAgo(acc.lastSync) }}</span>
      </div>
    </template>
    <div v-else class="cal-empty">
      No calendar accounts linked. Calendar uses your Gmail OAuth accounts &mdash; add a Gmail account with calendar scope to enable.
    </div>

    <div v-if="!calendar.enabled" class="cal-hint">
      Set <code>CALENDAR_ENABLED=true</code> in your environment to enable calendar polling.
    </div>

    <!-- Calendar tag configuration -->
    <template v-if="calendar.accounts.length">
      <div class="cal-config-section">
        <label class="intg-label">Calendar routing</label>
        <p class="cal-config-desc">Tag calendars so WhatsApp requests are routed to the right one.</p>

        <div v-if="loadingCalendars" class="cal-loading">Loading calendars...</div>
        <div v-else-if="fetchError" class="cal-error">{{ fetchError }}</div>

        <template v-else-if="availableCalendars.length">
          <div v-for="cal in availableCalendars" :key="cal.id" class="cal-row">
            <span class="cal-name">{{ cal.name }}</span>
            <select class="cal-tag-select" :value="getTag(cal.id)" @change="setTag(cal.id, cal.name, ($event.target as HTMLSelectElement).value)">
              <option value="">No tag</option>
              <option value="private">private</option>
              <option value="work">work</option>
            </select>
          </div>

          <div class="cal-actions">
            <button class="btn" :disabled="!dirty || saving" @click="save">{{ saving ? 'Saving...' : 'Save' }}</button>
            <span v-if="saved" class="cal-saved">Saved</span>
          </div>

          <div v-if="privateCalendar" class="cal-routing-info">
            WhatsApp calendar events route to: <strong>{{ privateCalendar.name }}</strong> (private)
          </div>
        </template>

        <div v-else class="cal-empty">
          <button class="btn" :disabled="loadingCalendars" @click="fetchCalendars">Load calendars</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { CalendarStatus, CalendarConfigEntry } from '~/types/aria'

const props = defineProps<{
  calendar: CalendarStatus
}>()

const emit = defineEmits<{
  reload: []
  error: [msg: string]
}>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const availableCalendars = ref<Array<{ id: string; name: string }>>([])
interface TagEntry { name: string; tag: 'private' | 'work' | null }

const tagMap = ref<Record<string, TagEntry>>({})
const savedTagMap = ref<Record<string, TagEntry>>({})
const loadingCalendars = ref(false)
const fetchError = ref('')
const saving = ref(false)
const saved = ref(false)

const dirty = computed(() => JSON.stringify(tagMap.value) !== JSON.stringify(savedTagMap.value))

const privateCalendar = computed(() => {
  const entries = Object.entries(tagMap.value) as Array<[string, TagEntry]>
  for (const [id, entry] of entries) {
    if (entry.tag === 'private') {
      return { id, name: entry.name }
    }
  }
  return null
})

function getTag(calId: string): string {
  return tagMap.value[calId]?.tag || ''
}

function setTag(calId: string, name: string, value: string) {
  const tag = (value === 'private' || value === 'work') ? value : null
  tagMap.value = { ...tagMap.value, [calId]: { name, tag } }
}

async function fetchCalendars() {
  if (!props.calendar.accounts.length) return
  loadingCalendars.value = true
  fetchError.value = ''
  try {
    // Fetch calendars from first authenticated account
    const accountId = props.calendar.accounts[0].id
    const [calResult, configResult] = await Promise.all([
      api<{ calendars: Array<{ id: string; name: string }> }>(`/api/calendar/calendars?accountId=${accountId}`),
      api<{ calendars: CalendarConfigEntry[] }>('/api/calendar/config'),
    ])
    availableCalendars.value = calResult.calendars

    // Build tag map from saved config
    const map: Record<string, { name: string; tag: 'private' | 'work' | null }> = {}
    for (const cal of calResult.calendars) {
      const saved = configResult.calendars.find((c: CalendarConfigEntry) => c.id === cal.id)
      map[cal.id] = { name: cal.name, tag: saved?.tag ?? null }
    }
    tagMap.value = map
    savedTagMap.value = JSON.parse(JSON.stringify(map))
  } catch (e) {
    fetchError.value = e instanceof Error ? e.message : 'Failed to load calendars'
  } finally {
    loadingCalendars.value = false
  }
}

async function save() {
  saving.value = true
  saved.value = false
  try {
    const entries = Object.entries(tagMap.value) as Array<[string, TagEntry]>
    const calendars: CalendarConfigEntry[] = entries.map(([id, entry]) => ({
      id,
      name: entry.name,
      tag: entry.tag,
    }))
    await api('/api/calendar/config', { method: 'POST', body: { calendars } })
    savedTagMap.value = JSON.parse(JSON.stringify(tagMap.value))
    saved.value = true
    setTimeout(() => { saved.value = false }, 3000)
    emit('reload')
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Failed to save calendar config')
  } finally {
    saving.value = false
  }
}

// Auto-fetch calendars when accounts are available
onMounted(() => {
  if (props.calendar.accounts.length) {
    fetchCalendars()
  }
})
</script>

<style scoped>
.cal-account {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.cal-email { font-size: 13px; color: var(--text); }
.cal-sync { font-family: var(--mono); font-size: 10px; color: var(--text-muted); margin-left: auto; }
.cal-empty { color: var(--text-ghost); font-size: 13px; padding: 8px 0; line-height: 1.5; }
.cal-hint { margin-top: 12px; padding: 8px 10px; background: rgba(66,133,244,0.08); border-radius: 6px; font-size: 12px; color: var(--text-muted); }
.cal-hint code { font-family: var(--mono); font-size: 11px; color: var(--text); background: rgba(255,255,255,0.06); padding: 1px 4px; border-radius: 3px; }

.cal-config-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
.cal-config-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 4px 0 10px;
}
.cal-loading {
  font-size: 12px;
  color: var(--text-ghost);
  padding: 8px 0;
}
.cal-error {
  color: var(--red);
  font-size: 12px;
  padding: 8px 0;
}
.cal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.cal-name {
  font-size: 13px;
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cal-tag-select {
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04);
  color: var(--text);
  cursor: pointer;
}
.cal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.cal-saved {
  font-size: 12px;
  color: var(--green, #4caf50);
}
.cal-routing-info {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(66,133,244,0.08);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.cal-routing-info strong {
  color: var(--text);
}
</style>
