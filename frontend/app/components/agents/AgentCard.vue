<template>
  <div class="agent-form">
    <!-- Provider-specific config fields -->
    <template v-if="provider === 'claude'">
      <div class="field">
        <label>Allowed Tools</label>
        <input v-model="localConfig.allowedTools" type="text" placeholder="Bash,Read,Write,Edit,..." />
      </div>
      <div class="field">
        <label>Timeout (ms)</label>
        <input v-model.number="localConfig.timeout" type="number" placeholder="300000" />
      </div>
    </template>

    <template v-if="provider === 'codex'">
      <div class="field">
        <label>Model</label>
        <select v-model="localConfig.model">
          <option value="o3">o3 (default)</option>
          <option value="o4-mini">o4-mini</option>
          <option value="codex-mini">codex-mini</option>
        </select>
      </div>
      <div class="field">
        <label>Sandbox</label>
        <select v-model="localConfig.sandbox">
          <option value="workspace-write">workspace-write (default)</option>
          <option value="read-only">read-only</option>
          <option value="danger-full-access">danger-full-access</option>
        </select>
      </div>
      <div class="field">
        <label>Full Auto</label>
        <select v-model="localConfig.fullAuto">
          <option :value="true">Yes (default)</option>
          <option :value="false">No</option>
        </select>
      </div>
      <div class="field">
        <label>Timeout (ms)</label>
        <input v-model.number="localConfig.timeout" type="number" placeholder="300000" />
      </div>
    </template>

    <template v-if="provider === 'grok'">
      <div class="field">
        <label>Model</label>
        <select v-model="localConfig.model">
          <option value="grok-4-latest">grok-4-latest (default)</option>
          <option value="grok-3">grok-3</option>
        </select>
      </div>
      <div class="field">
        <label>API Key <span class="req">*</span></label>
        <input v-model="localConfig.apiKey" type="password" placeholder="xai-..." />
      </div>
      <div class="field">
        <label>Max Tool Rounds</label>
        <input v-model.number="localConfig.maxToolRounds" type="number" placeholder="10" />
      </div>
      <div class="field">
        <label>Timeout (ms)</label>
        <input v-model.number="localConfig.timeout" type="number" placeholder="300000" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  provider: 'claude' | 'codex' | 'grok'
  config: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'update', config: Record<string, unknown>): void
}>()

const localConfig = reactive<Record<string, unknown>>({ ...props.config })

watch(localConfig, () => {
  // Clean empty string values
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(localConfig)) {
    if (v !== '' && v !== undefined && v !== null) {
      cleaned[k] = v
    }
  }
  emit('update', cleaned)
}, { deep: true })

watch(() => props.config, (c) => {
  Object.assign(localConfig, c)
}, { deep: true })
</script>

<style scoped>
.agent-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.field .req {
  color: var(--red);
}
.field input,
.field select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  transition: border-color .15s;
}
.field input:focus,
.field select:focus {
  border-color: var(--accent);
}
.field input::placeholder {
  color: var(--text-ghost);
}
.field select {
  cursor: pointer;
}
</style>
