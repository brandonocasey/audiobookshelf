const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const { isObject } = require('../utils/index')
const { getTemplateExample } = require('../utils/organizeTemplate')

const PODCAST_ORGANIZE_MESSAGE = 'Organizing files is not supported for podcast libraries'

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 *
 * @typedef {RequestWithUser & RequestEntityObject} RequestWithLibraryItem
 */

/**
 * Resolve the library item ids from `libraryItemIds` or `libraryId` in the request body.
 * Sends the error response and returns null when the request is invalid.
 *
 * @param {import('../managers/OrganizeManager')} organizeManager
 * @param {RequestWithUser} req
 * @param {Response} res
 * @returns {Promise<string[]|null>}
 */
async function getOrganizeItemIds(organizeManager, req, res) {
  const { libraryId, libraryItemIds } = req.body
  if (typeof libraryId === 'string') {
    const library = await Database.libraryModel.findByPk(libraryId)
    if (!library) {
      res.sendStatus(404)
      return null
    }
    if (!req.user.checkCanAccessLibrary(library.id)) {
      res.sendStatus(403)
      return null
    }
    if (library.isPodcast) {
      res.status(400).send(PODCAST_ORGANIZE_MESSAGE)
      return null
    }
    return organizeManager.getLibraryItemIds(library.id)
  }

  if (!Array.isArray(libraryItemIds) || !libraryItemIds.length || libraryItemIds.some((id) => typeof id !== 'string')) {
    res.status(400).send('Invalid request payload')
    return null
  }
  const libraryItems = await Database.libraryItemModel.findAll({ where: { id: libraryItemIds }, attributes: ['id', 'libraryId', 'mediaType'] })
  if (libraryItems.length !== new Set(libraryItemIds).size) {
    res.sendStatus(404)
    return null
  }
  if (libraryItems.some((libraryItem) => !req.user.checkCanAccessLibrary(libraryItem.libraryId))) {
    res.sendStatus(403)
    return null
  }
  if (libraryItems.some((libraryItem) => libraryItem.mediaType !== 'book')) {
    res.status(400).send(PODCAST_ORGANIZE_MESSAGE)
    return null
  }
  return libraryItems.map((libraryItem) => libraryItem.id)
}

class ToolsController {
  constructor() {}

  /**
   * POST: /api/tools/item/:id/encode-m4b
   * Start an audiobook merge to m4b task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async encodeM4b(req, res) {
    if (req.libraryItem.isMissing || req.libraryItem.isInvalid) {
      Logger.error(`[MiscController] encodeM4b: library item not found or invalid ${req.params.id}`)
      return res.status(404).send('Audiobook not found')
    }

    if (!req.libraryItem.isBook) {
      Logger.error(`[MiscController] encodeM4b: Invalid library item ${req.params.id}: not a book`)
      return res.status(400).send('Invalid library item: not a book')
    }

    if (!req.libraryItem.hasAudioTracks) {
      Logger.error(`[MiscController] encodeM4b: Invalid audiobook ${req.params.id}: no audio tracks`)
      return res.status(400).send('Invalid audiobook: no audio tracks')
    }

    if (this.abMergeManager.getPendingTaskByLibraryItemId(req.libraryItem.id)) {
      Logger.error(`[MiscController] encodeM4b: Audiobook ${req.params.id} is already processing`)
      return res.status(400).send('Audiobook is already processing')
    }

    const options = req.query || {}
    Logger.info(`[ToolsController] encodeM4b: Starting audiobook merge for "${req.libraryItem.media.title}" with options: ${JSON.stringify(options)}`)
    this.abMergeManager.startAudiobookMerge(req.user.id, req.libraryItem, options)

    res.sendStatus(200)
  }

  /**
   * DELETE: /api/tools/item/:id/encode-m4b
   * Cancel a running m4b merge task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async cancelM4bEncode(req, res) {
    const workerTask = this.abMergeManager.getPendingTaskByLibraryItemId(req.params.id)
    if (!workerTask) return res.sendStatus(404)

    this.abMergeManager.cancelEncode(workerTask.task)

    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/item/:id/embed-metadata
   * Start audiobook embed task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async embedAudioFileMetadata(req, res) {
    if (req.libraryItem.isMissing || !req.libraryItem.hasAudioTracks || !req.libraryItem.isBook) {
      Logger.error(`[ToolsController] Invalid library item`)
      return res.sendStatus(400)
    }

    if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(req.libraryItem.id)) {
      Logger.error(`[ToolsController] Library item (${req.libraryItem.id}) is already in queue or processing`)
      return res.status(400).send('Library item is already in queue or processing')
    }

    const options = {
      forceEmbedChapters: req.query.forceEmbedChapters === '1',
      backup: req.query.backup === '1'
    }
    this.audioMetadataManager.updateMetadataForItem(req.user.id, req.libraryItem, options)
    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/batch/embed-metadata
   * Start batch audiobook embed task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchEmbedMetadata(req, res) {
    const libraryItemIds = req.body.libraryItemIds || []
    if (!libraryItemIds.length) {
      return res.status(400).send('Invalid request payload')
    }

    const libraryItems = []
    for (const libraryItemId of libraryItemIds) {
      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
      if (!libraryItem) {
        Logger.error(`[ToolsController] Batch embed metadata library item (${libraryItemId}) not found`)
        return res.sendStatus(404)
      }

      // Check user can access this library item
      if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
        Logger.error(`[ToolsController] Batch embed metadata library item (${libraryItemId}) not accessible to user "${req.user.username}"`)
        return res.sendStatus(403)
      }

      if (libraryItem.isMissing || !libraryItem.hasAudioTracks || !libraryItem.isBook) {
        Logger.error(`[ToolsController] Batch embed invalid library item (${libraryItemId})`)
        return res.sendStatus(400)
      }

      if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(libraryItemId)) {
        Logger.error(`[ToolsController] Batch embed library item (${libraryItemId}) is already in queue or processing`)
        return res.status(400).send('Library item is already in queue or processing')
      }

      libraryItems.push(libraryItem)
    }

    const options = {
      forceEmbedChapters: req.query.forceEmbedChapters === '1',
      backup: req.query.backup === '1'
    }
    this.audioMetadataManager.handleBatchEmbed(req.user.id, libraryItems, options)
    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/organize/example
   * Body: { organizeFolderTemplate: string, organizeFileTemplate: string }
   * Render the templates for a sample book
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  organizeExample(req, res) {
    const { organizeFolderTemplate, organizeFileTemplate } = req.body
    res.json(getTemplateExample(organizeFolderTemplate, organizeFileTemplate))
  }

  /**
   * POST: /api/tools/organize/preview
   * Body: { libraryItemIds: string[] } or { libraryId: string }
   * Show what organizing would do without changing any files
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async previewOrganize(req, res) {
    const libraryItemIds = await getOrganizeItemIds(this.organizeManager, req, res)
    if (!libraryItemIds) return

    res.json(await this.organizeManager.previewItems(libraryItemIds))
  }

  /**
   * POST: /api/tools/organize
   * Body: { libraryItemIds: string[] } or { libraryId: string }, and optional planHashes from the preview
   * Start a task that moves and renames the files. With planHashes only the previewed items are organized.
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async organize(req, res) {
    const libraryItemIds = await getOrganizeItemIds(this.organizeManager, req, res)
    if (!libraryItemIds) return

    const { planHashes } = req.body
    if (planHashes !== undefined && !isObject(planHashes)) {
      return res.status(400).send('Invalid request payload')
    }
    const idsToOrganize = planHashes ? libraryItemIds.filter((id) => typeof planHashes[id] === 'string') : libraryItemIds
    if (!idsToOrganize.length) {
      return res.status(400).send('No library items to organize')
    }

    this.organizeManager.startTask(idsToOrganize, planHashes || null)
    res.json({ itemCount: idsToOrganize.length })
  }

  /**
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryItemController] Non-root user "${req.user.username}" attempted to access tools route`)
      return res.sendStatus(403)
    }

    if (req.params.id) {
      const item = await Database.libraryItemModel.getExpandedById(req.params.id)
      if (!item?.media) return res.sendStatus(404)

      // Check user can access this library item
      if (!req.user.checkCanAccessLibraryItem(item)) {
        return res.sendStatus(403)
      }

      req.libraryItem = item
    }

    next()
  }
}
module.exports = new ToolsController()
