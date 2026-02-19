<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#03A9F4" stroke-width="2" style="width:20px;height:20px"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <h3>Home Assistant</h3>
      <span class="intg-status" :class="ha.connected ? 'online' : ha.enabled ? 'pending' : 'offline'">
        {{ ha.connected ? 'Connected' : ha.enabled ? 'Disconnected' : 'Not configured' }}
      </span>
    </div>

    <template v-if="ha.enabled">
      <UiKvRow label="URL" :value="ha.url" />
      <UiKvRow label="Entities" :value="ha.entityCount" />
      <UiKvRow label="Last Poll" :value="timeAgo(ha.lastPoll)" />
    </template>

    <div v-else class="ha-setup">
      <p class="ha-hint">Configure Home Assistant by setting environment variables:</p>
      <div class="ha-env-list">
        <code>HA_URL</code> &mdash; Base URL (e.g. http://192.168.1.100:8123)
        <br/>
        <code>HA_TOKEN</code> &mdash; Long-lived access token
        <br/>
        <code>HA_ENTITIES</code> &mdash; Entity domain prefixes (default: light,switch,lock,climate,binary_sensor,sensor)
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { HomeAssistantStatus } from '~/types/aria'

defineProps<{
  ha: HomeAssistantStatus
}>()

const { timeAgo } = useTimeAgo()
</script>

<style scoped>
.ha-setup { padding: 8px 0; }
.ha-hint { color: var(--text-ghost); font-size: 13px; margin-bottom: 8px; }
.ha-env-list {
  padding: 10px 12px;
  background: rgba(3,169,244,0.06);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.8;
}
.ha-env-list code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  background: rgba(255,255,255,0.06);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
