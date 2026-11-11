const Path = require('path')
const crypto = require('crypto')
const fs = require('../libs/fsExtra')
const { filePathToPOSIX, isSameOrSubPath } = require('./fileUtils')
const { getBookDataFromDir } = require('./scandir')
const { getTemplateValues, renderFolderSegments, renderFileName, formatTrackNumber } = require('./organizeTemplate')

/**
 * @typedef OrganizeMove
 * @property {string} from Absolute POSIX path
 * @property {string} to Absolute POSIX path
 *
 * @typedef OrganizeWarning
 * @property {string} field Metadata field the scanner would read differently from the new folder path
 * @property {string} expected Current value
 * @property {string} parsed Value the scanner would read
 *
 * @typedef OrganizePlan
 * @property {string} itemId
 * @property {string} title
 * @property {string} fromPath
 * @property {string} toPath
 * @property {string} fromRelPath
 * @property {string} toRelPath
 * @property {{from:string, to:string}[]} fileRenames Paths relative to the item folder, for display
 * @property {OrganizeMove[]} moves Steps in execution order
 * @property {OrganizeWarning[]} warnings
 * @property {string|null} skipReason
 * @property {boolean} changed
 * @property {string|null} hash Identifies the moves so a confirmed run can detect a changed plan
 */

/**
 * @param {import('../models/Book')} media Book with authors and series loaded
 * @returns {import('./organizeTemplate').TemplateMetadata}
 */
function getTemplateMetadata(media) {
  return {
    title: media.title,
    subtitle: media.subtitle,
    authors: media.authors.map((author) => author.name),
    series: media.series.map((series) => ({ name: series.name, sequence: series.bookSeries?.sequence })),
    narrators: media.narrators,
    publishedYear: media.publishedYear,
    asin: media.asin,
    isbn: media.isbn,
    publisher: media.publisher
  }
}

/**
 * Audio files in playback order followed by the ebook, each with the values for the file template
 *
 * @param {import('../models/Book')} media
 * @returns {{path:string, filename:string, ext:string, fileValues:{track?:string, disc?:string}}[]}
 */
function getFilesToRename(media) {
  const audioFiles = [...media.audioFiles].sort((a, b) => a.index - b.index)
  const files = audioFiles.map((audioFile, i) => {
    const disc = audioFile.discNumFromMeta ?? audioFile.discNumFromFilename
    return {
      path: audioFile.metadata.path,
      filename: audioFile.metadata.filename,
      ext: audioFile.metadata.ext,
      fileValues: { track: formatTrackNumber(i + 1, audioFiles.length), disc: disc === null || disc === undefined ? '' : String(disc) }
    }
  })
  if (media.ebookFile) {
    const { path, filename, ext } = media.ebookFile.metadata
    files.push({ path, filename, ext, fileValues: {} })
  }
  return files
}

/**
 * Metadata the scanner would read from the new folder path when it differs from the current metadata
 *
 * @param {import('../models/Book')} media
 * @param {string} toRelPath
 * @returns {OrganizeWarning[]}
 */
function getParseWarnings(media, toRelPath) {
  const parsed = getBookDataFromDir(toRelPath, !!global.ServerSettings?.scannerParseSubtitle)
  const currentSeries = media.series[0]
  const lowerJoin = (names) => (names || []).map((name) => name.toLowerCase()).join(', ')
  const candidates = [
    { field: 'title', expected: media.title, parsed: parsed.title },
    { field: 'subtitle', expected: media.subtitle, parsed: parsed.subtitle },
    { field: 'authors', expected: lowerJoin(media.authors.map((author) => author.name)), parsed: lowerJoin(parsed.authors), display: media.authorName },
    { field: 'series', expected: currentSeries?.name, parsed: parsed.seriesName },
    { field: 'sequence', expected: currentSeries?.bookSeries?.sequence, parsed: parsed.seriesSequence },
    { field: 'publishedYear', expected: media.publishedYear, parsed: parsed.publishedYear },
    { field: 'asin', expected: media.asin, parsed: parsed.asin },
    { field: 'narrators', expected: lowerJoin(media.narrators), parsed: lowerJoin(parsed.narrators), display: (media.narrators || []).join(', ') }
  ]
  return candidates.filter((candidate) => candidate.parsed && String(candidate.parsed) !== String(candidate.expected || '')).map((candidate) => ({ field: candidate.field, expected: String(candidate.display ?? candidate.expected ?? ''), parsed: String(candidate.parsed) }))
}

/**
 * @param {string} path
 * @returns {Promise<{dev:number, ino:number}|null>}
 */
async function statIdentity(path) {
  const stat = await fs.stat(path).catch(() => null)
  return stat ? { dev: stat.dev, ino: stat.ino } : null
}

/**
 * True when a different file or folder already exists at the path.
 * The same file under another letter case (case-insensitive file systems) is not a conflict.
 *
 * @param {string|null} fromPath Null when nothing at the target path may be treated as the same file
 * @param {string} toPath
 * @returns {Promise<boolean>}
 */
async function isPathTakenByOther(fromPath, toPath) {
  const target = await statIdentity(toPath)
  if (!target) return false
  const source = fromPath ? await statIdentity(fromPath) : null
  return !(source && source.dev === target.dev && source.ino === target.ino)
}

/**
 * Moves that put the cover and metadata file stored in the server metadata folder next to the book.
 * Only for single-file items; they are the ones that have no folder of their own until organized.
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {string} toPath
 * @returns {Promise<OrganizeMove[]>}
 */
async function getMetadataFolderMoves(libraryItem, toPath) {
  const metadataFolder = Path.posix.join(filePathToPOSIX(global.MetadataPath), 'items', libraryItem.id)
  const candidates = []
  const coverPath = libraryItem.media.coverPath
  if (global.ServerSettings.storeCoverWithItem && coverPath && Path.posix.dirname(filePathToPOSIX(coverPath)) === metadataFolder) {
    candidates.push(filePathToPOSIX(coverPath))
  }
  if (global.ServerSettings.storeMetadataWithItem) {
    candidates.push(Path.posix.join(metadataFolder, `metadata.${global.ServerSettings.metadataFileFormat}`))
  }

  const moves = []
  for (const from of candidates) {
    if (await fs.pathExists(from)) moves.push({ from, to: Path.posix.join(toPath, Path.posix.basename(from)) })
  }
  return moves
}

/**
 * Moves that rename files in place, or for a single-file item move the file into the new folder
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {string} toPath
 * @param {string} fileTemplate
 * @param {Object<string,string>} values
 * @returns {OrganizeMove[]}
 */
function getFileMoves(libraryItem, toPath, fileTemplate, values) {
  const moves = []
  for (const file of getFilesToRename(libraryItem.media)) {
    const newName = renderFileName(fileTemplate, { ...values, ...file.fileValues }, file.ext) || file.filename
    if (libraryItem.isFile) {
      if (file.path === libraryItem.path) moves.push({ from: file.path, to: Path.posix.join(toPath, newName) })
    } else if (newName !== file.filename) {
      moves.push({ from: file.path, to: Path.posix.join(Path.posix.dirname(file.path), newName) })
    }
  }
  return moves
}

/**
 * @param {OrganizeMove[]} moves
 * @returns {Promise<boolean>} True when two moves share a destination or a destination is taken
 */
async function hasFileNameConflict(moves) {
  const destinations = moves.map((move) => move.to.toLowerCase())
  if (new Set(destinations).size !== destinations.length) return true
  for (const move of moves) {
    if (await isPathTakenByOther(move.from, move.to)) return true
  }
  return false
}

/**
 * Paths relative to the item folder for display (the file name for a single-file item)
 *
 * @param {OrganizeMove[]} moves
 * @param {string} fromPath
 * @param {string} toPath
 * @param {boolean} isFile
 * @returns {{from:string, to:string}[]}
 */
function getDisplayRenames(moves, fromPath, toPath, isFile) {
  return moves.map((move) => ({
    from: isFile ? Path.posix.basename(move.from) : Path.posix.relative(fromPath, move.from),
    to: isFile ? Path.posix.relative(toPath, move.to) : Path.posix.relative(fromPath, move.to)
  }))
}

/**
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {import('../models/Library')} library
 * @returns {Promise<string|null>}
 */
async function getUnorganizableReason(libraryItem, library) {
  if (!libraryItem.isBook) return 'notBook'
  const hasLibraryFolder = library.libraryFolders.some((folder) => folder.id === libraryItem.libraryFolderId)
  if (libraryItem.isMissing || !hasLibraryFolder || !(await fs.pathExists(libraryItem.path))) return 'missing'
  return null
}

/**
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {OrganizePlan} plan Has fromPath and toPath set
 * @param {OrganizeMove[]} fileMoves
 * @returns {Promise<string|null>}
 */
async function getConflictReason(libraryItem, plan, fileMoves) {
  const isFolderChanged = libraryItem.isFile || plan.toPath !== plan.fromPath
  const isNested = isSameOrSubPath(plan.fromPath, plan.toPath) || isSameOrSubPath(plan.toPath, plan.fromPath)
  if (isFolderChanged && !libraryItem.isFile && isNested) return 'targetNested'

  // A single-file item has no folder, so anything at the target path is in the way, even the item file itself
  if (isFolderChanged && (await isPathTakenByOther(libraryItem.isFile ? null : plan.fromPath, plan.toPath))) return 'targetExists'

  if (!libraryItem.isFile && (await hasFileNameConflict(fileMoves))) return 'fileNameConflict'
  return null
}

/**
 * Work out what organizing a book would do. Only reads the file system to check for conflicts.
 * Skip reasons that depend on manager state (scanning, streaming) are not decided here.
 *
 * @param {import('../models/LibraryItem')} libraryItem Expanded book library item
 * @param {import('../models/Library')} library Library with folders
 * @returns {Promise<OrganizePlan>}
 */
async function buildPlan(libraryItem, library) {
  const media = libraryItem.media
  const fromPath = filePathToPOSIX(libraryItem.path)
  /** @type {OrganizePlan} */
  const plan = { itemId: libraryItem.id, title: media.title, fromPath, toPath: fromPath, fromRelPath: libraryItem.relPath, toRelPath: libraryItem.relPath, fileRenames: [], moves: [], warnings: [], skipReason: null, changed: false, hash: null }

  plan.skipReason = await getUnorganizableReason(libraryItem, library)
  if (plan.skipReason) return plan

  const { organizeFolderTemplate, organizeFileTemplate } = library.librarySettings
  const values = getTemplateValues(getTemplateMetadata(media))
  let fileMoves
  try {
    const segments = renderFolderSegments(organizeFolderTemplate, values)
    if (!segments.length) {
      plan.skipReason = 'emptyFolderName'
      return plan
    }
    const libraryFolder = library.libraryFolders.find((folder) => folder.id === libraryItem.libraryFolderId)
    plan.toRelPath = segments.join('/')
    plan.toPath = Path.posix.join(filePathToPOSIX(libraryFolder.path), plan.toRelPath)
    fileMoves = getFileMoves(libraryItem, plan.toPath, organizeFileTemplate, values)
  } catch (error) {
    plan.skipReason = 'invalidTemplate'
    return plan
  }

  plan.skipReason = await getConflictReason(libraryItem, plan, fileMoves)
  if (plan.skipReason) return plan

  plan.moves = [...fileMoves]
  if (libraryItem.isFile) {
    plan.moves.push(...(await getMetadataFolderMoves(libraryItem, plan.toPath)))
  } else if (plan.toPath !== fromPath) {
    plan.moves.push({ from: fromPath, to: plan.toPath })
  }
  plan.changed = plan.moves.length > 0
  if (!plan.changed) return plan

  plan.fileRenames = getDisplayRenames(fileMoves, fromPath, plan.toPath, libraryItem.isFile)
  plan.warnings = getParseWarnings(media, plan.toRelPath)
  plan.hash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ fromPath, toPath: plan.toPath, moves: plan.moves }))
    .digest('hex')
  return plan
}

/**
 * @param {OrganizePlan} plan
 * @returns {Object} Plan fields the client needs
 */
function planToClientJSON(plan) {
  const { itemId, title, fromRelPath, toRelPath, fileRenames, warnings, skipReason, changed, hash } = plan
  return { itemId, title, fromRelPath, toRelPath, fileRenames, warnings, skipReason, changed, hash }
}

module.exports = { buildPlan, planToClientJSON }
