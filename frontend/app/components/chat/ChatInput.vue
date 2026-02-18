<template>
  <div class="input-area">
    <textarea
      ref="inputRef"
      v-model="text"
      placeholder="Message ARIA..."
      rows="1"
      :disabled="chatStore.streaming"
      @input="autoResize"
      @keydown.enter.exact.prevent="send"
    ></textarea>
    <button class="send-btn" :disabled="chatStore.streaming || !text.trim()" @click="send">
      <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
const chatStore = useChatStore()
const text = ref('')
const inputRef = ref<HTMLTextAreaElement>()

function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

function send() {
  const msg = text.value.trim()
  if (!msg || chatStore.streaming) return
  text.value = ''
  if (inputRef.value) inputRef.value.style.height = 'auto'
  chatStore.sendMessage(msg)
}

function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<style scoped>
.input-area {
  padding: 10px 12px max(10px, env(safe-area-inset-bottom));
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  align-items: flex-end;
}
textarea {
  flex: 1;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  font-family: var(--sans);
  resize: none;
  outline: none;
  min-height: 42px;
  max-height: 160px;
  line-height: 1.4;
  transition: all .2s;
}
textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255,77,42,0.08); }
textarea::placeholder { color: var(--text-ghost); }
.send-btn {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all .2s;
  flex-shrink: 0;
}
.send-btn:hover { background: rgba(255,77,42,0.1); box-shadow: var(--glow-accent); }
.send-btn:disabled { opacity: .25; cursor: not-allowed; }
.send-btn svg { width: 17px; height: 17px; fill: currentColor; }
</style>
