const Path = require('path')
const { sanitizeFilename } = require('./fileUtils')
const globals = require('./globals')

const DEFAULT_FOLDER_TEMPLATE = '{author}/{series}/<{sequence}. >{title}'
const DEFAULT_FILE_TEMPLATE = '{title}< - Part {track}>'

const FOLDER_TOKENS = ['author', 'authors', 'series', 'sequence', 'title', 'subtitle', 'year', 'narrator', 'asin', 'isbn', 'publisher']
const FILE_TOKENS = [...FOLDER_TOKENS, 'track', 'disc']
const MAX_TEMPLATE_LENGTH = 500

/**
 * @typedef {{type:'text', value:string}|{type:'token', name:string}|{type:'group', nodes:TemplateNode[]}} TemplateNode
 *
 * @typedef TemplateMetadata
 * @property {string} [title]
 * @property {string} [subtitle]
 * @property {string[]} [authors]
 * @property {{name:string, sequence?:string|null}[]} [series]
 * @property {string[]} [narrators]
 * @property {string|number} [publishedYear]
 * @property {string} [asin]
 * @property {string} [isbn]
 * @property {string} [publisher]
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

/**
 * @param {string} template
 * @returns {string|null} Error message or null when the template is valid
 */
function getFolderTemplateError(template) {
  try {
    parseFolderTemplate(template)
    return null
  } catch (error) {
    return error.message
  }
}

/**
 * @param {string} template
 * @returns {string|null} Error message or null when the template is valid
 */
function getFileTemplateError(template) {
  try {
    parseFileTemplate(template)
    return null
  } catch (error) {
    return error.message
  }
}

/**
 * @param {'organizeFolderTemplate'|'organizeFileTemplate'} key Library setting key
 * @param {string} template
 * @returns {string|null} Error message or null when the template is valid
 */
function getTemplateSettingError(key, template) {
  return key === 'organizeFolderTemplate' ? getFolderTemplateError(template) : getFileTemplateError(template)
}

/**
 * Token values for a book. Missing details are empty strings so their template groups drop out.
 *
 * @param {TemplateMetadata} metadata
 * @param {{track?:string, disc?:string}} [fileValues]
 * @returns {Object<string,string>}
 */
function getTemplateValues(metadata, fileValues = {}) {
  const clean = (value) => sanitizeFilename(String(value ?? '')) || ''
  const authors = (metadata.authors || []).map(clean).filter(Boolean)
  const firstSeries = metadata.series?.[0]
  return {
    author: authors[0] || '',
    authors: authors.join(', '),
    series: clean(firstSeries?.name),
    sequence: clean(firstSeries?.sequence),
    title: clean(metadata.title),
    subtitle: clean(metadata.subtitle),
    year: clean(metadata.publishedYear),
    narrator: clean(metadata.narrators?.[0]),
    asin: clean(metadata.asin),
    isbn: clean(metadata.isbn),
    publisher: clean(metadata.publisher),
    track: fileValues.track || '',
    disc: fileValues.disc || ''
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
 * Names for uploaded files. Audio files are numbered in natural sort order of the uploaded names.
 * A lone ebook is renamed too. Files are left alone when the renamed names would collide.
 *
 * @param {string} fileTemplate
 * @param {Object<string,string>} values
 * @param {string[]} uploadedNames
 * @returns {Map<string,string>} Uploaded name to new name, only for files that are renamed
 */
function getUploadedFileNames(fileTemplate, values, uploadedNames) {
  const extOf = (name) => Path.extname(name).slice(1).toLowerCase()
  const audioNames = uploadedNames.filter((name) => globals.SupportedAudioTypes.includes(extOf(name))).sort(naturalCompare)
  const ebookNames = uploadedNames.filter((name) => globals.SupportedEbookTypes.includes(extOf(name)))

  const newNames = new Map()
  audioNames.forEach((name, i) => {
    const fileValues = { ...values, track: formatTrackNumber(i + 1, audioNames.length) }
    newNames.set(name, renderFileName(fileTemplate, fileValues, Path.extname(name)) || name)
  })
  if (ebookNames.length === 1) {
    newNames.set(ebookNames[0], renderFileName(fileTemplate, values, Path.extname(ebookNames[0])) || ebookNames[0])
  }

  const lowerNewNames = [...newNames.values()].map((name) => name.toLowerCase())
  return new Set(lowerNewNames).size === lowerNewNames.length ? newNames : new Map()
}

/**
 * Where an upload goes: folder segments below the library folder and the new name for each file.
 * The upload form has no sequence, narrator, year and so on, so those tokens render empty.
 *
 * @param {{organizeFolderTemplate:string, organizeFileTemplate:string}} librarySettings
 * @param {{title:string, author:string|null, series:string|null}} details
 * @param {string[]} uploadedNames
 * @returns {{folderSegments:string[], newNames:Map<string,string>}}
 */
function getUploadLayout(librarySettings, details, uploadedNames) {
  const values = getTemplateValues({
    title: details.title,
    authors: details.author ? [details.author] : [],
    series: details.series ? [{ name: details.series }] : []
  })
  return {
    folderSegments: renderFolderSegments(librarySettings.organizeFolderTemplate, values),
    newNames: getUploadedFileNames(librarySettings.organizeFileTemplate, values, uploadedNames)
  }
}

const SAMPLE_BOOK = {
  title: 'The Way of Kings',
  subtitle: 'Book One of the Stormlight Archive',
  authors: ['Brandon Sanderson'],
  series: [{ name: 'The Stormlight Archive', sequence: '1' }],
  narrators: ['Michael Kramer'],
  publishedYear: 2010,
  asin: 'B003ZWFO7E',
  isbn: '9780765326355',
  publisher: 'Tor Books'
}

/**
 * Render the templates for a sample book, for showing what a template does while it is edited
 *
 * @param {string} folderTemplate
 * @param {string} fileTemplate
 * @returns {{folder:string, folderError:string|null, file:string, fileError:string|null}}
 */
function getTemplateExample(folderTemplate, fileTemplate) {
  const folderError = getTemplateSettingError('organizeFolderTemplate', folderTemplate)
  const fileError = getTemplateSettingError('organizeFileTemplate', fileTemplate)
  const values = getTemplateValues(SAMPLE_BOOK, { track: '01', disc: '1' })
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
  getTemplateSettingError,
  getTemplateValues,
  renderFolderSegments,
  renderFileName,
  formatTrackNumber,
  getUploadLayout,
  getTemplateExample
}
