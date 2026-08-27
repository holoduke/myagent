<template>
  <div class="section">
    <LayoutSectionHeader>Brain</LayoutSectionHeader>

    <UiLoadState :loading="!loaded" :error="error" @retry="load()" />

    <template v-if="loaded && !error">
      <!-- Stat row -->
      <div class="stat-grid" style="margin-bottom:20px">
        <UiStatCard :value="activeGoals.length" label="Active Goals" />
        <UiStatCard :value="recurringTasks.length" label="Recurring Tasks" />
        <UiStatCard :value="signals.length" label="Signals" />
        <UiStatCard :value="followUps.length" label="Follow-ups" />
      </div>

      <!-- Initiative Signals -->
      <UiCard title="Initiative Signals" :icon="icons.signal" style="margin-bottom:16px">
        <div v-if="signals.length === 0" class="brain-empty">No signals — all clear</div>
        <div v-for="(s, i) in signals" :key="i" class="brain-row">
          <span class="priority-dot" :class="priorityClass(s.priority)" />
          <UiTypeBadge :type="s.type.replace(/_/g, ' ')" />
          <span class="brain-row-text">{{ s.description }}</span>
          <span v-if="s.suggestedAction" class="brain-row-hint">{{ s.suggestedAction }}</span>
        </div>
      </UiCard>

      <!-- Goals -->
      <UiCard title="Goals" :icon="icons.goal" style="margin-bottom:16px">
        <div class="brain-toolbar">
          <div class="brain-tabs">
            <button v-for="tab in goalTabs" :key="tab.value" class="brain-tab" :class="{ active: goalFilter === tab.value }" @click="goalFilter = tab.value">
              {{ tab.label }}
            </button>
          </div>
          <button class="btn primary" @click="showGoalModal = true">+ New Goal</button>
        </div>
        <div v-if="filteredGoals.length === 0" class="brain-empty">No {{ goalFilter }} goals</div>
        <div v-for="g in filteredGoals" :key="g.nodeId" class="brain-goal">
          <div class="brain-goal-hdr">
            <span class="brain-goal-title">{{ g.data.title }}</span>
            <span class="type-badge" :class="'p' + g.data.priority">P{{ g.data.priority }}</span>
            <span v-if="g.data.deadline" class="brain-goal-deadline" :class="{ overdue: g.data.deadline < Date.now() }">
              {{ fmtDate(g.data.deadline) }}
            </span>
          </div>
          <div class="brain-goal-desc">{{ g.data.description }}</div>
          <div class="brain-progress-row">
            <div class="brain-progress-bar"><div class="brain-progress-fill" :style="{ width: g.data.progress + '%' }" /></div>
            <span class="brain-progress-pct">{{ g.data.progress }}%</span>
          </div>
          <div v-if="g.data.checkpoints.length" class="brain-checkpoints">
            <label v-for="(cp, ci) in g.data.checkpoints" :key="ci" class="brain-cp" :class="{ done: cp.done }">
              <input type="checkbox" :checked="cp.done" @change="toggleCheckpoint(g, ci)" />
              {{ cp.label }}
            </label>
          </div>
          <div v-if="g.data.status === 'active'" class="btn-row" style="margin-top:8px">
            <button class="btn" @click="completeGoal(g.nodeId)">Complete</button>
            <button class="btn danger" @click="abandonGoal(g.nodeId, g.data.title)">Abandon</button>
          </div>
        </div>
      </UiCard>

      <!-- Recurring Tasks -->
      <UiCard title="Recurring Tasks" :icon="icons.recurring" style="margin-bottom:16px">
        <div class="brain-toolbar">
          <span />
          <button class="btn primary" @click="showTaskModal = true">+ New Task</button>
        </div>
        <div v-if="recurringTasks.length === 0" class="brain-empty">No recurring tasks</div>
        <div v-for="t in recurringTasks" :key="t.id" class="brain-row">
          <button class="br-toggle" :class="{ on: t.enabled }" role="switch" :aria-checked="t.enabled" :aria-label="'Toggle task ' + t.label" @click="toggleTask(t)">
            <span class="br-toggle-knob" />
          </button>
          <span class="brain-row-text" :class="{ disabled: !t.enabled }">{{ t.label }}</span>
          <UiTypeBadge :type="t.type.replace(/_/g, ' ')" />
          <span class="brain-row-hint">{{ scheduleLabel(t) }}</span>
          <span v-if="t.lastRunAt" class="brain-row-meta">{{ timeAgo(t.lastRunAt) }}</span>
          <button class="btn danger btn-sm" @click="removeTask(t.id, t.label)">Del</button>
        </div>
      </UiCard>

      <!-- Pending Follow-ups -->
      <UiCard title="Pending Follow-ups" :icon="icons.followUp" style="margin-bottom:16px">
        <div v-if="followUps.length === 0" class="brain-empty">No pending follow-ups</div>
        <div v-for="f in followUps" :key="f.id" class="brain-row brain-row-stacked">
          <div class="brain-followup-main">
            <span class="brain-row-text">{{ f.question }}</span>
            <span v-if="f.targetPerson" class="type-badge person">{{ f.targetPerson }}</span>
          </div>
          <div class="brain-followup-meta">
            <span v-if="f.dueAt" class="brain-row-hint" :class="{ overdue: f.dueAt < Date.now() }">
              Due: {{ fmtDate(f.dueAt) }}
            </span>
            <span class="brain-row-meta">{{ f.context }}</span>
          </div>
        </div>
      </UiCard>
    </template>

    <!-- Create Goal Modal -->
    <UiModal :open="showGoalModal" title="New Goal" @close="showGoalModal = false">
      <div class="modal-field">
        <label class="intg-label">Title</label>
        <input v-model="goalForm.title" class="intg-input" placeholder="Goal title" />
      </div>
      <div class="modal-field">
        <label class="intg-label">Description</label>
        <textarea v-model="goalForm.description" class="intg-input intg-textarea" placeholder="What does this goal achieve?" />
      </div>
      <div class="modal-field-row">
        <div class="modal-field" style="flex:1">
          <label class="intg-label">Priority</label>
          <select v-model.number="goalForm.priority" class="intg-input">
            <option :value="1">P1 — High</option>
            <option :value="2">P2 — Medium</option>
            <option :value="3">P3 — Low</option>
          </select>
        </div>
        <div class="modal-field" style="flex:1">
          <label class="intg-label">Deadline (optional)</label>
          <input v-model="goalForm.deadlineStr" type="date" class="intg-input" />
        </div>
      </div>
      <div class="modal-field">
        <label class="intg-label">Checkpoints</label>
        <div v-for="(cp, i) in goalForm.checkpoints" :key="i" class="cp-row">
          <input v-model="goalForm.checkpoints[i]" class="intg-input" placeholder="Checkpoint label" />
          <button class="btn danger btn-sm" @click="goalForm.checkpoints.splice(i, 1)">&times;</button>
        </div>
        <button class="btn btn-sm" style="margin-top:6px" @click="goalForm.checkpoints.push('')">+ Checkpoint</button>
      </div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" :disabled="!goalForm.title || savingGoal" @click="createGoal">
          {{ savingGoal ? 'Creating...' : 'Create Goal' }}
        </button>
        <button class="btn" @click="showGoalModal = false">Cancel</button>
      </div>
    </UiModal>

    <!-- Create Recurring Task Modal -->
    <UiModal :open="showTaskModal" title="New Recurring Task" @close="showTaskModal = false">
      <div class="modal-field">
        <label class="intg-label">Label</label>
        <input v-model="taskForm.label" class="intg-input" placeholder="Task label" />
      </div>
      <div class="modal-field">
        <label class="intg-label">Type</label>
        <select v-model="taskForm.type" class="intg-input">
          <option value="digest">Digest</option>
          <option value="think_trigger">Think Trigger</option>
          <option value="message">Message</option>
        </select>
      </div>
      <div class="modal-field">
        <label class="intg-label">Hours (select when to run)</label>
        <div class="hour-grid">
          <button v-for="h in 24" :key="h - 1" class="hour-btn" :class="{ selected: taskForm.hours.includes(h - 1) }" @click="toggleHour(h - 1)">
            {{ h - 1 }}
          </button>
        </div>
      </div>
      <div class="modal-field">
        <label class="intg-label">Days (leave empty for every day)</label>
        <div class="day-row">
          <label v-for="(d, i) in dayLabels" :key="i" class="day-check">
            <input type="checkbox" :checked="taskForm.days.includes(i)" @change="toggleDay(i)" />
            {{ d }}
          </label>
        </div>
      </div>
      <template v-if="taskForm.type === 'think_trigger'">
        <div class="modal-field">
          <label class="intg-label">Topic</label>
          <input v-model="taskForm.topic" class="intg-input" placeholder="What should ARIA think about?" />
        </div>
      </template>
      <template v-if="taskForm.type === 'digest' || taskForm.type === 'message'">
        <div class="modal-field">
          <label class="intg-label">Target JID</label>
          <input v-model="taskForm.targetJid" class="intg-input" placeholder="e.g. 31612345678@s.whatsapp.net" />
        </div>
      </template>
      <template v-if="taskForm.type === 'message'">
        <div class="modal-field">
          <label class="intg-label">Message Template</label>
          <textarea v-model="taskForm.template" class="intg-input intg-textarea" placeholder="Message template" />
        </div>
      </template>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" :disabled="!taskForm.label || taskForm.hours.length === 0 || savingTask" @click="createTask">
          {{ savingTask ? 'Creating...' : 'Create Task' }}
        </button>
        <button class="btn" @click="showTaskModal = false">Cancel</button>
      </div>
    </UiModal>
  </div>
</template>

<script setup lang="ts">
import type { BrainDashboardData, Goal, RecurringTask, InitiativeSignal, PendingFollowUp } from '~/types/aria'

const { api } = useApi()
const { showToast } = useToast()
const { timeAgo, fmtDate } = useTimeAgo()

const loaded = ref(false)
const error = ref('')
const goals = ref<Goal[]>([])
const recurringTasks = ref<RecurringTask[]>([])
const signals = ref<InitiativeSignal[]>([])
const followUps = ref<PendingFollowUp[]>([])

const goalFilter = ref<string>('active')
const showGoalModal = ref(false)
const showTaskModal = ref(false)
const savingGoal = ref(false)
const savingTask = ref(false)

const goalTabs = [
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
  { label: 'Abandoned', value: 'abandoned' },
]

const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const goalForm = reactive({
  title: '',
  description: '',
  priority: 2 as 1 | 2 | 3,
  deadlineStr: '',
  checkpoints: [] as string[],
})

const taskForm = reactive({
  label: '',
  type: 'digest' as 'message' | 'think_trigger' | 'digest',
  hours: [] as number[],
  days: [] as number[],
  topic: '',
  targetJid: '',
  template: '',
})

const icons = {
  signal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>',
  goal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  recurring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>',
  followUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
}

const activeGoals = computed(() => goals.value.filter(g => g.data.status === 'active'))
const filteredGoals = computed(() => goals.value.filter(g => g.data.status === goalFilter.value))

function priorityClass(p: number) {
  if (p >= 0.7) return 'high'
  if (p >= 0.4) return 'medium'
  return 'low'
}

function scheduleLabel(t: RecurringTask): string {
  const hours = t.pattern.hours.map(h => `${h}:00`).join(', ')
  if (t.pattern.daysOfWeek?.length) {
    const days = t.pattern.daysOfWeek.map(d => dayLabels[d]).join(', ')
    return `${days} @ ${hours}`
  }
  return `Daily @ ${hours}`
}

async function load() {
  try {
    const data = await api<BrainDashboardData>('/api/brain/dashboard')
    goals.value = data.goals
    recurringTasks.value = data.recurringTasks
    signals.value = data.signals
    followUps.value = data.followUps
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

async function createGoal() {
  savingGoal.value = true
  try {
    await api('/api/brain/goals', {
      method: 'POST',
      body: {
        title: goalForm.title,
        description: goalForm.description,
        priority: goalForm.priority,
        deadline: goalForm.deadlineStr ? new Date(goalForm.deadlineStr).getTime() : undefined,
        checkpoints: goalForm.checkpoints.filter(c => c.trim()),
      },
    })
    showGoalModal.value = false
    goalForm.title = ''
    goalForm.description = ''
    goalForm.priority = 2
    goalForm.deadlineStr = ''
    goalForm.checkpoints = []
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to create goal', 'error')
  } finally {
    savingGoal.value = false
  }
}

async function completeGoal(nodeId: string) {
  try {
    await api(`/api/brain/goals/${nodeId}/complete`, { method: 'POST' })
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to complete goal', 'error')
  }
}

async function abandonGoal(nodeId: string, title: string) {
  if (!confirm(`Abandon goal "${title}"?`)) return
  try {
    await api(`/api/brain/goals/${nodeId}/abandon`, { method: 'POST' })
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to abandon goal', 'error')
  }
}

async function toggleCheckpoint(g: Goal, idx: number) {
  const checkpoints = g.data.checkpoints.map((cp, i) => ({
    label: cp.label,
    done: i === idx ? !cp.done : cp.done,
  }))
  const doneCount = checkpoints.filter(c => c.done).length
  const progress = checkpoints.length > 0 ? Math.round((doneCount / checkpoints.length) * 100) : g.data.progress
  try {
    await api(`/api/brain/goals/${g.nodeId}`, {
      method: 'PUT',
      body: { checkpoints, progress },
    })
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to update goal', 'error')
  }
}

async function toggleTask(t: RecurringTask) {
  try {
    await api(`/api/brain/recurring/${t.id}`, {
      method: 'PUT',
      body: { enabled: !t.enabled },
    })
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to update task', 'error')
  }
}

async function removeTask(id: string, label: string) {
  if (!confirm(`Delete recurring task "${label}"?`)) return
  try {
    await api(`/api/brain/recurring/${id}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to delete task', 'error')
  }
}

function toggleHour(h: number) {
  const idx = taskForm.hours.indexOf(h)
  if (idx === -1) taskForm.hours.push(h)
  else taskForm.hours.splice(idx, 1)
  taskForm.hours.sort((a, b) => a - b)
}

function toggleDay(d: number) {
  const idx = taskForm.days.indexOf(d)
  if (idx === -1) taskForm.days.push(d)
  else taskForm.days.splice(idx, 1)
  taskForm.days.sort((a, b) => a - b)
}

async function createTask() {
  savingTask.value = true
  try {
    const action: Record<string, string> = { type: taskForm.type }
    if (taskForm.type === 'think_trigger') {
      action.topic = taskForm.topic
    } else if (taskForm.type === 'digest') {
      action.targetJid = taskForm.targetJid
    } else if (taskForm.type === 'message') {
      action.targetJid = taskForm.targetJid
      action.template = taskForm.template
    }

    await api('/api/brain/recurring', {
      method: 'POST',
      body: {
        label: taskForm.label,
        type: taskForm.type,
        pattern: {
          hours: taskForm.hours,
          ...(taskForm.days.length ? { daysOfWeek: taskForm.days } : {}),
        },
        action,
        enabled: true,
        source: 'owner',
      },
    })
    showTaskModal.value = false
    taskForm.label = ''
    taskForm.type = 'digest'
    taskForm.hours = []
    taskForm.days = []
    taskForm.topic = ''
    taskForm.targetJid = ''
    taskForm.template = ''
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to create task', 'error')
  } finally {
    savingTask.value = false
  }
}

useVisibilityRefresh(load)
onMounted(load)
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

/* ── Brain rows ── */
.brain-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  font-size: 14px;
  flex-wrap: wrap;
}
.brain-row:last-child { border-bottom: none; }
.brain-row-stacked { flex-direction: column; align-items: flex-start; gap: 4px; }
.brain-row-text { color: var(--text-dim); flex: 1; min-width: 0; }
.brain-row-text.disabled { opacity: 0.4; }
.brain-row-hint { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }
.brain-row-hint.overdue { color: var(--red); }
.brain-row-meta { font-size: 11px; color: var(--text-ghost); font-family: var(--mono); }
.brain-empty { color: var(--text-ghost); font-size: 14px; padding: 20px 0; text-align: center; }

/* ── Priority dots ── */
.priority-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.priority-dot.high { background: var(--red); box-shadow: 0 0 6px rgba(239,68,68,0.4); }
.priority-dot.medium { background: var(--yellow); box-shadow: 0 0 6px rgba(234,179,8,0.4); }
.priority-dot.low { background: var(--green); box-shadow: 0 0 6px rgba(34,197,94,0.4); }

/* ── Toolbar & tabs ── */
.brain-toolbar {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 8px; flex-wrap: wrap;
}
.brain-tabs { display: flex; gap: 4px; }
.brain-tab {
  padding: 5px 14px; border-radius: 6px; font-size: 12px; font-family: var(--mono);
  cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text-muted); transition: all .15s;
}
.brain-tab.active { border-color: var(--accent); color: var(--accent); background: rgba(139,92,246,0.08); }
.brain-tab:hover { color: var(--text); }

/* ── Goals ── */
.brain-goal {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 8px;
}
.brain-goal-hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.brain-goal-title { font-weight: 600; color: var(--text); font-size: 15px; flex: 1; }
.brain-goal-deadline { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }
.brain-goal-deadline.overdue { color: var(--red); }
.brain-goal-desc { font-size: 13px; color: var(--text-dim); margin-bottom: 8px; line-height: 1.5; }

.type-badge.p1 { background: #2e0e1e; color: #d46090; border: 1px solid #401a2a; }
.type-badge.p2 { background: #2e2a0e; color: #d4c860; border: 1px solid #40381a; }
.type-badge.p3 { background: #0e2e1a; color: #5cd4a4; border: 1px solid #1a4030; }

/* ── Progress bar ── */
.brain-progress-row { display: flex; align-items: center; gap: 10px; }
.brain-progress-bar {
  flex: 1; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden;
}
.brain-progress-fill {
  height: 100%; border-radius: 3px; transition: width .3s;
  background: linear-gradient(90deg, var(--accent), var(--cyan));
}
.brain-progress-pct { font-size: 12px; color: var(--text-muted); font-family: var(--mono); min-width: 36px; text-align: right; }

/* ── Checkpoints ── */
.brain-checkpoints { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.brain-cp {
  display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); cursor: pointer;
}
.brain-cp.done { color: var(--text-ghost); text-decoration: line-through; }
.brain-cp input[type="checkbox"] {
  accent-color: var(--accent); width: 14px; height: 14px; cursor: pointer;
}

/* ── Follow-ups ── */
.brain-followup-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.brain-followup-meta { display: flex; gap: 12px; flex-wrap: wrap; }

/* ── Toggle (reused from settings) ── */
.br-toggle {
  width: 36px; height: 20px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg); cursor: pointer; position: relative; transition: all .2s; padding: 0; flex-shrink: 0;
}
.br-toggle.on { background: rgba(139,92,246,0.2); border-color: var(--accent); }
.br-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--text-muted); transition: all .2s;
}
.br-toggle.on .br-toggle-knob { left: 18px; background: var(--accent); }

/* ── Small button variant ── */
.btn-sm { padding: 4px 10px; font-size: 11px; }

/* ── Modal fields ── */
.modal-field { margin-bottom: 12px; }
.modal-field-row { display: flex; gap: 12px; }
.intg-textarea { min-height: 60px; resize: vertical; display: block; width: 100%; box-sizing: border-box; }

/* ── Hour grid ── */
.hour-grid { display: flex; flex-wrap: wrap; gap: 4px; }
.hour-btn {
  width: 36px; height: 28px; border-radius: 6px; font-size: 12px; font-family: var(--mono);
  cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text-muted); transition: all .15s;
}
.hour-btn.selected { border-color: var(--accent); color: var(--accent); background: rgba(139,92,246,0.12); }
.hour-btn:hover { color: var(--text); }

/* ── Day checkboxes ── */
.day-row { display: flex; gap: 12px; flex-wrap: wrap; }
.day-check {
  display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-dim); cursor: pointer; font-family: var(--mono);
}
.day-check input { accent-color: var(--accent); }

/* ── Checkpoint editor ── */
.cp-row { display: flex; gap: 6px; margin-bottom: 4px; }
.cp-row .intg-input { flex: 1; }

@media (max-width: 768px) {
  .modal-field-row { flex-direction: column; gap: 0; }
  .brain-toolbar { flex-direction: column; align-items: stretch; }
}
</style>
