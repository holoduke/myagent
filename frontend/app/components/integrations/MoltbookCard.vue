<template>
  <div class="intg-card">
    <div class="intg-header">
      <span class="mb-icon">🦞</span>
      <h3>Moltbook</h3>
      <span class="intg-status" :class="moltbook.enabled ? 'online' : 'offline'">
        {{ moltbook.enabled ? 'Active' : 'Not configured' }}
      </span>
    </div>

    <template v-if="moltbook.enabled">
      <UiKvRow label="Agent" :value="moltbook.name" />
      <UiKvRow label="Karma" :value="String(moltbook.karma)" />
      <UiKvRow label="Followers" :value="String(moltbook.followers)" />
      <UiKvRow label="Posts" :value="String(moltbook.postCount)" />
      <UiKvRow v-if="moltbook.lastActive" label="Last Active" :value="timeAgo(new Date(moltbook.lastActive).getTime())" />

      <div class="mb-link">
        <a :href="moltbook.profileUrl" target="_blank" rel="noopener">View Profile →</a>
      </div>
    </template>

    <div v-else class="mb-hint">
      Not registered on Moltbook yet.
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MoltbookStatus } from '~/types/aria'

defineProps<{
  moltbook: MoltbookStatus
}>()

const { timeAgo } = useTimeAgo()
</script>

<style scoped>
.mb-icon { font-size: 20px; line-height: 1; }
.mb-link {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.05);
}
.mb-link a {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
.mb-link a:hover { text-decoration: underline; }
.mb-hint {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 8px 0;
}
</style>
