<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#E01E5A" stroke-width="2" style="width:20px;height:20px"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z"/><path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z"/><path d="M14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z"/><path d="M15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z"/><path d="M10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5z"/><path d="M8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z"/></svg>
      <h3>Slack</h3>
      <span class="intg-status" :class="statusClass">{{ statusText }}</span>
    </div>

    <p v-if="loading" class="sl-hint">Loading…</p>
    <template v-else>
      <!-- Workspaces -->
      <div v-for="w in status.workspaces" :key="w.id" class="sl-section">
        <div class="sl-section-title">Workspace {{ w.teamName }} <span class="sl-id">({{ w.id }})</span></div>
        <UiKvRow label="Bot" :value="w.scopes?.user || (w.authenticated ? 'connected' : 'not connected')" />
        <UiKvRow label="Last poll" :value="w.lastPoll ? timeAgo(w.lastPoll) : 'never'" />
        <UiKvRow label="Conversations polled" :value="w.channelCount" />
        <div v-if="w.scopes && !w.scopes.ok" class="sl-warn">
          Token is missing scopes: {{ w.scopes.missing }}
          <div class="sl-hint">Needed: <code>{{ status.wantedScopes }}</code>. Add them under <em>OAuth &amp; Permissions</em> on api.slack.com, click <em>Reinstall to workspace</em>, then paste the new Bot User OAuth Token below.</div>
        </div>
        <div class="sl-row">
          <input v-model="tokenInput[w.id]" type="password" class="intg-input" placeholder="xoxb-… (paste new bot token)" />
          <button class="btn primary sm" :disabled="busy || !tokenInput[w.id]" @click="saveToken(w.id)">Save token</button>
          <a v-if="w.authUrl" class="btn sm" :href="w.authUrl" target="_blank" rel="noopener">OAuth link</a>
        </div>
      </div>

      <!-- Start a conversation -->
      <div class="sl-section">
        <div class="sl-section-title">Talk to someone</div>
        <p class="sl-hint">ARIA only replies on Slack to people with an active conversation below. The goal tells her what the conversation is about; replies are capped per hour and per day.</p>
        <div class="sl-row">
          <select v-model="form.workspaceId" class="intg-input intg-input-sm">
            <option v-for="w in status.workspaces" :key="w.id" :value="w.id">{{ w.teamName }}</option>
          </select>
          <input v-model="userQuery" class="intg-input" placeholder="Search a person (name or email)" @keyup.enter="searchUsers" />
          <button class="btn sm" :disabled="busy || !userQuery" @click="searchUsers">Search</button>
        </div>
        <div v-if="users.length" class="sl-users">
          <button v-for="u in users" :key="u.id" class="sl-user" :class="{ active: form.userId === u.id }" @click="pickUser(u)">
            {{ u.realName || u.name }} <span class="sl-id">{{ u.id }}</span><span v-if="u.isBot" class="sl-id"> bot</span>
          </button>
        </div>
        <input v-model="form.name" class="intg-input" placeholder="Name (as ARIA should call them)" />
        <textarea v-model="form.goal" class="intg-input sl-textarea" rows="3" placeholder="Goal / instructions for ARIA in this conversation, e.g. 'Je praat met Marvin's AI-agent. Stel je voor als ARIA, vraag wat hij kan, en probeer een korte kennismaking te voeren. Hou het luchtig en kort.'" />
        <textarea v-model="form.opening" class="intg-input sl-textarea" rows="2" placeholder="Opening message (optional, sent right away)" />
        <div class="btn-row">
          <button class="btn primary" :disabled="busy || !form.userId || form.goal.length < 10" @click="startConversation">Start conversation</button>
        </div>
      </div>

      <!-- Active conversations -->
      <div class="sl-section">
        <div class="sl-section-title">Active conversations</div>
        <p v-if="!status.conversations.length" class="sl-hint">None yet.</p>
        <div v-for="c in status.conversations" :key="c.id" class="sl-conv">
          <div><strong>{{ c.contactName || c.contactJid }}</strong> <span class="sl-id">{{ c.contactJid }}</span></div>
          <div class="sl-goal">{{ c.goal }}</div>
          <div class="btn-row">
            <button class="btn danger sm" :disabled="busy" @click="endConversation(c.id)">End</button>
          </div>
        </div>
      </div>

      <!-- Recent replies -->
      <div class="sl-section">
        <div class="sl-section-title">Recent Slack replies</div>
        <p v-if="!status.recentReplies.length" class="sl-hint">No replies yet.</p>
        <ul v-else class="sl-log">
          <li v-for="(r, i) in status.recentReplies" :key="i">
            <span class="sl-time">{{ timeAgo(r.timestamp) }}</span>
            <span class="sl-who">{{ r.senderName }}:</span> {{ r.messageSnippet }}
            <div class="sl-reply" :class="{ err: !r.sent }">→ {{ r.sent ? r.decision.reply : (r.error || r.decision.reason) }}</div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { SlackStatus, SlackUser } from '~/types/aria'

const emit = defineEmits<{ reload: []; error: [msg: string]; info: [msg: string] }>()
const { api } = useApi()
const { timeAgo } = useTimeAgo()

const loading = ref(true)
const busy = ref(false)
const status = ref<SlackStatus>({ workspaces: [], wantedScopes: '', conversations: [], recentReplies: [] })
const tokenInput = reactive<Record<string, string>>({})
const userQuery = ref('')
const users = ref<SlackUser[]>([])
const form = reactive({ workspaceId: '', userId: '', name: '', goal: '', opening: '' })

const statusClass = computed(() => {
  const w = status.value.workspaces[0]
  if (!w?.authenticated) return 'offline'
  return w.scopes?.ok ? 'online' : 'pending'
})
const statusText = computed(() => {
  const w = status.value.workspaces[0]
  if (!w?.authenticated) return 'Not connected'
  return w.scopes?.ok ? 'Connected' : 'Missing scopes'
})

async function run(label: string, fn: () => Promise<void>) {
  busy.value = true
  try { await fn() } catch (e: unknown) {
    const err = e as { data?: { error?: string }; message?: string }
    emit('error', `${label}: ${err?.data?.error || err?.message || 'failed'}`)
  } finally { busy.value = false }
}

async function load() {
  loading.value = true
  try {
    status.value = await api<SlackStatus>('/api/slack/status')
    if (!form.workspaceId && status.value.workspaces[0]) form.workspaceId = status.value.workspaces[0].id
  } catch (e: unknown) {
    emit('error', `Slack status: ${(e as { message?: string })?.message || 'failed'}`)
  } finally { loading.value = false }
}

function saveToken(workspaceId: string) {
  return run('Save token', async () => {
    const res = await api<{ botUserId: string; teamName: string; scopes: { ok: boolean; missing?: string } }>('/api/slack/token', { method: 'PUT', body: { workspaceId, token: tokenInput[workspaceId] } })
    tokenInput[workspaceId] = ''
    emit('info', res.scopes.ok ? `Token saved for ${res.teamName} — all scopes present` : `Token saved, still missing: ${res.scopes.missing}`)
    await load()
  })
}

function searchUsers() {
  return run('Search', async () => {
    const res = await api<{ users: SlackUser[] }>(`/api/slack/users?workspace=${encodeURIComponent(form.workspaceId)}&q=${encodeURIComponent(userQuery.value)}`)
    users.value = res.users
    if (!res.users.length) emit('info', 'No users found')
  })
}

function pickUser(u: SlackUser) {
  form.userId = u.id
  if (!form.name) form.name = u.realName || u.name
}

function startConversation() {
  return run('Start conversation', async () => {
    const res = await api<{ opening: { success: boolean; error?: string } | null }>('/api/slack/conversation', { method: 'POST', body: { ...form } })
    emit('info', res.opening ? (res.opening.success ? 'Conversation started and opening message sent' : `Directive saved, opening failed: ${res.opening.error}`) : 'Conversation directive saved')
    form.userId = ''; form.goal = ''; form.opening = ''; form.name = ''
    await load()
    emit('reload')
  })
}

function endConversation(directiveId: string) {
  return run('End conversation', async () => {
    await api('/api/slack/conversation', { method: 'DELETE', body: { directiveId } })
    await load()
  })
}

onMounted(load)
</script>

<style scoped>
.sl-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.sl-section-title { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
.sl-hint { color: var(--text-ghost); font-size: 12px; margin: 0 0 8px; line-height: 1.5; }
.sl-hint code { font-family: var(--mono); font-size: 11px; }
.sl-id { color: var(--text-ghost); font-family: var(--mono); font-size: 11px; }
.sl-warn { padding: 8px 10px; border-radius: 6px; background: rgba(251,191,36,0.1); color: var(--yellow); font-size: 12px; margin-bottom: 8px; }
.sl-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.sl-row .intg-input { flex: 1 1 200px; }
.sl-textarea { width: 100%; margin-bottom: 8px; font-family: inherit; }
.sl-users { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.sl-user { border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text); border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
.sl-user.active { border-color: var(--accent); color: var(--accent); }
.sl-conv { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.sl-goal { color: var(--text-muted); font-size: 12px; margin: 4px 0; white-space: pre-wrap; }
.sl-log { list-style: none; margin: 0; padding: 0; font-size: 12px; max-height: 260px; overflow-y: auto; }
.sl-log li { padding: 6px 0; border-bottom: 1px solid var(--border); }
.sl-time { color: var(--text-ghost); margin-right: 6px; }
.sl-who { color: var(--text-muted); }
.sl-reply { color: var(--green); margin-top: 2px; }
.sl-reply.err { color: var(--red); }
</style>
