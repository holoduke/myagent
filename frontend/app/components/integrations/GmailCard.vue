<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#EA4335" stroke-width="2" style="width:20px;height:20px"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      <h3>Gmail</h3>
      <span class="intg-status" :class="gmail.authenticated > 0 ? 'online' : 'pending'">
        {{ gmail.authenticated }}/{{ gmail.total }} Active
      </span>
    </div>
    <template v-if="accounts.length">
      <div v-for="acc in accounts" :key="acc.id" class="gmail-account">
        <UiStatusDot :status="acc.authenticated ? 'ok' : 'warn'" />
        <span class="gmail-email">{{ acc.email }}</span>
        <a v-if="!acc.authenticated" :href="`/gmail/auth/${acc.id}`" class="btn" style="margin-left:auto;padding:4px 10px;font-size:11px">Authorize</a>
        <span v-else class="gmail-poll">Last poll: {{ acc.lastPoll ? timeAgo(acc.lastPoll) : 'never' }}</span>
      </div>
    </template>
    <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
      No Gmail accounts configured
    </div>
  </div>
</template>

<script setup lang="ts">
import type { GmailAccount } from '~/types/aria'

defineProps<{
  gmail: { total: number; authenticated: number }
  accounts: GmailAccount[]
}>()

const { timeAgo } = useTimeAgo()
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
</style>
