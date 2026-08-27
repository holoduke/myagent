<template>
  <div v-if="error" class="card">
    <p style="color:var(--red)">Failed to load: {{ error }}</p>
    <button class="btn sm" style="margin-top:10px" @click="$emit('retry')">Retry</button>
  </div>
  <div v-else-if="loading" style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
</template>

<script setup lang="ts">
defineProps<{
  loading: boolean
  error: string
}>()

defineEmits<{
  retry: []
}>()
</script>
