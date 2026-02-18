<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <h3>Scheduled Messages</h3>
      <span class="intg-status" :class="messages.length ? 'pending' : 'online'">
        {{ messages.length }} pending
      </span>
    </div>
    <template v-if="messages.length">
      <div v-for="(m, i) in messages" :key="i" class="sched-item">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="sched-target">{{ m.targetJid }}</span>
          <span class="sched-time">{{ fmtDate(m.deliverAt) }}</span>
        </div>
        <div class="sched-msg">{{ truncate(m.message, 120) }}</div>
      </div>
    </template>
    <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
      No scheduled messages
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ScheduledMessage } from '~/types/aria'

defineProps<{
  messages: ScheduledMessage[]
}>()

const { fmtDate } = useTimeAgo()

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + '...' : s
}
</script>
