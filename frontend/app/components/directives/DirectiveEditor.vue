<template>
  <div class="dir-editor">
    <div class="dir-editor-header">
      <span class="dir-editor-title">{{ isNew ? 'Add Directive' : 'Edit Directive' }}</span>
      <button v-if="!isNew" class="dir-delete-btn" @click="$emit('delete', form.id)">Delete</button>
    </div>

    <div class="dir-fields">
      <div class="dir-field">
        <label class="intg-label">Contact</label>
        <select v-model="form.contactJid" class="intg-input" :disabled="!isNew" @change="onContactChange">
          <option value="" disabled>Select contact...</option>
          <option v-for="c in contacts" :key="c.jid" :value="c.jid">{{ c.name }} ({{ c.jid.split('@')[0] }})</option>
        </select>
      </div>

      <div class="dir-field">
        <label class="intg-label">Action Type</label>
        <select v-model="form.actionType" class="intg-input">
          <option v-for="at in actionTypes" :key="at" :value="at">{{ at.replace('_', ' ') }}</option>
        </select>
      </div>

      <div class="dir-field">
        <label class="intg-label">Policy</label>
        <div class="dir-policy-toggle">
          <button
            class="dir-policy-btn"
            :class="{ active: form.policy === 'auto-execute' }"
            @click="form.policy = 'auto-execute'"
          >Auto-execute</button>
          <button
            class="dir-policy-btn"
            :class="{ active: form.policy === 'require-confirmation' }"
            @click="form.policy = 'require-confirmation'"
          >Require confirmation</button>
        </div>
      </div>

      <div class="dir-field" style="grid-column: 1 / -1">
        <label class="intg-label">Note (optional)</label>
        <input v-model="form.note" class="intg-input" placeholder="Why this directive exists..." />
      </div>

      <div v-if="!isNew" class="dir-field">
        <label class="intg-label">Enabled</label>
        <button class="br-toggle" :class="{ on: form.enabled }" @click="form.enabled = !form.enabled">
          <span class="br-toggle-knob" />
        </button>
      </div>
    </div>

    <div class="dir-footer">
      <button class="btn" @click="$emit('cancel')">Cancel</button>
      <button class="btn primary" :disabled="!canSave || saving" @click="handleSave">
        {{ saving ? 'Saving...' : isNew ? 'Add' : 'Save' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Directive, DirectiveActionType, DirectivePolicy, WhitelistContact } from '~/types/aria'

const props = defineProps<{
  directive?: Directive
  contacts: WhitelistContact[]
  saving?: boolean
}>()

const emit = defineEmits<{
  save: [data: { contactJid: string; contactName: string; actionType: DirectiveActionType; policy: DirectivePolicy; enabled: boolean; note?: string; id?: string }]
  cancel: []
  delete: [id: string]
}>()

const isNew = computed(() => !props.directive)

const actionTypes: DirectiveActionType[] = [
  'calendar', 'reminder', 'shopping', 'task',
  'logistics', 'message_relay', 'information',
]

const form = reactive({
  id: props.directive?.id || '',
  contactJid: props.directive?.contactJid || '',
  contactName: props.directive?.contactName || '',
  actionType: (props.directive?.actionType || 'calendar') as DirectiveActionType,
  policy: (props.directive?.policy || 'require-confirmation') as DirectivePolicy,
  enabled: props.directive?.enabled ?? true,
  note: props.directive?.note || '',
})

const canSave = computed(() => form.contactJid && form.actionType && form.policy)

function onContactChange() {
  const c = props.contacts.find(c => c.jid === form.contactJid)
  if (c) form.contactName = c.name
}

function handleSave() {
  emit('save', {
    ...(form.id ? { id: form.id } : {}),
    contactJid: form.contactJid,
    contactName: form.contactName,
    actionType: form.actionType,
    policy: form.policy,
    enabled: form.enabled,
    note: form.note || undefined,
  })
}
</script>

<style scoped>
.dir-editor {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 12px;
}
.dir-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.dir-editor-title {
  font-size: 13px;
  font-family: var(--mono);
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.dir-delete-btn {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--red);
  background: none;
  border: 1px solid var(--red);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity .15s;
}
.dir-delete-btn:hover { opacity: 1; }

.dir-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.dir-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dir-policy-toggle {
  display: flex;
  gap: 4px;
}
.dir-policy-btn {
  flex: 1;
  font-size: 11px;
  font-family: var(--mono);
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  color: var(--text-muted);
  cursor: pointer;
  transition: all .15s;
}
.dir-policy-btn:hover { border-color: var(--border-glow); }
.dir-policy-btn.active {
  border-color: var(--accent);
  background: rgba(139,92,246,0.06);
  color: var(--accent);
}

.dir-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

/* Toggle (reuse pattern from settings) */
.br-toggle {
  width: 44px;
  height: 24px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  position: relative;
  transition: all .2s;
  padding: 0;
}
.br-toggle.on {
  background: rgba(139,92,246,0.2);
  border-color: var(--accent);
}
.br-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: all .2s;
}
.br-toggle.on .br-toggle-knob {
  left: 23px;
  background: var(--accent);
}

@media (max-width: 768px) {
  .dir-fields { grid-template-columns: 1fr; }
}
</style>
