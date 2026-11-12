const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')

const RssFeedManager = require('../managers/RssFeedManager')

const libraryItemsBookFilters = require('../utils/queries/libraryItemsBookFilters')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/Series')} series
 *
 * @typedef {RequestWithUser & RequestEntityObject} SeriesControllerRequest
 */

class SeriesController {
  constructor() {}

  /**
   * @deprecated
   * /api/series/:id
   *
   * TODO: Update mobile app to use /api/libraries/:id/series/:seriesId API route instead
   * Series are not library specific so we need to know what the library id is
   *
   * @param {SeriesControllerRequest} req
   * @param {Response} res
   */
  async findOne(req, res) {
    const include = (req.query.include || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => !!v)

    const seriesJson = req.series.toOldJSON()

    // Add progress map with isFinished flag
    if (include.includes('progress')) {
      const libraryItemsInSeries = req.libraryItemsInSeries
      const libraryItemsFinished = libraryItemsInSeries.filter((li) => {
        return req.user.getMediaProgress(li.media.id)?.isFinished
      })
      seriesJson.progress = {
        libraryItemIds: libraryItemsInSeries.map((li) => li.id),
        libraryItemIdsFinished: libraryItemsFinished.map((li) => li.id),
        isFinished: libraryItemsFinished.length === libraryItemsInSeries.length
      }
    }

    if (include.includes('rssfeed')) {
      const feedObj = await RssFeedManager.findFeedForEntityId(seriesJson.id)
      seriesJson.rssFeed = feedObj?.toOldJSONMinified() || null
    }

    res.json(seriesJson)
  }

  /**
   * TODO: Currently unused in the client, should check for duplicate name
   *
   * @param {SeriesControllerRequest} req
   * @param {Response} res
   */
  async update(req, res) {
    const keysToUpdate = ['name', 'description']
    const payload = {}
    for (const key of keysToUpdate) {
      if (req.body[key] !== undefined && typeof req.body[key] === 'string') {
        payload[key] = req.body[key]
      }
    }
    if (!Object.keys(payload).length) {
      return res.status(400).send('No valid fields to update')
    }

    // Every book in the series, with where the templates put it before the rename
    const isRename = payload.name !== undefined && payload.name !== req.series.name
    const libraryItems = isRename ? await Database.seriesModel.getAllLibraryItemsForSeries(req.series.id) : []
    const organizeTargetsBefore = await this.organizeManager.getAutoOrganizeTargets(libraryItems)

    req.series.set(payload)
    if (req.series.changed()) {
      await req.series.save()
      SocketAuthority.emitter('series_updated', req.series.toOldJSON())
    }
    if (isRename) {
      Database.removeSeriesFromFilterData(req.series.libraryId, req.series.id)
      Database.addSeriesToFilterData(req.series.libraryId, req.series.name, req.series.id)
    }

    if (isRename) {
      // Keep metadata.json in step, since a later scan reads it
      const renamedLibraryItems = await Database.seriesModel.getAllLibraryItemsForSeries(req.series.id)
      for (const libraryItem of renamedLibraryItems) {
        await libraryItem.saveMetadataFile()
      }
      if (renamedLibraryItems.length) SocketAuthority.libraryItemsEmitter('items_updated', renamedLibraryItems)
    }
    res.json(req.series.toOldJSON())

    // Runs after the response because moving and rescanning many books is slow
    this.organizeManager.autoOrganizeItemsInBackground(organizeTargetsBefore)
  }

  /**
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    const series = await Database.seriesModel.findByPk(req.params.id)
    if (!series) return res.sendStatus(404)

    /**
     * Filter out any library items not accessible to user
     */
    const libraryItems = await libraryItemsBookFilters.getLibraryItemsForSeries(series, req.user)
    if (!libraryItems.length) {
      Logger.warn(`[SeriesController] User "${req.user.username}" attempted to access series "${series.id}" with no accessible books`)
      return res.sendStatus(404)
    }

    if (req.method == 'DELETE' && !req.user.canDelete) {
      Logger.warn(`[SeriesController] User "${req.user.username}" attempted to delete without permission`)
      return res.sendStatus(403)
    } else if ((req.method == 'PATCH' || req.method == 'POST') && !req.user.canUpdate) {
      Logger.warn(`[SeriesController] User "${req.user.username}" attempted to update without permission`)
      return res.sendStatus(403)
    }

    req.series = series
    req.libraryItemsInSeries = libraryItems
    next()
  }
}
module.exports = new SeriesController()
