const Path = require('path')
const crypto = require('crypto')
const fs = require('../libs/fsExtra')
const Database = require('../Database')
const { filePathToPOSIX, isSameOrSubPath, isPathTakenByOther, getPathsBelowLibraryFolder } = require('./fileUtils')
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
 * @property {string|null} hash Identifies the moves
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
 * Playable audio files in play order, then the ebook, with their file template values.
 * Excluded audio files keep their names.
 *
 * @param {import('../models/LibraryItem')} libraryItem Book library item
 * @returns {{path:string, filename:string, ext:string, fileValues:{track?:string, disc?:string}}[]}
 */
function getFilesToRename(libraryItem) {
  const { media, isFile } = libraryItem
  const audioFiles = media.audioFiles.filter((audioFile) => isFile || !audioFile.exclude).sort((a, b) => a.index - b.index)
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
 * Where the templates put the book. Throws when a template is invalid.
 *
 * @param {import('../models/LibraryItem')} libraryItem Book library item
 * @param {{organizeFolderTemplate:string, organizeFileTemplate:string}} templates
 * @returns {{segments:string[], files:{path:string, filename:string, newName:string}[]}} Folder segments below the library folder and the new name of each file
 */
function renderTarget(libraryItem, { organizeFolderTemplate, organizeFileTemplate }) {
  const values = getTemplateValues(getTemplateMetadata(libraryItem.media))
  const segments = renderFolderSegments(organizeFolderTemplate, values)
  const files = getFilesToRename(libraryItem).map((file) => ({
    path: file.path,
    filename: file.filename,
    newName: renderFileName(organizeFileTemplate, { ...values, ...file.fileValues }, file.ext) || file.filename
  }))
  return { segments, files }
}

/**
 * Comparable value for where the templates put the book. Tells whether an edit moved the target.
 *
 * @param {import('../models/LibraryItem')} libraryItem Book library item with authors and series loaded
 * @param {import('../models/Library').LibrarySettingsObject} librarySettings
 * @returns {string|null} Null when the templates are invalid
 */
function getRenderedTargetKey(libraryItem, librarySettings) {
  try {
    const { segments, files } = renderTarget(libraryItem, librarySettings)
    return JSON.stringify({ segments, names: files.map((file) => file.newName) })
  } catch (error) {
    return null
  }
}

/**
 * Metadata fields the scanner would read differently from the new folder path
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
 * Moves for the cover and metadata file in the server metadata folder.
 * Only single-file items have no folder of their own.
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
 * Moves that rename files in place. A single-file item moves into the new folder instead.
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {string} toPath
 * @param {{path:string, filename:string, newName:string}[]} files
 * @returns {OrganizeMove[]}
 */
function getFileMoves(libraryItem, toPath, files) {
  const moves = []
  for (const file of files) {
    if (libraryItem.isFile) {
      if (file.path === libraryItem.path) moves.push({ from: file.path, to: Path.posix.join(toPath, file.newName) })
    } else if (file.newName !== file.filename) {
      moves.push({ from: file.path, to: Path.posix.join(Path.posix.dirname(file.path), file.newName) })
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
 * Display paths relative to the item folder, without renames that change nothing
 *
 * @param {OrganizeMove[]} moves
 * @param {string} fromPath
 * @param {string} toPath
 * @param {boolean} isFile
 * @returns {{from:string, to:string}[]}
 */
function getDisplayRenames(moves, fromPath, toPath, isFile) {
  return moves
    .map((move) => ({
      from: isFile ? Path.posix.basename(move.from) : Path.posix.relative(fromPath, move.from),
      to: isFile ? Path.posix.relative(toPath, move.to) : Path.posix.relative(fromPath, move.to)
    }))
    .filter((rename) => rename.from !== rename.to)
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
 * Whether a library item lives in a folder above the path
 *
 * @param {string} libraryFolderPath
 * @param {string} path
 * @param {Set<string>|null} libraryItemPaths Paths of all items in the library. Looked up in the database when null
 * @returns {Promise<boolean>}
 */
async function isInsideAnotherItem(libraryFolderPath, path, libraryItemPaths) {
  if (!libraryItemPaths) return !!(await Database.libraryItemModel.findByAncestorPath(libraryFolderPath, path))
  return getPathsBelowLibraryFolder(libraryFolderPath, path)
    .slice(1)
    .some((ancestorPath) => libraryItemPaths.has(ancestorPath))
}

/**
 * Whether a library item has exactly the path, even when it is missing from disk.
 * Callers MUST only pass a target path that differs from the path of the item being organized.
 *
 * @param {string} path
 * @param {Set<string>|null} libraryItemPaths Paths of all items in the library. Looked up in the database when null
 * @returns {Promise<boolean>}
 */
async function isPathOfLibraryItem(path, libraryItemPaths) {
  if (!libraryItemPaths) return !!(await Database.libraryItemModel.findOne({ where: { path }, attributes: ['id'] }))
  return libraryItemPaths.has(path)
}

/**
 * @param {string} libraryFolderPath
 * @param {string} toPath A target path that differs from the path of the item being organized
 * @param {Set<string>|null} libraryItemPaths Paths of all items in the library. Looked up in the database when null
 * @returns {Promise<'targetInsideItem'|'targetExists'|null>} Skip reason for a target that another library item holds
 */
async function getTargetItemReason(libraryFolderPath, toPath, libraryItemPaths) {
  if (await isInsideAnotherItem(libraryFolderPath, toPath, libraryItemPaths)) return 'targetInsideItem'
  if (await isPathOfLibraryItem(toPath, libraryItemPaths)) return 'targetExists'
  return null
}

/**
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {import('../models/Library')} library Library with folders
 * @returns {string}
 */
function getLibraryFolderPath(libraryItem, library) {
  return filePathToPOSIX(library.libraryFolders.find((folder) => folder.id === libraryItem.libraryFolderId).path)
}

/**
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {OrganizePlan} plan Has fromPath and toPath set
 * @returns {boolean} False when the plan only renames files in place
 */
function isFolderChanged(libraryItem, plan) {
  return libraryItem.isFile || plan.toPath !== plan.fromPath
}

/**
 * Like the target check of buildPlan, but against the database. A list of item paths can miss new items.
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {import('../models/Library')} library Library with folders
 * @param {OrganizePlan} plan
 * @returns {Promise<'targetInsideItem'|'targetExists'|null>}
 */
async function getPlanTargetItemReason(libraryItem, library, plan) {
  if (!isFolderChanged(libraryItem, plan)) return null
  return getTargetItemReason(getLibraryFolderPath(libraryItem, library), plan.toPath, null)
}

/**
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {OrganizePlan} plan Has fromPath and toPath set
 * @param {OrganizeMove[]} fileMoves
 * @param {{libraryFolderPath:string, libraryItemPaths:Set<string>|null}} library Paths of all items in the library are looked up in the database when null
 * @returns {Promise<string|null>}
 */
async function getConflictReason(libraryItem, plan, fileMoves, { libraryFolderPath, libraryItemPaths }) {
  const hasFolderChange = isFolderChanged(libraryItem, plan)
  const isNested = isSameOrSubPath(plan.fromPath, plan.toPath) || isSameOrSubPath(plan.toPath, plan.fromPath)
  if (hasFolderChange && !libraryItem.isFile && isNested) return 'targetNested'
  const targetItemReason = hasFolderChange ? await getTargetItemReason(libraryFolderPath, plan.toPath, libraryItemPaths) : null
  if (targetItemReason) return targetItemReason

  // Anything at the target blocks a single-file item, including itself
  if (hasFolderChange && (await isPathTakenByOther(libraryItem.isFile ? null : plan.fromPath, plan.toPath))) return 'targetExists'

  if (!libraryItem.isFile && (await hasFileNameConflict(fileMoves))) return 'fileNameConflict'
  return null
}

/**
 * Work out what organizing a book would do without changing anything.
 * Skip reasons that depend on manager state (scanning, streaming) are not decided here.
 *
 * @param {import('../models/LibraryItem')} libraryItem Expanded book library item
 * @param {import('../models/Library')} library Library with folders
 * @param {Set<string>|null} [libraryItemPaths] Paths of all items in the library, to avoid a database lookup for each item
 * @returns {Promise<OrganizePlan>}
 */
async function buildPlan(libraryItem, library, libraryItemPaths = null) {
  const media = libraryItem.media
  const fromPath = filePathToPOSIX(libraryItem.path)
  /** @type {OrganizePlan} */
  const plan = { itemId: libraryItem.id, title: media.title, fromPath, toPath: fromPath, fromRelPath: libraryItem.relPath, toRelPath: libraryItem.relPath, fileRenames: [], moves: [], warnings: [], skipReason: null, changed: false, hash: null }

  plan.skipReason = await getUnorganizableReason(libraryItem, library)
  if (plan.skipReason) return plan

  const libraryFolderPath = getLibraryFolderPath(libraryItem, library)
  let fileMoves
  try {
    const { segments, files } = renderTarget(libraryItem, library.librarySettings)
    if (!segments.length) {
      plan.skipReason = 'emptyFolderName'
      return plan
    }
    plan.toRelPath = segments.join('/')
    plan.toPath = Path.posix.join(libraryFolderPath, plan.toRelPath)
    fileMoves = getFileMoves(libraryItem, plan.toPath, files)
  } catch (error) {
    plan.skipReason = 'invalidTemplate'
    return plan
  }

  plan.skipReason = await getConflictReason(libraryItem, plan, fileMoves, { libraryFolderPath, libraryItemPaths })
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
 * Where a path ends up after the moves, applied in order. Moving a folder moves the paths inside it.
 *
 * @param {string} path
 * @param {OrganizeMove[]} moves
 * @returns {string}
 */
function getMovedPath(path, moves) {
  let movedPath = path
  for (const move of moves) {
    if (movedPath === move.from) movedPath = move.to
    else if (movedPath.startsWith(`${move.from}/`)) movedPath = move.to + movedPath.slice(move.from.length)
  }
  return movedPath
}

/**
 * @param {OrganizePlan} plan
 * @returns {Object} Plan fields the client needs
 */
function planToClientJSON(plan) {
  const { itemId, title, fromPath, toPath, fromRelPath, toRelPath, fileRenames, warnings, skipReason, changed, hash } = plan
  return { itemId, title, fromPath, toPath, fromRelPath, toRelPath, fileRenames, warnings, skipReason, changed, hash }
}

module.exports = { buildPlan, getPlanTargetItemReason, getMovedPath, getRenderedTargetKey, planToClientJSON }
