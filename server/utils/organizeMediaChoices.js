const fs = require('../libs/fsExtra')
const Database = require('../Database')
const { getMovedPath } = require('./organizePlan')

/**
 * Settings of a book that a rescan of moved files resets: the scan takes them from the files, not from the book.
 *
 * @typedef MediaChoices
 * @property {{path:string, exclude:boolean, index:number, manuallyVerified:boolean}[]} audioFiles
 * @property {string|null} ebookPath Path of the primary ebook
 * @property {string|null} coverPath
 */

/**
 * @param {import('../models/Book')} media
 * @returns {MediaChoices}
 */
function captureMediaChoices(media) {
  return {
    audioFiles: media.audioFiles.map((audioFile) => ({
      path: audioFile.metadata.path,
      exclude: !!audioFile.exclude,
      index: audioFile.index,
      manuallyVerified: !!audioFile.manuallyVerified
    })),
    ebookPath: media.ebookFile?.metadata.path || null,
    coverPath: media.coverPath || null
  }
}

/**
 * @param {import('../models/Book')} media
 * @param {MediaChoices['audioFiles']} savedAudioFiles
 * @param {import('./organizePlan').OrganizeMove[]} moves
 * @returns {boolean} True when the audio files changed
 */
function restoreAudioFileChoices(media, savedAudioFiles, moves) {
  const savedByPath = new Map(savedAudioFiles.map((saved) => [getMovedPath(saved.path, moves), saved]))
  const audioFilesBefore = JSON.stringify(media.audioFiles)
  for (const audioFile of media.audioFiles) {
    const saved = savedByPath.get(audioFile.metadata.path)
    if (!saved) continue
    audioFile.exclude = saved.exclude
    audioFile.index = saved.index
    audioFile.manuallyVerified = saved.manuallyVerified
  }
  media.audioFiles = [...media.audioFiles].sort((a, b) => a.index - b.index)
  return JSON.stringify(media.audioFiles) !== audioFilesBefore
}

/**
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {string} savedEbookPath
 * @param {import('./organizePlan').OrganizeMove[]} moves
 */
async function restorePrimaryEbook(libraryItem, savedEbookPath, moves) {
  const ebookPath = getMovedPath(savedEbookPath, moves)
  if (libraryItem.media.ebookFile?.metadata.path === ebookPath) return
  const ebookLibraryFile = libraryItem.getLibraryFiles().find((libraryFile) => libraryFile.isEBookFile && libraryFile.metadata.path === ebookPath)
  if (ebookLibraryFile) await libraryItem.setPrimaryEbookFile(ebookLibraryFile)
}

/**
 * Put the settings captured before the moves back on the book after the rescan. Files are matched by where the moves took them.
 * Files the capture does not know keep what the scan found.
 *
 * @param {string} libraryItemId
 * @param {MediaChoices} choices
 * @param {import('./organizePlan').OrganizeMove[]} moves
 * @returns {Promise<void>}
 */
async function restoreMediaChoices(libraryItemId, choices, moves) {
  const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
  const media = libraryItem.media

  let hasMediaChanges = restoreAudioFileChoices(media, choices.audioFiles, moves)
  if (hasMediaChanges) media.changed('audioFiles', true)

  const coverPath = choices.coverPath && getMovedPath(choices.coverPath, moves)
  if (coverPath && media.coverPath !== coverPath && (await fs.pathExists(coverPath))) {
    media.coverPath = coverPath
    hasMediaChanges = true
  }
  if (hasMediaChanges) await media.save()

  if (choices.ebookPath) await restorePrimaryEbook(libraryItem, choices.ebookPath, moves)
}

module.exports = { captureMediaChoices, restoreMediaChoices }
