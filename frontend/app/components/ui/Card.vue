<template>
  <div class="card">
    <h2 v-if="title">
      <span v-if="icon" v-html="icon"></span>
      {{ title }}
    </h2>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title?: string
  icon?: string
}>()
</script>
