<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#FF9800" stroke-width="2" style="width:20px;height:20px"><path d="M4 11a9 9 0 019 9"/><path d="M4 4a16 16 0 0116 16"/><circle cx="5" cy="19" r="1"/></svg>
      <h3>RSS Feeds</h3>
      <span class="intg-status" :class="rss.feeds.length ? 'online' : 'offline'">
        {{ rss.feeds.filter(f => f.enabled).length }} active
      </span>
    </div>

    <!-- Feed list -->
    <template v-if="rss.feeds.length">
      <div v-for="feed in rss.feeds" :key="feed.id" class="rss-feed-row">
        <UiStatusDot :status="feed.enabled ? 'ok' : 'warn'" />
        <span class="rss-feed-name">{{ feed.name }}</span>
        <span class="rss-feed-meta">{{ feed.itemCount }} items &middot; {{ timeAgo(feed.lastPoll) }}</span>
        <button class="btn danger rss-remove-btn" @click="remove(feed.id)">Remove</button>
      </div>
    </template>
    <div v-else style="color:var(--text-ghost);font-size:13px;padding:8px 0">
      No RSS feeds configured
    </div>

    <!-- Add feed form -->
    <div class="rss-add-section">
      <label class="ssh-label">Add Feed</label>
      <div class="rss-form">
        <input v-model="form.name" placeholder="Feed name" class="ssh-input" />
        <input v-model="form.url" placeholder="Feed URL" class="ssh-input" style="flex:2" />
        <button class="btn" :disabled="!canAdd" @click="add">Add</button>
      </div>
      <p v-if="addError" class="rss-error">{{ addError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RSSStatus } from '~/types/aria'

defineProps<{
  rss: RSSStatus
}>()

const emit = defineEmits<{
  reload: []
}>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const form = reactive({ name: '', url: '' })
const addError = ref('')

const canAdd = computed(() => form.name.trim() && form.url.trim())

async function add() {
  if (!canAdd.value) return
  addError.value = ''
  try {
    await api('/api/rss/feeds', {
      method: 'POST',
      body: { name: form.name.trim(), url: form.url.trim() },
    })
    form.name = ''
    form.url = ''
    emit('reload')
  } catch (e) {
    addError.value = e instanceof Error ? e.message : 'Failed to add feed'
  }
}

async function remove(id: string) {
  try {
    await api('/api/rss/feeds', { method: 'DELETE', body: { id } })
    emit('reload')
  } catch {
    // silent
  }
}
</script>

<style scoped>
.rss-feed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.rss-feed-name { font-size: 13px; color: var(--text); }
.rss-feed-meta { font-family: var(--mono); font-size: 10px; color: var(--text-muted); margin-left: auto; }
.rss-remove-btn { padding: 3px 8px; font-size: 11px; margin-left: 8px; }
.rss-add-section { margin-top: 14px; }
.rss-form {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.rss-error { color: var(--red); font-size: 12px; margin-top: 6px; }
</style>
