const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../../server/Logger')
const { DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE, getTemplateSettingError, getTemplateValues, renderFolderSegments, renderFileName, formatTrackNumber, getUploadLayout, getTemplateExample } = require('../../../server/utils/organizeTemplate')

describe('organizeTemplate', () => {
  const previousServerSettings = global.ServerSettings

  beforeEach(() => {
    sinon.stub(Logger, 'debug')
    global.ServerSettings = { sortingPrefixes: ['the', 'a'] }
  })

  afterEach(() => {
    sinon.restore()
    global.ServerSettings = previousServerSettings
  })

  const book = { title: 'The Way of Kings', authors: ['Brandon Sanderson', 'Someone Else'], series: [{ name: 'The Stormlight Archive', sequence: '1' }], narrators: ['Michael Kramer'], publishedYear: 2010, asin: 'B003ZWFO7E' }

  describe('new tokens', () => {
    const fullBook = {
      ...book,
      authors: ['Brandon Sanderson', 'Someone Else'],
      narrators: ['Michael Kramer', 'Kate Reading'],
      genres: ['Fantasy', 'Epic'],
      publishedDate: '2010-08-31',
      language: 'English',
      abridged: true,
      explicit: true,
      codec: 'aac',
      bitRate: 64000,
      channels: 2,
      channelLayout: '5.1(side)',
      format: 'M4B',
      originalYear: '1996'
    }
    const fileValues = { track: '02', trackTotal: '12', trackTitle: 'Chapter: Two', disc: '1', duration: 5000 }

    it('renders each book token', () => {
      const values = getTemplateValues(fullBook)
      const rendered = {
        authorSort: 'Sanderson, Brandon',
        authorInitial: 'S',
        titleThe: 'Way of Kings, The',
        titleIgnorePrefix: 'Way of Kings',
        originalYear: '1996',
        sequencePadded: '01',
        narrators: 'Michael Kramer, Kate Reading',
        genre: 'Fantasy',
        genres: 'Fantasy, Epic',
        language: 'English',
        publishedDate: '2010-08-31',
        abridged: 'Abridged',
        explicit: 'Explicit',
        codec: 'aac',
        bitrate: '64',
        channels: '2',
        channelLayout: '5.1(side)',
        format: 'm4b'
      }
      for (const [token, expected] of Object.entries(rendered)) {
        expect(renderFolderSegments(`{${token}}`, values), token).to.deep.equal([expected])
      }
    })

    it('renders each file token and cleans names from the file', () => {
      const values = getTemplateValues(fullBook, fileValues)
      expect(renderFileName('{trackTitle}, {track} of {trackTotal}, {disc}, {duration}', values, '.mp3')).to.equal('Chapter - Two, 02 of 12, 1, 1 hr 23 min.mp3')
    })

    it('renders them empty when the details are missing so their groups drop out', () => {
      const values = getTemplateValues({ title: 'Solo', authors: [] })
      const template = '{title}< {authorSort}>< {genre}>< ({abridged})>< {codec}>< {bitrate}k>< {trackTitle}>< {originalYear}>< {format}>< {channelLayout}>< {duration}>'
      expect(renderFileName(template, values, '.mp3')).to.equal('Solo.mp3')
    })

    it('pads only the leading number of a sequence', () => {
      const padded = (sequence) => getTemplateValues({ ...book, series: [{ name: 'S', sequence }] }).sequencePadded
      expect(['2', '10', '100', '1.5', '0.5', 'Book 1', ''].map(padded)).to.deep.equal(['02', '10', '100', '01.5', '00.5', 'Book 1', ''])
    })

    it('takes the first letter of the sorted first author in upper case, including accented and astral characters', () => {
      const initial = (name) => getTemplateValues({ title: 'T', authors: [name] }).authorInitial
      expect(['brandon sanderson', 'élodie', '𠮷野', '3 Doors Down'].map(initial)).to.deep.equal(['S', 'É', '𠮷', 'D'])
    })

    it('moves the sorting prefix of a title to the end, also around spaces', () => {
      const titleThe = (title) => getTemplateValues({ title }).titleThe
      expect(['The Way of Kings', '  The Spaces  ', 'A Game of Thrones', "Ender's Game", 'The', ''].map(titleThe)).to.deep.equal(['Way of Kings, The', 'Spaces, The', 'Game of Thrones, A', "Ender's Game", 'The', ''])
    })

    it('removes the sorting prefix of a title, also around spaces', () => {
      const titleIgnorePrefix = (title) => getTemplateValues({ title }).titleIgnorePrefix
      expect(['The Way of Kings', '  The Spaces  ', "Ender's Game", 'The', ''].map(titleIgnorePrefix)).to.deep.equal(['Way of Kings', 'Spaces', "Ender's Game", 'The', ''])
    })

    it('sorts the first author as last name first, and keeps a single name', () => {
      const sorted = (name) => getTemplateValues({ title: 'T', authors: [name] }).authorSort
      expect(['Arthur Conan Doyle', 'Plato'].map(sorted)).to.deep.equal(['Doyle, Arthur Conan', 'Plato'])
    })

    it('accepts the new tokens in templates and still rejects unknown and file-only ones in folders', () => {
      expect(getTemplateSettingError('organizeFolderTemplate', '{authorSort}/{titleThe}')).to.equal(null)
      expect(getTemplateSettingError('organizeFileTemplate', '{authorSort} {trackTitle} {trackTotal}')).to.equal(null)
      expect(getTemplateSettingError('organizeFolderTemplate', '{trackTitle}')).to.equal('Unknown token "{trackTitle}"')
      expect(getTemplateSettingError('organizeFolderTemplate', '{duration}')).to.equal('Unknown token "{duration}"')
      expect(getTemplateSettingError('organizeFolderTemplate', '{authorsort}')).to.equal('Unknown token "{authorsort}"')
    })

    it('fills {trackTotal} and the title and author tokens for uploads and leaves the rest empty', () => {
      const settings = { organizeFolderTemplate: '{authorInitial}/{authorSort}/{titleThe}', organizeFileTemplate: '{titleThe}< [{trackTotal}]> {track}< {codec}>' }
      const { folderSegments, newNames } = getUploadLayout(settings, { title: 'The Hobbit', author: 'J. Tolkien', series: null }, ['Part 1.mp3', 'Part 2.mp3', 'cover.jpg'])
      expect(folderSegments).to.deep.equal(['T', 'Tolkien, J', 'Hobbit, The'])
      expect([...newNames]).to.deep.equal([
        ['Part 1.mp3', 'Hobbit, The [2] 1.mp3'],
        ['Part 2.mp3', 'Hobbit, The [2] 2.mp3']
      ])
    })
  })

  describe('renderFolderSegments', () => {
    it('renders the default template with every detail present', () => {
      const segments = renderFolderSegments(DEFAULT_FOLDER_TEMPLATE, getTemplateValues(book))
      expect(segments).to.deep.equal(['Brandon Sanderson', 'The Stormlight Archive', '1. The Way of Kings'])
    })

    it('drops the series folder and the sequence group when there is no series', () => {
      const segments = renderFolderSegments(DEFAULT_FOLDER_TEMPLATE, getTemplateValues({ ...book, series: [] }))
      expect(segments).to.deep.equal(['Brandon Sanderson', 'The Way of Kings'])
    })

    it('drops the sequence group but keeps the series folder when the sequence is empty', () => {
      const segments = renderFolderSegments(DEFAULT_FOLDER_TEMPLATE, getTemplateValues({ ...book, series: [{ name: 'Stormlight', sequence: null }] }))
      expect(segments).to.deep.equal(['Brandon Sanderson', 'Stormlight', 'The Way of Kings'])
    })

    it('drops the author folder when there is no author', () => {
      const segments = renderFolderSegments(DEFAULT_FOLDER_TEMPLATE, getTemplateValues({ title: 'Solo', authors: [] }))
      expect(segments).to.deep.equal(['Solo'])
    })

    it('uses the first author for {author} and all authors for {authors}', () => {
      const values = getTemplateValues(book)
      expect(renderFolderSegments('{author}', values)).to.deep.equal(['Brandon Sanderson'])
      expect(renderFolderSegments('{authors}/{title}', values)).to.deep.equal(['Brandon Sanderson, Someone Else', 'The Way of Kings'])
    })

    it('renders year, narrator, asin and a group holding a slash', () => {
      const values = getTemplateValues(book)
      expect(renderFolderSegments('{title} ({year}) [{asin}]/<{narrator}/>x', values)).to.deep.equal(['The Way of Kings (2010) [B003ZWFO7E]', 'Michael Kramer', 'x'])
      expect(renderFolderSegments('{title}/<{isbn}/>x', values)).to.deep.equal(['The Way of Kings', 'x'])
    })

    it('keeps Unicode characters', () => {
      const values = getTemplateValues({ title: 'Les Misérables 日本語', authors: ['Victor Hugo'] })
      expect(renderFolderSegments('{author}/{title}', values)).to.deep.equal(['Victor Hugo', 'Les Misérables 日本語'])
    })

    it('removes reserved characters from values so they cannot add path segments', () => {
      const values = getTemplateValues({ title: 'AC/DC: What? <Live> "Now" | *all*', authors: ['A\\B'] })
      expect(renderFolderSegments('{author}/{title}', values)).to.deep.equal(['AB', 'ACDC - What Live Now all'])
    })

    it('keeps dots that look like extensions in the title', () => {
      const values = getTemplateValues({ title: 'Foo v1.2', authors: ['Bar'] })
      expect(renderFolderSegments('{author}/{title}', values)).to.deep.equal(['Bar', 'Foo v1.2'])
    })

    it('trims segments to 255 bytes', () => {
      const values = getTemplateValues({ title: 'x'.repeat(400), authors: ['Bar'] })
      const [, titleSegment] = renderFolderSegments('{author}/{title}', values)
      expect(Buffer.byteLength(titleSegment, 'utf16le')).to.be.at.most(255)
      expect(titleSegment.length).to.be.greaterThan(100)
    })

    it('drops segments that sanitize to nothing', () => {
      const values = getTemplateValues({ title: 'Book', authors: ['..'] })
      expect(renderFolderSegments('{author}/{title}', values)).to.deep.equal(['Book'])
    })
  })

  describe('renderFileName', () => {
    it('adds the track group only when a track is given', () => {
      const values = getTemplateValues(book)
      expect(renderFileName(DEFAULT_FILE_TEMPLATE, values, '.m4b')).to.equal('The Way of Kings.m4b')
      expect(renderFileName(DEFAULT_FILE_TEMPLATE, { ...values, track: '03' }, '.mp3')).to.equal('The Way of Kings - Part 03.mp3')
    })

    it('keeps the extension intact for dotted titles', () => {
      const values = getTemplateValues({ title: 'Foo v1.2' })
      expect(renderFileName(DEFAULT_FILE_TEMPLATE, values, '.mp3')).to.equal('Foo v1.2.mp3')
    })

    it('keeps the extension when the name is trimmed to 255 bytes', () => {
      const values = getTemplateValues({ title: 'y'.repeat(400) })
      const name = renderFileName(DEFAULT_FILE_TEMPLATE, values, '.m4b')
      expect(name.endsWith('.m4b')).to.be.true
      expect(Buffer.byteLength(name, 'utf16le')).to.be.at.most(255)
    })

    it('returns an empty string when nothing renders', () => {
      expect(renderFileName('{title}', getTemplateValues({}), '.m4b')).to.equal('')
    })

    it('renders {disc} and {track}', () => {
      const values = getTemplateValues({ title: 'T' }, { track: '02', disc: '1' })
      expect(renderFileName('{title} - CD{disc} - {track}', values, '.mp3')).to.equal('T - CD1 - 02.mp3')
    })
  })

  describe('formatTrackNumber', () => {
    it('is empty for a single file and padded to the width of the file count otherwise', () => {
      const cases = [
        { position: 1, count: 1, expected: '' },
        { position: 9, count: 9, expected: '9' },
        { position: 1, count: 10, expected: '01' },
        { position: 10, count: 10, expected: '10' },
        { position: 1, count: 99, expected: '01' },
        { position: 1, count: 100, expected: '001' },
        { position: 100, count: 100, expected: '100' }
      ]
      for (const { position, count, expected } of cases) {
        expect(formatTrackNumber(position, count), `${position} of ${count}`).to.equal(expected)
      }
    })
  })

  describe('getTemplateSettingError', () => {
    it('accepts the default templates', () => {
      expect(getTemplateSettingError('organizeFolderTemplate', DEFAULT_FOLDER_TEMPLATE)).to.be.null
      expect(getTemplateSettingError('organizeFileTemplate', DEFAULT_FILE_TEMPLATE)).to.be.null
    })

    it('rejects invalid folder templates', () => {
      const invalid = {
        'unknown token': '{author}/{nope}',
        'file-only token': '{title}/{track}',
        'unbalanced open group': '<{series}/{title}',
        'unbalanced close group': '{series}>/{title}',
        'nested group': '<{series}<{sequence}>>/{title}',
        'unbalanced brace': '{title',
        'stray closing brace': '{title}}',
        'parent segment': '../{title}',
        'parent segment in a group': '{author}/<..>/{title}',
        'absolute path': '/{author}/{title}',
        'drive path': 'C:/{title}',
        backslash: '{author}\\{title}',
        'no token': 'Books',
        empty: '',
        blank: '   ',
        'not a string': 42,
        'too long': `{title}${'x'.repeat(500)}`
      }
      for (const [name, template] of Object.entries(invalid)) {
        expect(getTemplateSettingError('organizeFolderTemplate', template), name).to.be.a('string').that.is.not.empty
      }
    })

    it('rejects file templates with path separators and unknown tokens, accepts {track} and {disc}', () => {
      expect(getTemplateSettingError('organizeFileTemplate', '{author}/{title}')).to.be.a('string')
      expect(getTemplateSettingError('organizeFileTemplate', '{title}\\{track}')).to.be.a('string')
      expect(getTemplateSettingError('organizeFileTemplate', '{bogus}')).to.be.a('string')
      expect(getTemplateSettingError('organizeFileTemplate', '{title}< - CD{disc}>< - {track}>')).to.be.null
    })

    it('allows ".." inside a name', () => {
      expect(getTemplateSettingError('organizeFolderTemplate', '{title}..{year}')).to.be.null
    })
  })

  describe('getUploadLayout', () => {
    const settings = { organizeFolderTemplate: DEFAULT_FOLDER_TEMPLATE, organizeFileTemplate: DEFAULT_FILE_TEMPLATE }

    it('places files in the templated folder and numbers audio files in natural sort order', () => {
      const names = ['Track 10.mp3', 'Track 2.mp3', 'Track 1.mp3', 'cover.jpg']
      const { folderSegments, newNames } = getUploadLayout(settings, { title: 'My Book', author: 'Jane Doe', series: 'Saga' }, names)

      expect(folderSegments).to.deep.equal(['Jane Doe', 'Saga', 'My Book'])
      expect(newNames.get('Track 1.mp3')).to.equal('My Book - Part 1.mp3')
      expect(newNames.get('Track 2.mp3')).to.equal('My Book - Part 2.mp3')
      expect(newNames.get('Track 10.mp3')).to.equal('My Book - Part 3.mp3')
      expect(newNames.has('cover.jpg')).to.be.false
    })

    it('renders tokens the form lacks as empty so their groups drop out', () => {
      const custom = { ...settings, organizeFolderTemplate: '{author}/<{narrator}/><{year}/>{title}' }
      const { folderSegments } = getUploadLayout(custom, { title: 'My Book', author: null, series: null }, ['a.m4b'])
      expect(folderSegments).to.deep.equal(['My Book'])
    })

    it('names a single audio file without a part number and renames a lone ebook', () => {
      const { newNames } = getUploadLayout(settings, { title: 'My Book', author: null, series: null }, ['x.m4b', 'y.epub'])
      expect(newNames.get('x.m4b')).to.equal('My Book.m4b')
      expect(newNames.get('y.epub')).to.equal('My Book.epub')
    })

    it('leaves names alone when the template would give two files the same name', () => {
      const custom = { ...settings, organizeFileTemplate: '{title}' }
      const { newNames } = getUploadLayout(custom, { title: 'My Book', author: null, series: null }, ['a.mp3', 'b.mp3'])
      expect(newNames.size).to.equal(0)
    })
  })

  describe('getTemplateExample', () => {
    it('renders the default templates for a sample book', () => {
      expect(getTemplateExample(DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE)).to.deep.equal({
        folder: 'Brandon Sanderson/The Stormlight Archive/1. The Way of Kings',
        folderError: null,
        file: 'The Way of Kings - Part 01.mp3',
        fileError: null
      })
    })

    it('reports each invalid template without rendering it', () => {
      const example = getTemplateExample('{nope}', '{title}/x')
      expect(example.folder).to.equal('')
      expect(example.folderError).to.equal('Unknown token "{nope}"')
      expect(example.file).to.equal('')
      expect(example.fileError).to.be.a('string')
    })
  })
})
