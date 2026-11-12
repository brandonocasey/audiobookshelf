<template>
  <modals-modal v-model="show" name="organizePreview" :processing="processing" :width="800" :height="'unset'">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-3xl text-white truncate">{{ $strings.HeaderOrganizeFiles }}</p>
      </div>
    </template>

    <div class="w-full rounded-lg bg-bg box-shadow-md overflow-hidden" style="max-height: 80vh">
      <div v-if="show" class="w-full h-full py-4 flex flex-col" style="max-height: 80vh">
        <p v-if="loadFailed" class="px-8 py-2 text-error">{{ $strings.ToastOrganizePreviewFailed }}</p>
        <template v-else-if="!processing">
          <p class="text-sm px-8 pb-2 text-gray-300">{{ $strings.MessageOrganizePreviewDescription }}</p>
          <p v-if="!plans.length" class="px-8 py-4">{{ $getString('MessageOrganizeNothingToDo', [unchangedCount]) }}</p>
          <p v-else-if="unchangedCount" class="px-8 pb-2 text-sm text-gray-300">{{ $getString('MessageOrganizeUnchangedCount', [unchangedCount]) }}</p>

          <div class="overflow-y-auto px-8 grow">
            <div v-for="plan in plans" :key="plan.itemId" class="py-2 border-b border-white/10" :class="plan.skipReason ? 'text-gray-400' : ''">
              <p class="font-semibold truncate">{{ plan.title }}</p>
              <p class="text-sm break-all">{{ plan.fromRelPath }} <span class="material-symbols text-sm align-middle">arrow_right_alt</span> {{ plan.toRelPath }}</p>
              <p v-for="rename in plan.fileRenames" :key="rename.from" class="text-xs text-gray-300 break-all pl-4">{{ rename.from }} <span class="material-symbols text-xs align-middle">arrow_right_alt</span> {{ rename.to }}</p>
              <p v-if="plan.skipReason" class="text-sm text-warning">{{ skipReasonText(plan.skipReason) }}</p>
              <p v-for="warning in plan.warnings" :key="warning.field" class="text-sm text-warning">{{ warningText(warning) }}</p>
            </div>
          </div>

          <div class="flex items-center px-4 pt-4 mt-2 border-t border-white/5">
            <ui-btn type="button" @click="show = false">{{ $strings.ButtonCancel }}</ui-btn>
            <div class="grow" />
            <ui-btn color="bg-success" :disabled="!organizablePlans.length" @click="confirm">{{ $strings.ButtonOrganizeFiles }}</ui-btn>
          </div>
        </template>
      </div>
    </div>
  </modals-modal>
</template>

<script>
const WARNING_FIELD_STRING_KEYS = {
  title: 'LabelTitle',
  subtitle: 'LabelSubtitle',
  authors: 'LabelAuthors',
  series: 'LabelSeries',
  sequence: 'LabelSequence',
  publishedYear: 'LabelOrganizeFieldPublishedYear',
  asin: 'LabelOrganizeFieldAsin',
  narrators: 'LabelNarrators'
}

export default {
  data() {
    return {
      processing: false,
      loadFailed: false,
      plans: [],
      unchangedCount: 0
    }
  },
  watch: {
    request(newVal) {
      if (newVal) this.loadPreview()
    }
  },
  computed: {
    request() {
      return this.$store.state.globals.organizePreviewRequest
    },
    show: {
      get() {
        return !!this.request
      },
      set(val) {
        if (!val) this.$store.commit('globals/setOrganizePreviewRequest', null)
      }
    },
    organizablePlans() {
      return this.plans.filter((plan) => plan.changed && !plan.skipReason)
    }
  },
  methods: {
    skipReasonText(skipReason) {
      const key = `MessageOrganizeSkip${skipReason.charAt(0).toUpperCase()}${skipReason.slice(1)}`
      return this.$strings[key] || skipReason
    },
    warningText(warning) {
      const fieldString = this.$strings[WARNING_FIELD_STRING_KEYS[warning.field]] || warning.field
      return this.$getString('MessageOrganizeWarning', [fieldString, warning.parsed, warning.expected])
    },
    loadPreview() {
      this.processing = true
      this.loadFailed = false
      this.plans = []
      this.unchangedCount = 0
      this.$axios
        .$post('/api/tools/organize/preview', this.getRequestPayload())
        .then((data) => {
          this.plans = data.plans
          this.unchangedCount = data.unchangedCount
        })
        .catch((error) => {
          console.error('Failed to preview organize files', error)
          this.loadFailed = true
          this.$toast.error(error.response?.data || this.$strings.ToastOrganizePreviewFailed)
        })
        .finally(() => {
          this.processing = false
        })
    },
    getRequestPayload() {
      const { libraryId, libraryItemIds } = this.request
      return libraryId ? { libraryId } : { libraryItemIds }
    },
    confirm() {
      if (this.processing || !this.organizablePlans.length) return

      const planHashes = {}
      this.organizablePlans.forEach((plan) => (planHashes[plan.itemId] = plan.hash))
      const { clearSelection } = this.request

      this.processing = true
      this.$axios
        .$post('/api/tools/organize', { ...this.getRequestPayload(), planHashes })
        .then((data) => {
          this.$toast.info(this.$getString('ToastOrganizeStarted', [data.itemCount]))
          if (clearSelection) {
            this.$store.commit('globals/resetSelectedMediaItems', [])
            this.$eventBus.$emit('bookshelf_clear_selection')
          }
          this.show = false
        })
        .catch((error) => {
          console.error('Failed to organize files', error)
          this.$toast.error(error.response?.data || this.$strings.ToastOrganizeFailed)
        })
        .finally(() => {
          this.processing = false
        })
    }
  }
}
</script>
