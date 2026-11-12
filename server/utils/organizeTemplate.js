const Path = require('path')
const { sanitizeFilename } = require('./fileUtils')
const { checkFilepathIsAudioFile } = require('./scandir')
const globals = require('./globals')
const { nameToLastFirst } = require('./parsers/parseNameString')

const DEFAULT_FOLDER_TEMPLATE = '{author}/{series}/<{sequence}. >{title}'
const DEFAULT_FILE_TEMPLATE = '{title}< - Part {track}>'

const FOLDER_TOKENS = [...['author', 'authors', 'authorSort', 'authorInitial', 'series', 'sequence', 'sequencePadded', 'title', 'titleThe', 'subtitle'], ...['year', 'publishedDate', 'narrator', 'narrators', 'genre', 'genres', 'language', 'abridged', 'explicit'], ...['asin', 'isbn', 'publisher', 'codec', 'bitrate', 'channels']]
const FILE_TOKENS = [...FOLDER_TOKENS, 'track', 'trackTotal', 'trackTitle', 'disc', 'originalName']
const SEQUENCE_PAD_LENGTH = 2
const MAX_TEMPLATE_LENGTH = 500

/**
 * @typedef {{type:'text', value:string}|{type:'token', name:string}|{type:'group', nodes:TemplateNode[]}} TemplateNode
 *
 * @typedef TemplateMetadata
 * @property {string} [title]
 * @property {string} [titleIgnorePrefix] Title with a leading "The", "A" or "An" moved to the end
 * @property {string} [subtitle]
 * @property {string[]} [authors]
 * @property {{name:string, sequence?:string|null}[]} [series]
 * @property {string[]} [narrators]
 * @property {string[]} [genres]
 * @property {string|number} [publishedYear]
 * @property {string} [publishedDate]
 * @property {string} [language]
 * @property {boolean} [abridged]
 * @property {boolean} [explicit]
 * @property {string} [asin]
 * @property {string} [isbn]
 * @property {string} [publisher]
 * @property {string} [codec] Codec of the first audio file
 * @property {number} [bitRate] Bits per second of the first audio file
 * @property {number} [channels] Channel count of the first audio file
 *
 * @typedef TemplateFileValues
 * @property {string} [track]
 * @property {string} [trackTotal]
 * @property {string} [trackTitle]
 * @property {string} [disc]
 * @property {string} [originalName] File name without the extension
 */

/**
 * @param {string} lexeme A "{name}" token, a lone "{" or "}", or plain text
 * @param {string[]} allowedTokens
 * @returns {TemplateNode}
 */
function lexemeToNode(lexeme, allowedTokens) {
  if (lexeme === '{') throw new Error('Unbalanced "{" in template')
  if (lexeme === '}') throw new Error('Unbalanced "}" in template')
  if (!lexeme.startsWith('{')) return { type: 'text', value: lexeme }

  const name = lexeme.slice(1, -1)
  if (!allowedTokens.includes(name)) throw new Error(`Unknown token "${lexeme}"`)
  return { type: 'token', name }
}

/**
 * @param {unknown} template
 */
function assertTemplateText(template) {
  if (typeof template !== 'string' || !template.trim()) {
    throw new Error('Template must be a non-empty string')
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`Template must be at most ${MAX_TEMPLATE_LENGTH} characters`)
  }
}

/**
 * Split a template into text, token and optional group nodes. Throws on invalid syntax.
 *
 * @param {string} template
 * @param {string[]} allowedTokens
 * @returns {TemplateNode[]}
 */
function parseTemplate(template, allowedTokens) {
  assertTemplateText(template)

  const root = []
  /** @type {TemplateNode[]|null} */
  let groupNodes = null
  for (const lexeme of template.match(/\{[^{}<>]*\}|[<>{}]|[^{}<>]+/g)) {
    if (lexeme === '<') {
      if (groupNodes) throw new Error('Optional groups "<...>" cannot be nested')
      groupNodes = []
    } else if (lexeme === '>') {
      if (!groupNodes) throw new Error('Unbalanced ">" in template')
      root.push({ type: 'group', nodes: groupNodes })
      groupNodes = null
    } else {
      ;(groupNodes || root).push(lexemeToNode(lexeme, allowedTokens))
    }
  }
  if (groupNodes) throw new Error('Unbalanced "<" in template')

  if (!flattenNodes(root).some((node) => node.type === 'token')) {
    throw new Error('Template must contain at least one token')
  }
  return root
}

/**
 * @param {string} template
 * @returns {TemplateNode[]}
 */
function parseFolderTemplate(template) {
  const nodes = parseTemplate(template, FOLDER_TOKENS)
  if (template.includes('\\')) throw new Error('Folder template must use "/" as the path separator')
  if (template.startsWith('/') || /^[a-zA-Z]:/.test(template)) throw new Error('Folder template must be a relative path')
  if (
    template
      .replace(/[<>]/g, '')
      .split('/')
      .some((segment) => segment.trim() === '..' || segment.trim() === '.')
  ) {
    throw new Error('Folder template cannot contain "." or ".." segments')
  }
  return nodes
}

/**
 * @param {string} template
 * @returns {TemplateNode[]}
 */
function parseFileTemplate(template) {
  const nodes = parseTemplate(template, FILE_TOKENS)
  if (/[\/\\]/.test(template)) throw new Error('File template cannot contain path separators')
  return nodes
}

/**
 * @param {TemplateNode[]} nodes
 * @returns {TemplateNode[]}
 */
function flattenNodes(nodes) {
  return nodes.flatMap((node) => (node.type === 'group' ? node.nodes : [node]))
}

/**
 * Render nodes with token values. A group renders empty when any token inside it is empty.
 *
 * @param {TemplateNode[]} nodes
 * @param {Object<string,string>} values
 * @returns {string}
 */
function renderNodes(nodes, values) {
  let output = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      output += node.value
    } else if (node.type === 'token') {
      output += values[node.name] || ''
    } else {
      const isGroupComplete = node.nodes.every((child) => child.type !== 'token' || values[child.name])
      if (isGroupComplete) output += renderNodes(node.nodes, values)
    }
  }
  return output
}

const TEMPLATE_PARSERS = { organizeFolderTemplate: parseFolderTemplate, organizeFileTemplate: parseFileTemplate }
const TEMPLATE_SETTING_KEYS = Object.keys(TEMPLATE_PARSERS)

/**
 * @param {'organizeFolderTemplate'|'organizeFileTemplate'} key Library setting key
 * @param {string} template
 * @returns {string|null} Error message or null when the template is valid
 */
function getTemplateSettingError(key, template) {
  try {
    TEMPLATE_PARSERS[key](template)
    return null
  } catch (error) {
    return error.message
  }
}

/**
 * Leading number of a series sequence zero-padded, so "2" sorts before "10" and "1.5" becomes "01.5".
 *
 * @param {string} sequence
 * @returns {string}
 */
function padSequence(sequence) {
  return sequence.replace(/^\d+/, (digits) => digits.padStart(SEQUENCE_PAD_LENGTH, '0'))
}

const cleanValue = (value) => sanitizeFilename(String(value ?? '')) || ''
const cleanValues = (values) => (values || []).map(cleanValue).filter(Boolean)

/**
 * @param {TemplateMetadata} metadata
 * @returns {Object<string,string>}
 */
function getAuthorValues(metadata) {
  const authors = cleanValues(metadata.authors)
  const authorSort = authors[0] ? cleanValue(nameToLastFirst(metadata.authors.find((name) => cleanValue(name)))) : ''
  return {
    author: authors[0] || '',
    authors: authors.join(', '),
    authorSort,
    authorInitial: Array.from(authorSort)[0]?.toUpperCase() || ''
  }
}

/**
 * @param {TemplateMetadata} metadata
 * @returns {Object<string,string>}
 */
function getAudioValues(metadata) {
  return {
    codec: cleanValue(metadata.codec),
    bitrate: metadata.bitRate ? String(Math.round(metadata.bitRate / 1000)) : '',
    channels: cleanValue(metadata.channels)
  }
}

/**
 * Token values for a book. Missing details are empty strings so their template groups drop out.
 *
 * @param {TemplateMetadata} metadata
 * @param {TemplateFileValues} [fileValues]
 * @returns {Object<string,string>}
 */
function getTemplateValues(metadata, fileValues = {}) {
  const genres = cleanValues(metadata.genres)
  const firstSeries = metadata.series?.[0]
  const sequence = cleanValue(firstSeries?.sequence)
  return {
    ...getAuthorValues(metadata),
    ...getAudioValues(metadata),
    series: cleanValue(firstSeries?.name),
    sequence,
    sequencePadded: padSequence(sequence),
    title: cleanValue(metadata.title),
    titleThe: cleanValue(metadata.titleIgnorePrefix),
    subtitle: cleanValue(metadata.subtitle),
    year: cleanValue(metadata.publishedYear),
    publishedDate: cleanValue(metadata.publishedDate),
    narrator: cleanValue(metadata.narrators?.[0]),
    narrators: cleanValues(metadata.narrators).join(', '),
    genre: genres[0] || '',
    genres: genres.join(', '),
    language: cleanValue(metadata.language),
    abridged: metadata.abridged ? 'Abridged' : '',
    explicit: metadata.explicit ? 'Explicit' : '',
    asin: cleanValue(metadata.asin),
    isbn: cleanValue(metadata.isbn),
    publisher: cleanValue(metadata.publisher),
    track: fileValues.track || '',
    trackTotal: fileValues.trackTotal || '',
    trackTitle: cleanValue(fileValues.trackTitle),
    disc: fileValues.disc || '',
    originalName: cleanValue(fileValues.originalName)
  }
}

/**
 * Render the folder template to path segments (relative to the library folder).
 * Segments that render empty are dropped.
 *
 * @param {string} template
 * @param {Object<string,string>} values
 * @returns {string[]}
 */
function renderFolderSegments(template, values) {
  return renderNodes(parseFolderTemplate(template), values)
    .split('/')
    .map((segment) => sanitizeFilename(segment.trim()))
    .filter(Boolean)
}

/**
 * Render the file template to a file name with the given extension.
 *
 * @param {string} template
 * @param {Object<string,string>} values
 * @param {string} ext Extension including the leading dot
 * @returns {string} Empty string when the template renders no name
 */
function renderFileName(template, values, ext) {
  const baseName = renderNodes(parseFileTemplate(template), values).trim()
  if (!baseName) return ''
  return sanitizeFilename(baseName + ext) || ''
}

/**
 * Track number for a file, zero-padded to the width of the file count. Empty for single-file books.
 *
 * @param {number} position 1-based position in playback order
 * @param {number} count
 * @returns {string}
 */
function formatTrackNumber(position, count) {
  if (count < 2) return ''
  return String(position).padStart(String(count).length, '0')
}

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

/**
 * New names for uploaded audio files (numbered in natural sort order) and a lone ebook.
 * Returns no renames when the new names would collide.
 *
 * @param {string} fileTemplate
 * @param {TemplateMetadata} metadata
 * @param {string[]} uploadedNames
 * @returns {Map<string,string>} Uploaded name to new name, only for files that are renamed
 */
function getUploadedFileNames(fileTemplate, metadata, uploadedNames) {
  const extOf = (name) => Path.extname(name).slice(1).toLowerCase()
  const audioNames = uploadedNames.filter(checkFilepathIsAudioFile).sort(naturalCompare)
  const ebookNames = uploadedNames.filter((name) => globals.SupportedEbookTypes.includes(extOf(name)))

  const renderUploadedName = (name, fileValues) => {
    const ext = Path.extname(name)
    const values = getTemplateValues(metadata, { ...fileValues, originalName: Path.basename(name, ext) })
    return renderFileName(fileTemplate, values, ext) || sanitizeFilename(name)
  }

  const newNames = new Map()
  audioNames.forEach((name, i) => {
    const trackTotal = audioNames.length > 1 ? String(audioNames.length) : ''
    newNames.set(name, renderUploadedName(name, { track: formatTrackNumber(i + 1, audioNames.length), trackTotal }))
  })
  if (ebookNames.length === 1) {
    newNames.set(ebookNames[0], renderUploadedName(ebookNames[0], {}))
  }

  const lowerNewNames = [...newNames.values()].map((name) => name.toLowerCase())
  return new Set(lowerNewNames).size === lowerNewNames.length ? newNames : new Map()
}

/**
 * Folder segments and new file names for an upload.
 * The upload form has no sequence, narrator, year or audio details, so those tokens render empty.
 *
 * @param {{organizeFolderTemplate:string, organizeFileTemplate:string}} librarySettings
 * @param {{title:string, author:string|null, series:string|null}} details
 * @param {string[]} uploadedNames
 * @returns {{folderSegments:string[], newNames:Map<string,string>}}
 */
function getUploadLayout(librarySettings, details, uploadedNames) {
  const metadata = {
    title: details.title,
    authors: details.author ? [details.author] : [],
    series: details.series ? [{ name: details.series }] : []
  }
  return {
    folderSegments: renderFolderSegments(librarySettings.organizeFolderTemplate, getTemplateValues(metadata)),
    newNames: getUploadedFileNames(librarySettings.organizeFileTemplate, metadata, uploadedNames)
  }
}

const SAMPLE_BOOK = {
  title: 'The Way of Kings',
  titleIgnorePrefix: 'Way of Kings, The',
  subtitle: 'Book One of the Stormlight Archive',
  authors: ['Brandon Sanderson'],
  series: [{ name: 'The Stormlight Archive', sequence: '1' }],
  narrators: ['Michael Kramer', 'Kate Reading'],
  genres: ['Fantasy', 'Epic'],
  publishedYear: 2010,
  publishedDate: '2010-08-31',
  language: 'English',
  abridged: false,
  explicit: false,
  asin: 'B003ZWFO7E',
  isbn: '9780765326355',
  publisher: 'Tor Books',
  codec: 'aac',
  bitRate: 64000,
  channels: 2
}
const SAMPLE_FILE = { track: '01', trackTotal: '12', trackTitle: 'Prelude to the Stormlight Archive', disc: '1', originalName: 'Part 1' }

/**
 * Render the templates for a sample book
 *
 * @param {string} folderTemplate
 * @param {string} fileTemplate
 * @returns {{folder:string, folderError:string|null, file:string, fileError:string|null}}
 */
function getTemplateExample(folderTemplate, fileTemplate) {
  const folderError = getTemplateSettingError('organizeFolderTemplate', folderTemplate)
  const fileError = getTemplateSettingError('organizeFileTemplate', fileTemplate)
  const values = getTemplateValues(SAMPLE_BOOK, SAMPLE_FILE)
  return {
    folder: folderError ? '' : renderFolderSegments(folderTemplate, values).join('/'),
    folderError,
    file: fileError ? '' : renderFileName(fileTemplate, values, '.mp3'),
    fileError
  }
}

module.exports = {
  DEFAULT_FOLDER_TEMPLATE,
  DEFAULT_FILE_TEMPLATE,
  FOLDER_TOKENS,
  FILE_TOKENS,
  TEMPLATE_SETTING_KEYS,
  getTemplateSettingError,
  getTemplateValues,
  renderFolderSegments,
  renderFileName,
  formatTrackNumber,
  getUploadLayout,
  getTemplateExample
}
