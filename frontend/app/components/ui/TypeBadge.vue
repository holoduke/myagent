<template>
  <span class="type-badge" :class="type">{{ type }}</span>
</template>

<script setup lang="ts">
defineProps<{
  type: string
}>()
</script>
