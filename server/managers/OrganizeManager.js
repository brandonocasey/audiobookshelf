const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const Watcher = require('../Watcher')
const TaskManager = require('./TaskManager')
const LibraryScanner = require('../scanner/LibraryScanner')
const LibraryItemScanner = require('../scanner/LibraryItemScanner')
const { ScanResult } = require('../utils/constants')
const { filePathToPOSIX, isSameOrSubPath } = require('../utils/fileUtils')
const { buildPlan, planToClientJSON } = require('../utils/organizePlan')

const PREVIEW_CHUNK_SIZE = 50

/**
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
 * @property {{from:string, to:string, done:boolean}[]} steps
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
   */
  constructor(playbackSessionManager) {
    this.playbackSessionManager = playbackSessionManager
    /** @type {Set<string>} */
    this.itemIdsInProgress = new Set()
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
    if (LibraryScanner.isLibraryScanning(libraryItem.libraryId)) return 'libraryScanning'
    if (this.playbackSessionManager.sessions.some((session) => session.libraryItemId === libraryItem.id)) return 'streaming'
    return null
  }

  /**
   * Work out what organizing the item would do. Used by both preview and execution.
   *
   * @param {import('../models/LibraryItem')} libraryItem Expanded library item
   * @param {import('../models/Library')} library Library with folders
   * @returns {Promise<import('../utils/organizePlan').OrganizePlan>}
   */
  async planItem(libraryItem, library) {
    const plan = await buildPlan(libraryItem, library)
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
  async previewItems(libraryItemIds) {
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
  }

  /**
   * Organize one item. Never throws: failures are returned with the original error message.
   *
   * @param {string} libraryItemId
   * @param {string|null} [expectedHash] Plan hash from a preview. The item is skipped when its plan has changed since
   * @returns {Promise<OrganizeResult>}
   */
  async organizeItem(libraryItemId, expectedHash = null) {
    if (this.itemIdsInProgress.has(libraryItemId)) {
      return { itemId: libraryItemId, status: 'skipped', reason: 'inProgress' }
    }
    this.itemIdsInProgress.add(libraryItemId)
    try {
      return await this.planAndExecuteItem(libraryItemId, expectedHash)
    } catch (error) {
      Logger.error(`[OrganizeManager] Failed to organize library item "${libraryItemId}"`, error)
      return { itemId: libraryItemId, status: 'failed', error: error.message }
    } finally {
      this.itemIdsInProgress.delete(libraryItemId)
    }
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

    await this.executePlan(libraryItem, library, plan)
    return { itemId: libraryItemId, status: 'moved' }
  }

  /**
   * Organize the item after an edit when the library has auto organize on. Called by edit and match flows, never by scans.
   *
   * @param {string} libraryItemId
   * @returns {Promise<boolean>} True when the item was moved or renamed, so callers should reload it
   */
  async autoOrganizeItem(libraryItemId) {
    const libraryItem = await Database.libraryItemModel.findByPk(libraryItemId, { attributes: ['id', 'libraryId', 'mediaType'] })
    if (libraryItem?.mediaType !== 'book') return false

    const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
    if (!library.librarySettings.autoOrganize) return false

    const result = await this.organizeItem(libraryItemId)
    if (result.status === 'skipped' || result.status === 'failed') {
      Logger.warn(`[OrganizeManager] Auto organize of library item "${libraryItemId}" ${result.status}: ${result.reason || result.error}`)
    }
    return result.status === 'moved'
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
   * Start a background task that organizes the items one at a time. One failure does not stop the others.
   *
   * @param {string[]} libraryItemIds
   * @param {Object<string,string>|null} [planHashes] Hashes from a preview keyed by item id. Items not in the preview are not touched
   * @returns {import('../objects/Task')}
   */
  startTask(libraryItemIds, planHashes = null) {
    const titleString = { text: 'Organizing files', key: 'MessageTaskOrganizingFiles' }
    const descriptionString = { text: `${libraryItemIds.length} items`, key: 'MessageTaskOrganizeItemCount', subs: [String(libraryItemIds.length)] }
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
  async runTask(task, libraryItemIds, planHashes) {
    const counts = { moved: 0, unchanged: 0, skipped: 0, failed: 0 }
    for (const libraryItemId of libraryItemIds) {
      const result = await this.organizeItem(libraryItemId, planHashes?.[libraryItemId])
      counts[result.status]++
      if (result.status === 'skipped' || result.status === 'failed') {
        Logger.warn(`[OrganizeManager] Library item "${libraryItemId}" ${result.status}: ${result.reason || result.error}`)
      }
    }
    const resultSubs = [counts.moved, counts.skipped, counts.failed].map(String)
    task.setFinished({ text: `Moved ${resultSubs[0]}, skipped ${resultSubs[1]}, failed ${resultSubs[2]}`, key: 'MessageTaskOrganizeResult', subs: resultSubs })
    TaskManager.taskFinished(task)
  }

  /**
   * Carry out the plan: move files and folders, rescan the item at its new path, tidy up.
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
      steps: plan.moves.map((move) => ({ ...move, done: false })),
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
      await this.rescanItem(journal, journal.toPath, journal.toRelPath, false)
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
    await fs.mkdir(this.journalDirectory, { recursive: true })
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
      await fs.move(step.from, step.to)
      step.done = true
      await this.writeJournal(journal)
    }
  }

  /**
   * Rescan keeps the library item row (and everything keyed on its id) and refreshes paths, files and cover
   *
   * @param {OrganizeJournal} journal
   * @param {string} path Absolute path of the item
   * @param {string} relPath Path of the item relative to its library folder
   * @param {boolean} isFile
   */
  async rescanItem(journal, path, relPath, isFile) {
    const scanResult = await LibraryItemScanner.scanLibraryItem(journal.libraryItemId, { path, relPath, libraryFolderId: journal.libraryFolderId, isFile })
    if (scanResult === ScanResult.NOTHING) {
      throw new Error(`Rescan of library item "${journal.libraryItemId}" at "${path}" found nothing to update`)
    }
  }

  /**
   * Reverse the moves of a failed run. Keeps the journal when something could not be reversed so it can be retried at startup.
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
      await this.rescanItem(journal, journal.fromPath, journal.fromRelPath, journal.isFile).catch((error) => {
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
        await this.undoStep(step)
      } catch (error) {
        Logger.error(`[OrganizeManager] Failed to move "${step.to}" back to "${step.from}"`, error)
        isUndone = false
      }
    }
    return isUndone
  }

  /**
   * @param {{from:string, to:string, done:boolean}} step
   */
  async undoStep(step) {
    const hasDestination = await fs.pathExists(step.to)
    if (!hasDestination) return

    if (await fs.pathExists(step.from)) {
      // An interrupted move across file systems leaves a partial copy at the destination. The destination did not exist before this run.
      if (!step.done) await fs.remove(step.to)
      return
    }
    await fs.move(step.to, step.from)
  }

  /**
   * The path and its parents below the library folder that do not exist yet, deepest first
   *
   * @param {string} path
   * @param {string} libraryFolderPath
   * @returns {Promise<string[]>}
   */
  async getMissingDirectories(path, libraryFolderPath) {
    const missing = []
    let directory = path
    while (directory !== libraryFolderPath && isSameOrSubPath(libraryFolderPath, directory) && !(await fs.pathExists(directory))) {
      missing.push(directory)
      directory = Path.posix.dirname(directory)
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
    let directory = Path.posix.dirname(path)
    while (directory !== libraryFolderPath && isSameOrSubPath(libraryFolderPath, directory)) {
      const isRemoved = await fs.rmdir(directory).then(
        () => true,
        () => false // Not empty, or already gone
      )
      if (!isRemoved) return
      directory = Path.posix.dirname(directory)
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
    const filePathUpdates = libraryItem.media.audioFiles.map((audioFile) => ({ from: audioFile.metadata.path, to: this.getMovedPath(audioFile.metadata.path, moves) }))
    const coverPath = libraryItem.media.coverPath
    return {
      filePathUpdates: filePathUpdates.filter((update) => update.from !== update.to),
      coverPathUpdate: coverPath ? { from: coverPath, to: this.getMovedPath(coverPath, moves) } : null
    }
  }

  /**
   * Where a path ends up after the moves, applied in order. Moving a folder moves the paths inside it.
   *
   * @param {string} path
   * @param {import('../utils/organizePlan').OrganizeMove[]} moves
   * @returns {string}
   */
  getMovedPath(path, moves) {
    let movedPath = path
    for (const move of moves) {
      if (movedPath === move.from) movedPath = move.to
      else if (movedPath.startsWith(`${move.from}/`)) movedPath = move.to + movedPath.slice(move.from.length)
    }
    return movedPath
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
   * Handle journals left by a crash. A run that had not started the rescan is rolled back,
   * one that had is finished by rescanning the item at its new path.
   */
  async recoverInterrupted() {
    const journalFiles = await fs.readdir(this.journalDirectory).catch(() => [])
    for (const journalFile of journalFiles.filter((file) => file.endsWith('.json'))) {
      try {
        const journal = JSON.parse(await fs.readFile(Path.join(this.journalDirectory, journalFile), 'utf8'))
        Logger.warn(`[OrganizeManager] Recovering interrupted organize of library item "${journal.libraryItemId}"`)
        if (journal.scanStarted) {
          await this.rescanItem(journal, journal.toPath, journal.toRelPath, false)
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
