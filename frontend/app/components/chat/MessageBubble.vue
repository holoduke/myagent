<template>
  <div class="mg" :class="message.role">
    <div class="bb" v-html="renderedContent"></div>
    <div v-if="hasMeta" class="meta">
      <template v-if="message.stats">
        <span>{{ formatDuration(message.stats.durationMs) }}</span>
        <span>{{ (message.stats.inputTokens + message.stats.outputTokens).toLocaleString() }} tok</span>
        <span>${{ message.stats.totalCostUsd.toFixed(4) }}</span>
        <span v-if="message.stats.numTurns > 1">{{ message.stats.numTurns }} turns</span>
      </template>
      <span v-if="message.source === 'whatsapp'" class="src-wa">WhatsApp</span>
      <span v-if="message.timestamp">{{ fmtTime(message.timestamp) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/types/aria'

const props = defineProps<{
  message: ChatMessage
}>()

const { $marked } = useNuxtApp()
const { fmtTime } = useTimeAgo()

const renderedContent = computed(() => {
  if (props.message.role === 'user') {
    return escapeHtml(props.message.content)
  }
  if (props.message.role === 'assistant' || props.message.role === 'system') {
    return $marked ? $marked(props.message.content) : props.message.content
  }
  return escapeHtml(props.message.content)
})

const hasMeta = computed(() => {
  return props.message.stats || props.message.source || props.message.timestamp
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}
</script>
