<template>
  <div class="chat-page">
    <ChatChatHeader @show-qr="showQr = true" />

    <div ref="messagesEl" class="messages" @scroll="onScroll">
      <!-- Empty state -->
      <div v-if="!chatStore.messages.length && chatStore.streamPhase === 'idle'" class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <p>Talk to ARIA</p>
        <small>Messages from web and WhatsApp appear here</small>
      </div>

      <!-- Messages -->
      <ChatMessageBubble
        v-for="(msg, i) in chatStore.messages"
        :key="i"
        :message="msg"
      />

      <!-- Streaming message -->
      <div v-if="chatStore.streamPhase === 'queued'" class="mg assistant">
        <div class="bb">
          <div class="wait"><div class="spin"></div>Waiting in queue...</div>
        </div>
      </div>
      <div v-else-if="chatStore.streamPhase === 'streaming'" class="mg assistant">
        <div class="bb" v-html="streamHtml"></div>
      </div>
    </div>

    <!-- Scroll FAB -->
    <button v-show="showFab" class="scroll-fab" @click="scrollBottom">
      <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
    </button>

    <ChatChatInput ref="chatInput" />

    <!-- QR Modal -->
    <div v-if="showQr" class="qr-overlay" @click="showQr = false">
      <div class="qr-box" @click.stop>
        <h2>Mobile Access</h2>
        <img :src="qrUrl" alt="QR Code">
        <p>{{ origin }}</p>
        <button class="close-btn" @click="showQr = false">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const chatStore = useChatStore()
const { $marked } = useNuxtApp()

const messagesEl = ref<HTMLElement>()
const chatInput = ref<InstanceType<typeof import('~/components/chat/ChatInput.vue').default>>()
const showFab = ref(false)
const showQr = ref(false)

const origin = ref('')
onMounted(() => {
  origin.value = window.location.origin
})

const qrUrl = computed(() => {
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=ff4d2a&bgcolor=0c0c18&data=${encodeURIComponent(origin.value)}`
})

const streamHtml = computed(() => {
  if (!chatStore.streamContent) return '<span class="cur"></span>'
  const html = $marked ? $marked(chatStore.streamContent) : chatStore.streamContent
  return html + '<span class="cur"></span>'
})

function scrollBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  })
  showFab.value = false
}

function onScroll() {
  if (!messagesEl.value) return
  const el = messagesEl.value
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  showFab.value = !atBottom
}

// Auto-scroll when new messages arrive or streaming
watch(() => chatStore.messages.length, () => scrollBottom())
watch(() => chatStore.streamContent, () => {
  if (!showFab.value) scrollBottom()
})

// Load history on mount
onMounted(async () => {
  await chatStore.loadHistory()
  scrollBottom()
  chatInput.value?.focus()
})
</script>

<style scoped>
.chat-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overscroll-behavior: contain;
  position: relative;
}
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.scroll-fab {
  position: absolute;
  bottom: 80px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-dim);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
  transition: all .2s;
}
.scroll-fab:hover { color: var(--accent); border-color: var(--accent); }
.scroll-fab svg { width: 16px; height: 16px; fill: currentColor; }

@media (max-width: 768px) {
  .messages { padding: 12px 8px; }
}
</style>
