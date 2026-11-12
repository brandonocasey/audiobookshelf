const Path = require('path')
const { FOLDER_TOKENS, FILE_TOKENS, DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE, getTemplateSettingError } = require('./organizeTemplate')
const { getTargetValues, renderTarget } = require('./organizePlan')

/**
 * @param {number} index
 * @param {string} filename
 * @param {Object} details Probed audio file fields
 */
function sampleAudioFile(index, filename, details) {
  return { index, metadata: { path: `/sample/${filename}`, filename, ext: Path.extname(filename) }, ...details }
}

const SERIES_SAMPLE = {
  id: 'series',
  isFile: false,
  media: {
    title: 'The Way of Kings',
    subtitle: 'Book One of the Stormlight Archive',
    authors: [{ name: 'Brandon Sanderson' }],
    series: [{ name: 'The Stormlight Archive', bookSeries: { sequence: '1' } }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    genres: ['Fantasy', 'Epic'],
    publishedYear: '2010',
    publishedDate: '2010-08-31',
    language: 'English',
    abridged: false,
    explicit: false,
    asin: 'B003ZWFO7E',
    isbn: '9780765326355',
    publisher: 'Tor Books',
    audioFiles: [
      sampleAudioFile(1, 'part1.mp3', { duration: 16200, codec: 'mp3', bitRate: 64000, channels: 2, channelLayout: 'stereo', discNumFromMeta: 1, metaTags: { tagTitle: 'Prelude', tagOriginalYear: '2010' } }),
      sampleAudioFile(2, 'part2.mp3', { duration: 15300, codec: 'mp3', bitRate: 64000, channels: 2, channelLayout: 'stereo', discNumFromMeta: 1, metaTags: { tagTitle: 'Part One' } }),
      sampleAudioFile(3, 'part3.mp3', { duration: 14100, codec: 'mp3', bitRate: 64000, channels: 2, channelLayout: 'stereo', discNumFromMeta: 2, metaTags: { tagTitle: 'Part Two' } })
    ],
    ebookFile: { metadata: { path: '/sample/kings.epub', filename: 'kings.epub', ext: '.epub' } }
  }
}

/** A book with fewer details, such as no series or subtitle */
const STANDALONE_SAMPLE = {
  id: 'standalone',
  isFile: false,
  media: {
    title: 'Project Hail Mary',
    authors: [{ name: 'Andy Weir' }],
    series: [],
    narrators: ['Ray Porter'],
    genres: ['Science Fiction'],
    publishedYear: '2021',
    audioFiles: [sampleAudioFile(1, 'hail-mary.m4b', { duration: 58020, codec: 'aac', bitRate: 128000, channels: 2, channelLayout: 'stereo', metaTags: {} })],
    ebookFile: null
  }
}

/**
 * Every token with its value for the first file of the series sample. Abridged and explicit are set so their tokens show a value.
 *
 * @returns {{name:string, example:string, fileOnly:boolean}[]}
 */
function getTokenExamples() {
  const sample = { ...SERIES_SAMPLE, media: { ...SERIES_SAMPLE.media, abridged: true, explicit: true } }
  const { values } = getTargetValues(sample).files[0]
  return FILE_TOKENS.map((name) => ({ name, example: values[name], fileOnly: !FOLDER_TOKENS.includes(name) }))
}

/**
 * Folder and file names the templates give the sample books, rendered as organize renders them
 *
 * @param {string} folderTemplate Valid folder template
 * @param {string} fileTemplate Valid file template
 * @returns {{id:string, folder:string, files:{name:string, isEbook:boolean}[]}[]}
 */
function renderSamples(folderTemplate, fileTemplate) {
  return [SERIES_SAMPLE, STANDALONE_SAMPLE].map((sample) => {
    const { segments, files } = renderTarget(sample, { organizeFolderTemplate: folderTemplate, organizeFileTemplate: fileTemplate })
    return {
      id: sample.id,
      folder: segments.join('/'),
      files: files.map((file) => ({ name: file.newName, isEbook: file.path === sample.media.ebookFile?.metadata.path }))
    }
  })
}

/**
 * Render the templates for sample books and list the tokens. An invalid template renders empty and reports its error.
 *
 * @param {string} folderTemplate
 * @param {string} fileTemplate
 * @returns {{folder:string, folderError:string|null, file:string, fileError:string|null, tokens:{name:string, example:string, fileOnly:boolean}[], samples:{id:string, folder:string, files:{name:string, isEbook:boolean}[]}[]}}
 */
function getTemplateExample(folderTemplate, fileTemplate) {
  const folderError = getTemplateSettingError('organizeFolderTemplate', folderTemplate)
  const fileError = getTemplateSettingError('organizeFileTemplate', fileTemplate)
  // renderTarget throws on an invalid template, so render the default instead and blank its result
  const samples = renderSamples(folderError ? DEFAULT_FOLDER_TEMPLATE : folderTemplate, fileError ? DEFAULT_FILE_TEMPLATE : fileTemplate).map((sample) => ({
    id: sample.id,
    folder: folderError ? '' : sample.folder,
    files: fileError ? [] : sample.files
  }))
  return {
    folder: samples[0].folder,
    folderError,
    file: samples[0].files[0]?.name || '',
    fileError,
    tokens: getTokenExamples(),
    samples
  }
}

module.exports = { getTemplateExample }
