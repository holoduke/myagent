<template>
  <div class="chat-header">
    <div class="chat-stats">
      <span>Msgs <b class="cv">{{ chatStore.messageCount }}</b></span>
      <span>Tokens <b class="cv">{{ chatStore.totalTokens.toLocaleString() }}</b></span>
      <span>Cost <b class="cv">${{ chatStore.totalCost.toFixed(4) }}</b></span>
    </div>
    <div class="chat-actions">
      <button class="chat-btn" title="QR Code" @click="$emit('showQr')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/><path d="M14 14h3v3"/></svg>
        <span>QR</span>
      </button>
      <button class="chat-btn" title="Reset" @click="chatStore.resetChat()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
        <span>Reset</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const chatStore = useChatStore()

defineEmits(['showQr'])
</script>

<style scoped>
.chat-header {
  padding: 10px 16px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.chat-stats {
  display: flex;
  gap: 14px;
  font-size: 11px;
  color: var(--text-ghost);
  font-variant-numeric: tabular-nums;
  font-family: var(--mono);
}
.chat-stats .cv { color: var(--text-muted); font-weight: 500; }
.chat-actions { display: flex; gap: 6px; }
.chat-btn {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  font-family: var(--mono);
  transition: all .15s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.chat-btn:hover { color: var(--text); border-color: var(--border-glow); }
.chat-btn svg { width: 13px; height: 13px; }

@media (max-width: 768px) {
  .chat-btn span { display: none; }
}
</style>
