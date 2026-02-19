<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click="$emit('close')">
      <div class="modal-box" :style="{ maxWidth: maxWidth || '560px' }" @click.stop>
        <div class="modal-header">
          <h2><span v-if="icon" v-html="icon" /> {{ title }}</h2>
          <button class="modal-close" @click="$emit('close')">&times;</button>
        </div>
        <div class="modal-body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{
  open: boolean
  title: string
  icon?: string
  maxWidth?: string
}>()

defineEmits(['close'])
</script>
