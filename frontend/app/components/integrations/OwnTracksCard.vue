<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#E91E63" stroke-width="2" style="width:20px;height:20px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
      <h3>OwnTracks</h3>
      <span class="intg-status" :class="owntracks.lastLocation ? 'online' : owntracks.enabled ? 'pending' : 'offline'">
        {{ owntracks.lastLocation ? 'Tracking' : owntracks.enabled ? 'Waiting' : 'Not configured' }}
      </span>
    </div>

    <template v-if="owntracks.lastLocation">
      <UiKvRow label="Latitude" :value="owntracks.lastLocation.lat.toFixed(5)" />
      <UiKvRow label="Longitude" :value="owntracks.lastLocation.lon.toFixed(5)" />
      <UiKvRow label="Last Update" :value="timeAgo(owntracks.lastLocation.timestamp)" />
      <UiKvRow v-if="owntracks.lastLocation.battery != null" label="Battery" :value="owntracks.lastLocation.battery + '%'" />
    </template>

    <div v-else-if="owntracks.enabled" class="ot-waiting">
      Waiting for first location report...
    </div>

    <div class="ot-setup">
      <label class="ssh-label">Setup</label>
      <div class="ot-instructions">
        <p>Configure OwnTracks app to send location updates:</p>
        <div class="ot-field">
          <span class="ot-field-label">Webhook URL:</span>
          <code class="ot-field-value">POST /owntracks</code>
        </div>
        <p class="ot-env-hint">
          Set <code>OWNTRACKS_USER</code> and <code>OWNTRACKS_DEVICE</code> environment variables to identify the device.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OwnTracksStatus } from '~/types/aria'

defineProps<{
  owntracks: OwnTracksStatus
}>()

const { timeAgo } = useTimeAgo()
</script>

<style scoped>
.ot-waiting {
  color: var(--text-ghost);
  font-size: 13px;
  padding: 8px 0;
}
.ot-setup { margin-top: 14px; }
.ot-instructions {
  padding: 10px 12px;
  background: rgba(233,30,99,0.06);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.ot-instructions p { margin: 0 0 6px; }
.ot-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.ot-field-label { font-size: 11px; color: var(--text-muted); }
.ot-field-value {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  background: rgba(255,255,255,0.06);
  padding: 2px 6px;
  border-radius: 3px;
}
.ot-env-hint { margin-top: 8px !important; }
.ot-env-hint code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  background: rgba(255,255,255,0.06);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
