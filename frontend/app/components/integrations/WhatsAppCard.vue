<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2" style="width:20px;height:20px"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
      <h3>WhatsApp</h3>
      <span class="intg-status" :class="whatsapp.connected ? 'online' : 'offline'">
        {{ whatsapp.connected ? 'Connected' : 'Disconnected' }}
      </span>
    </div>
    <UiKvRow label="Contacts" :value="whatsapp.contactCount || 0" />
    <div class="btn-row">
      <button class="btn" @click="$emit('syncContacts')">Sync Contacts</button>
      <button class="btn" @click="$emit('showQr')">Show QR</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  whatsapp: { connected: boolean; contactCount: number }
}>()

defineEmits(['syncContacts', 'showQr'])
</script>
