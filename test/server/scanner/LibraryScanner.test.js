const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const Path = require('path')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const BookFinder = require('../../../server/finders/BookFinder')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const TaskManager = require('../../../server/managers/TaskManager')
const Task = require('../../../server/objects/Task')

describe('LibraryScanner auto match new items', () => {
  const matchedIsbn = '9780000000001'

  /** @type {string} */
  let tempDir
  /** @type {string} */
  let libraryPath
  /** @type {import('../../../server/models/Library')} */
  let library

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-library-scanner-'))
    libraryPath = Path.join(tempDir, 'library')
    fs.mkdirSync(libraryPath)
    global.MetadataPath = Path.join(tempDir, 'metadata')
    fs.mkdirSync(global.MetadataPath)
    global.ServerSettings = {}

    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    Database.serverSettings = { scannerPreferMatchedMetadata: false }

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(BookFinder, 'search').resolves([{ title: 'Matched Title', isbn: matchedIsbn }])

    library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book', provider: 'google', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    await Database.libraryFolderModel.create({ path: libraryPath, libraryId: library.id })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function addBookFolder(relPath) {
    const dir = Path.join(libraryPath, relPath)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = Path.join(dir, 'book.pdf')
    fs.writeFileSync(filePath, 'not a real pdf')
    return filePath
  }

  async function setAutoMatchNewItems(value) {
    library.settings = { ...library.settings, autoMatchNewItems: value }
    await library.save()
  }

  async function runLibraryScan() {
    const libraryWithFolders = await Database.libraryModel.findByIdWithFolders(library.id)
    await LibraryScanner.scan(libraryWithFolders)
  }

  function rejectSearchForTitle(failingTitle) {
    BookFinder.search.callsFake(async (libraryItem, provider, title) => {
      if (title === failingTitle) throw new Error('Provider failure')
      return [{ title: 'Matched Title', isbn: matchedIsbn }]
    })
  }

  async function getIsbnByTitle(title) {
    const book = await Database.bookModel.findOne({ where: { title } })
    expect(book, `book "${title}"`).to.exist
    return book.isbn
  }

  describe('library scan', () => {
    const cases = [
      { name: 'matches new book when enabled', autoMatchNewItems: true, expectedIsbn: matchedIsbn },
      { name: 'leaves new book unmatched when disabled', autoMatchNewItems: false, expectedIsbn: null }
    ]
    cases.forEach(({ name, autoMatchNewItems, expectedIsbn }) => {
      it(name, async () => {
        await setAutoMatchNewItems(autoMatchNewItems)
        addBookFolder('Some Author/New Book')

        await runLibraryScan()

        expect(await getIsbnByTitle('New Book')).to.equal(expectedIsbn)
      })
    })

    it('counts matched new books as added only', async () => {
      const taskFinishedSpy = sinon.spy(TaskManager, 'taskFinished')
      await setAutoMatchNewItems(true)
      addBookFolder('Some Author/New Book')

      await runLibraryScan()

      const { added, updated } = taskFinishedSpy.firstCall.args[0].data.scanResults
      expect({ added, updated }).to.deep.equal({ added: 1, updated: 0 })
    })

    it('completes the scan and matches other books when one match fails', async () => {
      rejectSearchForTitle('Failing Book')
      await setAutoMatchNewItems(true)
      addBookFolder('Some Author/Failing Book')
      addBookFolder('Some Author/New Book')

      await runLibraryScan()

      expect(await getIsbnByTitle('Failing Book')).to.equal(null)
      expect(await getIsbnByTitle('New Book')).to.equal(matchedIsbn)
      expect((await Database.libraryModel.findByPk(library.id)).lastScan).to.exist
    })

    it('searches the auto match provider instead of the library provider', async () => {
      library.settings = { ...library.settings, autoMatchNewItems: true, autoMatchProvider: 'audible.uk' }
      await library.save()
      addBookFolder('Some Author/New Book')

      await runLibraryScan()

      expect(BookFinder.search.firstCall.args[1]).to.equal('audible.uk')
    })

    describe('minimum confidence', () => {
      const cases = [
        { name: 'matches when confidence is above the minimum', minConfidence: 90, matchConfidence: 0.95, expectedIsbn: matchedIsbn },
        { name: 'matches when confidence equals the minimum', minConfidence: 90, matchConfidence: 0.9, expectedIsbn: matchedIsbn },
        { name: 'skips when confidence is below the minimum', minConfidence: 90, matchConfidence: 0.89, expectedIsbn: null },
        { name: 'skips results without a confidence when a minimum is set', minConfidence: 90, matchConfidence: undefined, expectedIsbn: null },
        { name: 'skips results without a confidence when the minimum is 0', minConfidence: 0, matchConfidence: undefined, expectedIsbn: null },
        { name: 'matches a perfect score with float error at a 100 minimum', minConfidence: 100, matchConfidence: 0.9999999999999999, expectedIsbn: matchedIsbn },
        { name: 'matches results without a confidence when no minimum is set', minConfidence: null, matchConfidence: undefined, expectedIsbn: matchedIsbn }
      ]
      cases.forEach(({ name, minConfidence, matchConfidence, expectedIsbn }) => {
        it(name, async () => {
          BookFinder.search.resolves([{ title: 'Matched Title', isbn: matchedIsbn, matchConfidence }])
          library.settings = { ...library.settings, autoMatchNewItems: true, autoMatchMinConfidence: minConfidence }
          await library.save()
          addBookFolder('Some Author/New Book')

          await runLibraryScan()

          expect(await getIsbnByTitle('New Book')).to.equal(expectedIsbn)
        })
      })

      const warningCases = [
        { name: 'warns with percents when skipping a match', minConfidence: 90, matchConfidence: 0.37, expectedWarning: 'audible match confidence 37% is below minimum 90%' },
        { name: 'warns below the minimum when the confidence rounds up to it', minConfidence: 90, matchConfidence: 0.89996, expectedWarning: 'audible match confidence 89.99% is below minimum 90%' },
        { name: 'warns with an unknown confidence', minConfidence: 37.5, matchConfidence: undefined, expectedWarning: 'audible match confidence unknown is below minimum 37.5%' },
        { name: 'warns with the minimum as entered', minConfidence: 37.0000004, matchConfidence: 0.37, expectedWarning: 'audible match confidence 37% is below minimum 37.0000004%' }
      ]
      warningCases.forEach(({ name, minConfidence, matchConfidence, expectedWarning }) => {
        it(name, async () => {
          BookFinder.search.resolves([{ title: 'Matched Title', isbn: matchedIsbn, matchConfidence }])
          library.settings = { ...library.settings, autoMatchNewItems: true, autoMatchMinConfidence: minConfidence }
          await library.save()
          addBookFolder('Some Author/New Book')

          await runLibraryScan()

          expect(Logger.warn.calledWithMatch(expectedWarning)).to.be.true
        })
      })
    })

    it('cleans up authors and series when the scan is canceled during auto match', async () => {
      const finalizeSpy = sinon.spy(LibraryItemScanner, 'finalizeAuthorsAndSeriesFromScan')
      BookFinder.search.callsFake(async () => {
        LibraryScanner.setCancelLibraryScan(library.id)
        return [{ title: 'Matched Title', isbn: matchedIsbn }]
      })
      await setAutoMatchNewItems(true)
      addBookFolder('Some Author/New Book')

      await runLibraryScan()

      expect(finalizeSpy.calledOnce).to.be.true
      expect((await Database.libraryModel.findByPk(library.id)).lastScan).to.not.exist
    })

    it('does not match books that existed before the scan', async () => {
      addBookFolder('Some Author/Existing Book')
      await runLibraryScan()
      await setAutoMatchNewItems(true)
      addBookFolder('Some Author/New Book')

      await runLibraryScan()

      expect(await getIsbnByTitle('Existing Book')).to.equal(null)
      expect(await getIsbnByTitle('New Book')).to.equal(matchedIsbn)
    })
  })

  describe('folder watcher scan', () => {
    const cases = [
      { name: 'matches new book when enabled', autoMatchNewItems: true, expectedIsbn: matchedIsbn },
      { name: 'leaves new book unmatched when disabled', autoMatchNewItems: false, expectedIsbn: null }
    ]
    cases.forEach(({ name, autoMatchNewItems, expectedIsbn }) => {
      it(name, async () => {
        await setAutoMatchNewItems(autoMatchNewItems)
        const folder = await Database.libraryFolderModel.findOne({ where: { libraryId: library.id } })
        const filePath = addBookFolder('Some Author/Watched Book')
        const pendingTask = new Task()
        pendingTask.setData('watcher-scan', { text: 'Watcher scan' }, null, false)

        await LibraryScanner.scanFilesChanged([{ path: filePath, relPath: Path.relative(libraryPath, filePath), folderId: folder.id, libraryId: library.id, type: 'added' }], pendingTask)

        expect(await getIsbnByTitle('Watched Book')).to.equal(expectedIsbn)
      })
    })

    it('keeps the new book when its match fails', async () => {
      rejectSearchForTitle('Watched Book')
      await setAutoMatchNewItems(true)
      const folder = await Database.libraryFolderModel.findOne({ where: { libraryId: library.id } })
      const filePath = addBookFolder('Some Author/Watched Book')
      const pendingTask = new Task()
      pendingTask.setData('watcher-scan', { text: 'Watcher scan' }, null, false)

      await LibraryScanner.scanFilesChanged([{ path: filePath, relPath: Path.relative(libraryPath, filePath), folderId: folder.id, libraryId: library.id, type: 'added' }], pendingTask)

      expect(await getIsbnByTitle('Watched Book')).to.equal(null)
    })
  })
})
