<template>
  <div class="w-full" @focusin="templateFocused">
    <div ref="folderField" data-template="folder">
      <ui-text-input-with-label :value="folderTemplate" :label="$strings.LabelOrganizeFolderTemplate" class="mb-1" @input="templateInput('folder', $event)" />
    </div>
    <p class="text-xs text-gray-300">{{ $strings.LabelOrganizeFolderTemplateHelp }}</p>
    <p v-if="example.folderError" class="text-xs text-error pt-1">{{ example.folderError }}</p>

    <div ref="fileField" data-template="file" class="pt-3">
      <ui-text-input-with-label :value="fileTemplate" :label="$strings.LabelOrganizeFileTemplate" class="mb-1" @input="templateInput('file', $event)" />
    </div>
    <p class="text-xs text-gray-300">{{ $strings.LabelOrganizeFileTemplateHelp }}</p>
    <p v-if="example.fileError" class="text-xs text-error pt-1">{{ example.fileError }}</p>

    <div class="mt-3 rounded-md border border-white/10 bg-primary/40">
      <button type="button" class="w-full flex items-center justify-between px-3 py-2 text-left" :aria-expanded="String(showTokens)" @click="showTokens = !showTokens">
        <span class="text-sm font-semibold">{{ $strings.LabelOrganizeAvailableTokens }}</span>
        <span class="material-symbols text-lg text-gray-300" aria-hidden="true">{{ showTokens ? 'expand_less' : 'expand_more' }}</span>
      </button>
      <div v-if="showTokens" class="px-3 pb-3">
        <p class="text-xs text-gray-300 pb-2">{{ $getString('LabelOrganizeTokensHelp', [targetLabel]) }}</p>
        <div class="grid grid-cols-2 lg:grid-cols-3 gap-1 max-h-60 overflow-y-auto pr-1">
          <button
            v-for="token in example.tokens"
            :key="token.name"
            type="button"
            class="flex flex-col items-start min-w-0 rounded-sm border border-white/10 bg-bg px-2 py-1.5 text-left hover:border-yellow-400/60 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="token.fileOnly && target === 'folder'"
            :title="token.fileOnly ? $strings.LabelOrganizeFileOnly : ''"
            @mousedown.prevent
            @click="insertToken(token.name)"
          >
            <span class="font-mono text-xs text-gray-100">
              {{ tokenText(token.name) }}
              <span v-if="token.fileOnly" class="ml-1 rounded-sm bg-white/10 px-1 text-[10px] text-gray-300">{{ $strings.LabelOrganizeFileOnlyBadge }}</span>
            </span>
            <span class="text-xs text-gray-400 truncate max-w-full">{{ token.example || '—' }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="example.samples.length" class="mt-3">
      <p class="text-sm font-semibold pb-1">{{ $strings.LabelOrganizePreview }}</p>
      <div v-for="sample in example.samples" :key="sample.id" class="mb-2 rounded-md border border-white/10 bg-primary/40 px-3 py-2">
        <p class="text-xs text-gray-400 pb-1">{{ sampleLabel(sample.id) }}</p>
        <p class="flex items-start font-mono text-xs break-all">
          <span class="material-symbols text-sm text-yellow-400 pr-1" aria-hidden="true">folder</span>
          <span>{{ sample.folder || '—' }}</span>
        </p>
        <p v-for="(file, index) in sample.files" :key="index" class="flex items-start font-mono text-xs text-gray-300 break-all pl-5">
          <span class="material-symbols text-sm text-gray-400 pr-1" aria-hidden="true">{{ file.isEbook ? 'menu_book' : 'audio_file' }}</span>
          <span>{{ file.name }}</span>
        </p>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    folderTemplate: String,
    fileTemplate: String
  },
  data() {
    return {
      target: 'folder',
      showTokens: true,
      example: { folderError: null, fileError: null, tokens: [], samples: [] },
      exampleTimeout: null,
      exampleRequest: null
    }
  },
  watch: {
    folderTemplate: 'queueExample',
    fileTemplate: 'queueExample'
  },
  computed: {
    targetLabel() {
      return this.target === 'folder' ? this.$strings.LabelOrganizeFolderTemplate : this.$strings.LabelOrganizeFileTemplate
    }
  },
  methods: {
    tokenText(name) {
      return `{${name}}`
    },
    sampleLabel(id) {
      return id === 'series' ? this.$strings.LabelOrganizeSampleSeries : this.$strings.LabelOrganizeSampleStandalone
    },
    templateFocused(event) {
      const field = event.target.closest('[data-template]')
      if (field) this.target = field.dataset.template
    },
    templateInput(target, value) {
      this.$emit(target === 'folder' ? 'update:folderTemplate' : 'update:fileTemplate', value)
      this.$emit('change')
    },
    queueExample() {
      clearTimeout(this.exampleTimeout)
      this.exampleTimeout = setTimeout(this.loadExample, 300)
    },
    insertToken(name) {
      const field = this.target === 'folder' ? this.$refs.folderField : this.$refs.fileField
      const input = field.querySelector('input')
      const value = (this.target === 'folder' ? this.folderTemplate : this.fileTemplate) || ''
      const start = input.selectionStart ?? value.length
      const end = input.selectionEnd ?? value.length
      const token = this.tokenText(name)
      this.templateInput(this.target, value.slice(0, start) + token + value.slice(end))
      this.$nextTick(() => {
        input.focus()
        input.setSelectionRange(start + token.length, start + token.length)
      })
    },
    loadExample() {
      const request = { organizeFolderTemplate: this.folderTemplate, organizeFileTemplate: this.fileTemplate }
      this.exampleRequest = request
      return this.$axios
        .$post('/api/tools/organize/example', request)
        .then((example) => {
          // A newer edit made this answer stale
          if (request === this.exampleRequest) this.example = example
        })
        .catch((error) => {
          console.error('Failed to load organize template example', error)
        })
    }
  },
  mounted() {
    this.showTokens = window.innerWidth >= 768
    this.queueExample()
  },
  beforeDestroy() {
    clearTimeout(this.exampleTimeout)
  }
}
</script>
