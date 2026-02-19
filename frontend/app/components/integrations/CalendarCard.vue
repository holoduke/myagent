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
  </div>
</template>

<script setup lang="ts">
import type { CalendarStatus } from '~/types/aria'

defineProps<{
  calendar: CalendarStatus
}>()

const { timeAgo } = useTimeAgo()
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
</style>
