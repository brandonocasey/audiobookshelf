const Path = require('path')
const crypto = require('crypto')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const Watcher = require('../Watcher')
const SocketAuthority = require('../SocketAuthority')
const TaskManager = require('./TaskManager')
const LibraryScanner = require('../scanner/LibraryScanner')
const LibraryItemScanner = require('../scanner/LibraryItemScanner')
const { ScanResult } = require('../utils/constants')
const { filePathToPOSIX, getPathsBelowLibraryFolder, getPathIdentity, isSameFile, isPathTakenByOther, removeTreeWithReadOnlyFolders } = require('../utils/fileUtils')
const { buildPlan, isPlanInsideAnotherItem, getMovedPath, getRenderedTargetKey, planToClientJSON } = require('../utils/organizePlan')
const { captureMediaChoices, restoreMediaChoices } = require('../utils/organizeMediaChoices')
const { TEMPLATE_SETTING_KEYS } = require('../utils/organizeTemplate')

const PREVIEW_CHUNK_SIZE = 50
const MAX_REPORTED_RESULTS = 100

/**
 * @typedef OrganizeStep
 * @property {string} from
 * @property {string} to
 * @property {'pending'|'copying'|'copied'|'done'} state Moves across file systems pass copying and copied before done
 * @property {string|null} tempPath Temp copy next to the destination, set for moves across file systems
 *
 * @typedef OrganizeResult
 * @property {string} itemId
 * @property {'moved'|'unchanged'|'skipped'|'failed'} status
 * @property {string} [reason] Skip reason code
 * @property {string} [error] Message of the error that made the item fail
 *
 * @typedef OrganizeJournal
 * @property {string} libraryItemId
 * @property {string} libraryFolderId
 * @property {string} libraryFolderPath
 * @property {boolean} isFile
 * @property {string} fromPath
 * @property {string} fromRelPath
 * @property {string} toPath
 * @property {string} toRelPath
 * @property {import('../utils/organizeMediaChoices').MediaChoices} mediaChoices Book settings from before the moves, restored after each rescan
 * @property {OrganizeStep[]} steps
 * @property {string[]} createdDirectories Folders this run creates, deepest first, removed again on rollback
 * @property {boolean} scanStarted Set before the rescan. Once set, a crashed run is finished instead of rolled back
 */

/**
 * Moves book folders and renames their files to match the library's organize templates.
 * Every move and rename on disk done for organizing goes through this manager.
 */
class OrganizeManager {
  /**
   * @param {import('./PlaybackSessionManager')} playbackSessionManager
   * @param {import('./AudioMetadataManager')} audioMetadataManager
   * @param {import('./AbMergeManager')} abMergeManager
   */
  constructor(playbackSessionManager, audioMetadataManager, abMergeManager) {
    this.playbackSessionManager = playbackSessionManager
    this.audioMetadataManager = audioMetadataManager
    this.abMergeManager = abMergeManager
    /** @type {Set<string>} */
    this.itemIdsInProgress = new Set()
    /** Organizing runs one item at a time so two runs cannot both pass the target check and move onto the same path */
    this.executionQueue = Promise.resolve()
    /** @type {Map<string, Promise<Set<string>>>} Item paths per library, kept while a preview or run is active */
    this.itemPathsByLibraryId = new Map()
    this.activeRunCount = 0
  }

  get journalDirectory() {
    return Path.join(global.MetadataPath, 'organize')
  }

  /**
   * @param {string} libraryItemId
   * @returns {string}
   */
  getJournalPath(libraryItemId) {
    return Path.join(this.journalDirectory, `${libraryItemId}.json`)
  }

  /**
   * Reason the item cannot be touched right now, or null
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {string|null}
   */
  getBusyReason(libraryItem) {
    if (LibraryScanner.isLibraryFileScanning(libraryItem.libraryId)) return 'libraryScanning'
    if (this.playbackSessionManager.sessions.some((session) => session.libraryItemId === libraryItem.id)) return 'streaming'
    // Embedding metadata and merging to m4b write temp files beside the audio and copy the result back to the old path
    if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(libraryItem.id) || this.abMergeManager.getPendingTaskByLibraryItemId(libraryItem.id)) return 'toolRunning'
    return null
  }

  /**
   * Run a preview or a run with the item paths of each library loaded once and kept current
   *
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  async withSharedItemPaths(run) {
    this.activeRunCount++
    try {
      return await run()
    } finally {
      this.activeRunCount--
      if (this.activeRunCount === 0) this.itemPathsByLibraryId.clear()
    }
  }

  /**
   * @param {string} libraryId
   * @returns {Promise<Set<string>|null>} Null outside of a preview or run
   */
  async getItemPaths(libraryId) {
    if (this.activeRunCount === 0) return null
    if (!this.itemPathsByLibraryId.has(libraryId)) {
      const itemPaths = Database.libraryItemModel.findAll({ where: { libraryId }, attributes: ['path'] }).then((libraryItems) => new Set(libraryItems.map((libraryItem) => filePathToPOSIX(libraryItem.path))))
      itemPaths.catch(() => this.itemPathsByLibraryId.delete(libraryId))
      this.itemPathsByLibraryId.set(libraryId, itemPaths)
    }
    return this.itemPathsByLibraryId.get(libraryId)
  }

  /**
   * @param {string} libraryId
   * @param {string} fromPath
   * @param {string} toPath
   */
  async recordMovedItemPath(libraryId, fromPath, toPath) {
    const itemPaths = await this.itemPathsByLibraryId.get(libraryId)?.catch(() => null)
    if (!itemPaths) return
    itemPaths.delete(fromPath)
    itemPaths.add(toPath)
  }

  /**
   * Work out what organizing the item would do.
   *
   * @param {import('../models/LibraryItem')} libraryItem Expanded library item
   * @param {import('../models/Library')} library Library with folders
   * @returns {Promise<import('../utils/organizePlan').OrganizePlan>}
   */
  async planItem(libraryItem, library) {
    const plan = await buildPlan(libraryItem, library, await this.getItemPaths(libraryItem.libraryId))
    if (plan.changed) plan.skipReason = this.getBusyReason(libraryItem)
    return plan
  }

  /**
   * @param {string} libraryId
   * @returns {Promise<string[]>}
   */
  async getLibraryItemIds(libraryId) {
    const libraryItems = await Database.libraryItemModel.findAll({ where: { libraryId, mediaType: 'book' }, attributes: ['id'] })
    return libraryItems.map((libraryItem) => libraryItem.id)
  }

  /**
   * Plans for the items that would change or be skipped. Items already organized are only counted.
   *
   * @param {string[]} libraryItemIds
   * @returns {Promise<{plans:Object[], unchangedCount:number}>}
   */
  previewItems(libraryItemIds) {
    return this.withSharedItemPaths(async () => {
      const librariesById = new Map()
      const plans = []
      let unchangedCount = 0
      for (let i = 0; i < libraryItemIds.length; i += PREVIEW_CHUNK_SIZE) {
        const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({ id: libraryItemIds.slice(i, i + PREVIEW_CHUNK_SIZE) })
        for (const libraryItem of libraryItems) {
          if (!librariesById.has(libraryItem.libraryId)) {
            librariesById.set(libraryItem.libraryId, await Database.libraryModel.findByIdWithFolders(libraryItem.libraryId))
          }
          const plan = await this.planItem(libraryItem, librariesById.get(libraryItem.libraryId))
          if (plan.changed || plan.skipReason) plans.push(planToClientJSON(plan))
          else unchangedCount++
        }
      }
      return { plans, unchangedCount }
    })
  }

  /**
   * Organize one item. Never throws: failures are returned with the original error message.
   *
   * @param {string} libraryItemId
   * @param {string|null} [expectedHash] Plan hash from a preview. The item is skipped when its plan has changed since the preview
   * @returns {Promise<OrganizeResult>}
   */
  async organizeItem(libraryItemId, expectedHash = null) {
    if (this.itemIdsInProgress.has(libraryItemId)) {
      return { itemId: libraryItemId, status: 'skipped', reason: 'inProgress' }
    }
    this.itemIdsInProgress.add(libraryItemId)
    try {
      return await this.runExclusive(() => this.planAndExecuteItem(libraryItemId, expectedHash))
    } catch (error) {
      Logger.error(`[OrganizeManager] Failed to organize library item "${libraryItemId}"`, error)
      return { itemId: libraryItemId, status: 'failed', error: error.message }
    } finally {
      this.itemIdsInProgress.delete(libraryItemId)
    }
  }

  /**
   * Run after every earlier call to this method has finished, whether it succeeded or not
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  runExclusive(task) {
    const result = this.executionQueue.then(task)
    this.executionQueue = result.catch(() => {})
    return result
  }

  /**
   * @param {string} libraryItemId
   * @param {string|null} expectedHash
   * @returns {Promise<OrganizeResult>}
   */
  async planAndExecuteItem(libraryItemId, expectedHash) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
    if (!libraryItem) return { itemId: libraryItemId, status: 'skipped', reason: 'missing' }

    const library = await Database.libraryModel.findByIdWithFolders(libraryItem.libraryId)
    const plan = await this.planItem(libraryItem, library)
    if (plan.skipReason) return { itemId: libraryItemId, status: 'skipped', reason: plan.skipReason }
    if (!plan.changed) return { itemId: libraryItemId, status: 'unchanged' }
    if (expectedHash && expectedHash !== plan.hash) return { itemId: libraryItemId, status: 'skipped', reason: 'planChanged' }
    // The planning item paths are loaded once per run, so an item added since is only seen by this lookup
    if (await isPlanInsideAnotherItem(libraryItem, library, plan)) return { itemId: libraryItemId, status: 'skipped', reason: 'targetInsideItem' }

    await this.executePlan(libraryItem, library, plan)
    await this.recordMovedItemPath(libraryItem.libraryId, plan.fromPath, plan.toPath)
    return { itemId: libraryItemId, status: 'moved' }
  }

  /**
   * Where the library's templates put the book, taken before an edit to tell whether the edit moved it.
   *
   * @param {import('../models/LibraryItem')} libraryItem Expanded library item
   * @returns {Promise<string|null>} Null when the item is not a book or its library has auto organize off
   */
  async getAutoOrganizeTarget(libraryItem) {
    if (!libraryItem.isBook) return null
    const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
    if (!library?.librarySettings.autoOrganize) return null
    return getRenderedTargetKey(libraryItem, library.librarySettings)
  }

  /**
   * @param {string} libraryItemId
   * @param {string|null} targetBefore From getAutoOrganizeTarget before the edit
   * @returns {Promise<boolean>} True when the edit changed where the templates put the book
   */
  async hasTargetChanged(libraryItemId, targetBefore) {
    if (targetBefore === null) return false
    const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
    if (!libraryItem) return false
    const targetAfter = await this.getAutoOrganizeTarget(libraryItem)
    return targetAfter !== null && targetAfter !== targetBefore
  }

  /**
   * Organize the item when its library has auto organize on and the edit changed where the templates put it
   *
   * @param {string} libraryItemId
   * @param {string|null} targetBefore From getAutoOrganizeTarget before the edit
   * @returns {Promise<import('../models/LibraryItem')|null>} The reloaded expanded item when it was moved or renamed
   */
  async autoOrganizeItem(libraryItemId, targetBefore) {
    if (!(await this.hasTargetChanged(libraryItemId, targetBefore))) return null

    const result = await this.organizeItem(libraryItemId)
    if (result.status === 'skipped' || result.status === 'failed') {
      Logger.warn(`[OrganizeManager] Auto organize of library item "${libraryItemId}" ${result.status}: ${result.reason || result.error}`)
    }
    return result.status === 'moved' ? Database.libraryItemModel.getExpandedById(libraryItemId) : null
  }

  /**
   * Start a background task for the edited items whose edit changed where the templates put them
   *
   * @param {Map<string, string|null>} targetsBefore Library item id to getAutoOrganizeTarget from before the edit
   * @returns {Promise<void>}
   */
  async autoOrganizeItemsInBackground(targetsBefore) {
    try {
      const libraryItemIds = []
      for (const [libraryItemId, targetBefore] of targetsBefore) {
        if (await this.hasTargetChanged(libraryItemId, targetBefore)) libraryItemIds.push(libraryItemId)
      }
      if (libraryItemIds.length) this.startTask(libraryItemIds)
    } catch (error) {
      Logger.error('[OrganizeManager] Failed to start auto organize of edited items', error)
    }
  }

  /**
   * Organize all items of a library in a background task
   *
   * @param {string} libraryId
   * @returns {Promise<void>}
   */
  async organizeLibrary(libraryId) {
    try {
      const libraryItemIds = await this.getLibraryItemIds(libraryId)
      if (libraryItemIds.length) this.startTask(libraryItemIds)
    } catch (error) {
      Logger.error(`[OrganizeManager] Failed to start organizing library "${libraryId}"`, error)
    }
  }

  /**
   * Organize all items of a library when an organize template changed
   *
   * @param {string} libraryId
   * @param {import('../models/Library').LibrarySettingsObject} previousSettings
   * @param {import('../models/Library').LibrarySettingsObject} newSettings
   * @returns {Promise<void>}
   */
  async organizeLibraryIfTemplatesChanged(libraryId, previousSettings, newSettings) {
    if (TEMPLATE_SETTING_KEYS.some((key) => previousSettings[key] !== newSettings[key])) {
      await this.organizeLibrary(libraryId)
    }
  }

  /**
   * Start a background task that organizes the items one at a time. One failure does not stop the others.
   *
   * @param {string[]} libraryItemIds
   * @param {Object<string,string>|null} [planHashes] Hashes from a preview keyed by item id. Items not in the preview are not touched
   * @returns {import('../objects/Task')}
   */
  startTask(libraryItemIds, planHashes = null) {
    const titleString = { text: 'Organizing files', key: 'MessageTaskOrganizingFiles' }
    const descriptionString = { text: `Items: ${libraryItemIds.length}`, key: 'MessageTaskOrganizeItemCount', subs: [String(libraryItemIds.length)] }
    const task = TaskManager.createAndAddTask('organize-files', titleString, descriptionString, true)

    this.runTask(task, libraryItemIds, planHashes).catch((error) => {
      Logger.error('[OrganizeManager] Organize task failed', error)
      task.setFailed({ text: 'Failed to organize files', key: 'MessageTaskOrganizeFailed' })
      TaskManager.taskFinished(task)
    })
    return task
  }

  /**
   * @param {import('../objects/Task')} task
   * @param {string[]} libraryItemIds
   * @param {Object<string,string>|null} planHashes
   */
  runTask(task, libraryItemIds, planHashes) {
    return this.withSharedItemPaths(() => this.organizeTaskItems(task, libraryItemIds, planHashes))
  }

  /**
   * @param {import('../objects/Task')} task
   * @param {string[]} libraryItemIds
   * @param {Object<string,string>|null} planHashes
   */
  async organizeTaskItems(task, libraryItemIds, planHashes) {
    const counts = { moved: 0, unchanged: 0, skipped: 0, failed: 0 }
    /** @type {OrganizeResult[]} */
    const problems = []
    for (const libraryItemId of libraryItemIds) {
      const isPreviewed = !planHashes || typeof planHashes[libraryItemId] === 'string'
      const result = isPreviewed ? await this.organizeItem(libraryItemId, planHashes?.[libraryItemId]) : { itemId: libraryItemId, status: 'skipped', reason: 'notPreviewed' }
      counts[result.status]++
      if (result.status === 'skipped' || result.status === 'failed') {
        Logger.warn(`[OrganizeManager] Library item "${libraryItemId}" ${result.status}: ${result.reason || result.error}`)
        if (problems.length < MAX_REPORTED_RESULTS) problems.push(result)
      }
    }
    task.data.results = await this.addTitlesToResults(problems)
    const resultSubs = [counts.moved, counts.skipped, counts.failed].map(String)
    task.setFinished({ text: `Moved ${resultSubs[0]}, skipped ${resultSubs[1]}, failed ${resultSubs[2]}`, key: 'MessageTaskOrganizeResult', subs: resultSubs })
    TaskManager.taskFinished(task)
  }

  /**
   * Titles are for display only, so a failed lookup leaves them out
   *
   * @param {OrganizeResult[]} results
   * @returns {Promise<(OrganizeResult & {title:string|null})[]>}
   */
  async addTitlesToResults(results) {
    let titles = new Map()
    try {
      const libraryItems = results.length ? await Database.libraryItemModel.findAllExpandedWhere({ id: results.map((result) => result.itemId) }) : []
      titles = new Map(libraryItems.map((libraryItem) => [libraryItem.id, libraryItem.media.title]))
    } catch (error) {
      Logger.warn('[OrganizeManager] Failed to look up the titles of items that were not organized', error)
    }
    return results.map((result) => ({ ...result, title: titles.get(result.itemId) || null }))
  }

  /**
   * Move and rename the files, then rescan the item at its new path.
   * On failure the moves are reversed and the original error is thrown.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../models/Library')} library
   * @param {import('../utils/organizePlan').OrganizePlan} plan
   */
  async executePlan(libraryItem, library, plan) {
    const libraryFolder = library.libraryFolders.find((folder) => folder.id === libraryItem.libraryFolderId)
    /** @type {OrganizeJournal} */
    const journal = {
      libraryItemId: libraryItem.id,
      libraryFolderId: libraryFolder.id,
      libraryFolderPath: filePathToPOSIX(libraryFolder.path),
      isFile: libraryItem.isFile,
      fromPath: plan.fromPath,
      fromRelPath: plan.fromRelPath,
      toPath: plan.toPath,
      toRelPath: plan.toRelPath,
      mediaChoices: captureMediaChoices(libraryItem.media),
      steps: plan.moves.map((move) => ({ ...move, state: 'pending', tempPath: null })),
      createdDirectories: await this.getMissingDirectories(plan.toPath, filePathToPOSIX(libraryFolder.path)),
      scanStarted: false
    }
    const feedUpdate = this.getFeedPathUpdate(libraryItem, plan.moves)

    Watcher.addIgnoreDir(plan.fromPath)
    Watcher.addIgnoreDir(plan.toPath)
    try {
      await this.writeJournal(journal)
      await this.runSteps(journal)
      journal.scanStarted = true
      await this.writeJournal(journal)
      await this.rescanAtTarget(journal)
    } catch (error) {
      await this.rollback(journal)
      throw error
    } finally {
      Watcher.removeIgnoreDir(plan.fromPath)
      Watcher.removeIgnoreDir(plan.toPath)
    }

    await this.finishItem(journal, feedUpdate)
  }

  /**
   * @param {OrganizeJournal} journal
   */
  async writeJournal(journal) {
    const journalPath = this.getJournalPath(journal.libraryItemId)
    await fs.ensureDir(this.journalDirectory)
    await fs.writeFile(`${journalPath}.tmp`, JSON.stringify(journal, null, 2))
    await fs.rename(`${journalPath}.tmp`, journalPath)
  }

  /**
   * @param {string} libraryItemId
   */
  removeJournal(libraryItemId) {
    return fs.unlink(this.getJournalPath(libraryItemId)).catch((error) => {
      if (error.code !== 'ENOENT') Logger.warn(`[OrganizeManager] Failed to remove journal for library item "${libraryItemId}"`, error)
    })
  }

  /**
   * @param {OrganizeJournal} journal
   */
  async runSteps(journal) {
    for (const step of journal.steps) {
      await this.moveStep(journal, step)
    }
  }

  /**
   * Rename the path, or when it is on another file system copy it first. Fails when something already exists at the destination.
   *
   * @param {OrganizeJournal} journal
   * @param {OrganizeStep} step
   */
  async moveStep(journal, step) {
    if (await isPathTakenByOther(step.from, step.to)) {
      throw new Error(`Cannot move "${step.from}" to "${step.to}": the destination already exists`)
    }
    await fs.ensureDir(Path.posix.dirname(step.to))
    try {
      await fs.rename(step.from, step.to)
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      await this.copyAcrossFileSystems(journal, step)
    }
    step.state = 'done'
    await this.writeJournal(journal)
  }

  /**
   * Copy to a temp name, rename it into place, then remove the source.
   * The journal records progress so a failed run can restore the source.
   *
   * @param {OrganizeJournal} journal
   * @param {OrganizeStep} step
   */
  async copyAcrossFileSystems(journal, step) {
    step.tempPath = Path.posix.join(Path.posix.dirname(step.to), `.organize-${crypto.randomUUID()}.tmp`)
    step.state = 'copying'
    await this.writeJournal(journal)
    await fs.copy(step.from, step.tempPath, { overwrite: false, errorOnExist: true })
    step.state = 'copied'
    await this.writeJournal(journal)

    // The copy can take long enough for another writer to create the destination
    if (await isPathTakenByOther(null, step.to)) {
      throw new Error(`Cannot move "${step.from}" to "${step.to}": the destination already exists`)
    }
    await fs.rename(step.tempPath, step.to)
    await fs.remove(step.from)
  }

  /**
   * @param {OrganizeJournal} journal
   */
  rescanAtTarget(journal) {
    return this.rescanItem(journal, { path: journal.toPath, relPath: journal.toRelPath, isFile: false, moves: journal.steps })
  }

  /**
   * @param {OrganizeJournal} journal
   */
  rescanAtSource(journal) {
    return this.rescanItem(journal, { path: journal.fromPath, relPath: journal.fromRelPath, isFile: journal.isFile, moves: [] })
  }

  /**
   * Rescan keeps the library item row and refreshes its paths, files and cover.
   * The scan resets track and ebook settings that depend on the files, so they are put back after it.
   *
   * @param {OrganizeJournal} journal
   * @param {{path:string, relPath:string, isFile:boolean, moves:OrganizeStep[]}} location Where the item is now, and the moves that took its files there
   */
  async rescanItem(journal, { path, relPath, isFile, moves }) {
    const scanResult = await LibraryItemScanner.scanLibraryItem(journal.libraryItemId, { path, relPath, libraryFolderId: journal.libraryFolderId, isFile })
    if (scanResult === ScanResult.NOTHING) {
      throw new Error(`Rescan of library item "${journal.libraryItemId}" at "${path}" found nothing to update`)
    }
    const hasRestoredChanges = await restoreMediaChoices(journal.libraryItemId, journal.mediaChoices, moves)
    if (hasRestoredChanges) {
      // The scan already told clients about the item, but before the restore
      SocketAuthority.libraryItemEmitter('item_updated', await Database.libraryItemModel.getExpandedById(journal.libraryItemId))
    }
  }

  /**
   * Reverse the moves of a failed run. Keeps the journal when a move could not be reversed.
   *
   * @param {OrganizeJournal} journal
   */
  async rollback(journal) {
    const isUndone = await this.undoSteps(journal)
    if (!isUndone) {
      Logger.error(`[OrganizeManager] Could not fully undo moves for library item "${journal.libraryItemId}". Journal kept at "${this.getJournalPath(journal.libraryItemId)}"`)
      return
    }
    if (journal.scanStarted) {
      await this.rescanAtSource(journal).catch((error) => {
        Logger.error(`[OrganizeManager] Failed to rescan library item "${journal.libraryItemId}" at its original path`, error)
      })
    }
    for (const directory of journal.createdDirectories) {
      await fs.rmdir(directory).catch(() => {}) // Gone with the moved folder, or not empty
    }
    await this.removeJournal(journal.libraryItemId)
  }

  /**
   * @param {OrganizeJournal} journal
   * @returns {Promise<boolean>} True when every step was reversed
   */
  async undoSteps(journal) {
    let isUndone = true
    for (const step of [...journal.steps].reverse()) {
      try {
        await this.undoStep(journal, step)
      } catch (error) {
        Logger.error(`[OrganizeManager] Failed to undo the move of "${step.from}" to "${step.to}"`, error)
        isUndone = false
      }
    }
    return isUndone
  }

  /**
   * Put the step's source back without removing anything this run did not create. Safe to repeat.
   *
   * @param {OrganizeJournal} journal
   * @param {OrganizeStep} step
   */
  async undoStep(journal, step) {
    if (step.state === 'copying') {
      await removeTreeWithReadOnlyFolders(step.tempPath)
    } else if (step.state === 'copied') {
      await this.restoreSourceFromCopy(step)
    } else if (await this.isMovedAway(step)) {
      await this.moveStep(journal, { from: step.to, to: step.from, state: 'pending', tempPath: null })
    }
  }

  /**
   * A pending step may have renamed the path before its journal write
   *
   * @param {OrganizeStep} step
   * @returns {Promise<boolean>}
   */
  async isMovedAway(step) {
    if (!(await getPathIdentity(step.to))) return false
    return step.state === 'done' || !(await getPathIdentity(step.from))
  }

  /**
   * Copy back what a partly failed source removal deleted, then drop the copy
   *
   * @param {OrganizeStep} step
   */
  async restoreSourceFromCopy(step) {
    const copyPath = (await getPathIdentity(step.tempPath)) ? step.tempPath : step.to
    if (!(await getPathIdentity(copyPath)) || (await isSameFile(copyPath, step.from))) return

    await fs.copy(copyPath, step.from, { overwrite: false, errorOnExist: false })
    await removeTreeWithReadOnlyFolders(copyPath)
  }

  /**
   * Missing folders of the path below the library folder, deepest first
   *
   * @param {string} path
   * @param {string} libraryFolderPath
   * @returns {Promise<string[]>}
   */
  async getMissingDirectories(path, libraryFolderPath) {
    const missing = []
    for (const directory of getPathsBelowLibraryFolder(libraryFolderPath, path)) {
      if (await fs.pathExists(directory)) break
      missing.push(directory)
    }
    return missing
  }

  /**
   * Remove folders left empty above the path, never the library folder itself
   *
   * @param {string} path
   * @param {string} libraryFolderPath
   */
  async removeEmptyParents(path, libraryFolderPath) {
    for (const directory of getPathsBelowLibraryFolder(libraryFolderPath, path).slice(1)) {
      const isRemoved = await fs.rmdir(directory).then(
        () => true,
        () => false // Not empty, or already gone
      )
      if (!isRemoved) return
    }
  }

  /**
   * Feed episodes store absolute file paths. Work out the new path of each before the library item is rescanned.
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../utils/organizePlan').OrganizeMove[]} moves
   * @returns {{filePathUpdates:{from:string, to:string}[], coverPathUpdate:{from:string, to:string}|null}}
   */
  getFeedPathUpdate(libraryItem, moves) {
    const filePathUpdates = libraryItem.media.audioFiles.map((audioFile) => ({ from: audioFile.metadata.path, to: getMovedPath(audioFile.metadata.path, moves) }))
    const coverPath = libraryItem.media.coverPath
    return {
      filePathUpdates: filePathUpdates.filter((update) => update.from !== update.to),
      coverPathUpdate: coverPath ? { from: coverPath, to: getMovedPath(coverPath, moves) } : null
    }
  }

  /**
   * Best effort steps after a successful move. Failures are logged and do not undo the move.
   *
   * @param {OrganizeJournal} journal
   * @param {{filePathUpdates:{from:string, to:string}[], coverPathUpdate:{from:string, to:string}|null}} feedUpdate
   */
  async finishItem(journal, feedUpdate) {
    try {
      for (const { from, to } of feedUpdate.filePathUpdates) {
        await Database.feedEpisodeModel.update({ filePath: to }, { where: { filePath: from } })
      }
      if (feedUpdate.coverPathUpdate && feedUpdate.coverPathUpdate.from !== feedUpdate.coverPathUpdate.to) {
        await Database.feedModel.update({ coverPath: feedUpdate.coverPathUpdate.to }, { where: { coverPath: feedUpdate.coverPathUpdate.from } })
      }
      await this.removeEmptyParents(journal.fromPath, journal.libraryFolderPath)
      await this.removeJournal(journal.libraryItemId)
    } catch (error) {
      Logger.warn(`[OrganizeManager] Failed to finish cleanup after organizing library item "${journal.libraryItemId}"`, error)
    }
  }

  /**
   * Handle journals left by a crash. Rolls back runs that had not started the rescan and finishes the others.
   */
  async recoverInterrupted() {
    const journalFiles = await fs.readdir(this.journalDirectory).catch(() => [])
    for (const journalFile of journalFiles.filter((file) => file.endsWith('.json'))) {
      try {
        const journal = JSON.parse(await fs.readFile(Path.join(this.journalDirectory, journalFile), 'utf8'))
        Logger.warn(`[OrganizeManager] Recovering interrupted organize of library item "${journal.libraryItemId}"`)
        if (journal.scanStarted) {
          await this.rescanAtTarget(journal)
          await this.removeEmptyParents(journal.fromPath, journal.libraryFolderPath)
          await this.removeJournal(journal.libraryItemId)
        } else {
          await this.rollback(journal)
        }
      } catch (error) {
        Logger.error(`[OrganizeManager] Failed to recover organize journal "${journalFile}"`, error)
      }
    }
  }
}
module.exports = OrganizeManager
