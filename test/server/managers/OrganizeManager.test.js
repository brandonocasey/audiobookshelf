const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { setImmediate: flush } = require('timers/promises')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const Watcher = require('../../../server/Watcher')
const SocketAuthority = require('../../../server/SocketAuthority')
const prober = require('../../../server/utils/prober')
const libraryFilters = require('../../../server/utils/queries/libraryFilters')
const fsExtra = require('../../../server/libs/fsExtra')
const AudioMetaTags = require('../../../server/objects/metadata/AudioMetaTags')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const OrganizeManager = require('../../../server/managers/OrganizeManager')
const TaskManager = require('../../../server/managers/TaskManager')
const Task = require('../../../server/objects/Task')
const { ScanResult } = require('../../../server/utils/constants')
const ToolsController = require('../../../server/controllers/ToolsController')
const LibraryController = require('../../../server/controllers/LibraryController')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const AuthorController = require('../../../server/controllers/AuthorController')
const SeriesController = require('../../../server/controllers/SeriesController')
const MiscController = require('../../../server/controllers/MiscController')
const FileSystemController = require('../../../server/controllers/FileSystemController')
const Scanner = require('../../../server/scanner/Scanner')
const BookFinder = require('../../../server/finders/BookFinder')

describe('OrganizeManager', () => {
  let tmpDir
  let libraryDir
  let library
  let libraryFolder
  let sessions
  let audioMetadataManager
  let abMergeManager
  let manager

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-organize-'))
    libraryDir = path.join(tmpDir, 'library')
    fs.mkdirSync(libraryDir)
    fs.mkdirSync(path.join(tmpDir, 'metadata'))
    global.MetadataPath = path.join(tmpDir, 'metadata')
    global.ServerSettings = { storeCoverWithItem: false, storeMetadataWithItem: false, metadataFileFormat: 'json', scannerParseSubtitle: false }

    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    Database.serverSettings = { scannerFindCovers: false }

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(Watcher, 'addIgnoreDir')
    sinon.stub(Watcher, 'removeIgnoreDir')
    sinon.stub(prober, 'probe').resolves({ format: 'MP3', duration: 10, audioStream: {}, audioMetaTags: new AudioMetaTags(), chapters: [], embeddedCoverArt: null })

    library = await Database.libraryModel.create({ name: 'Books', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    libraryFolder = await Database.libraryFolderModel.create({ path: libraryDir, libraryId: library.id })
    library.libraryFolders = [libraryFolder]

    sessions = []
    audioMetadataManager = { getIsLibraryItemQueuedOrProcessing: sinon.stub().returns(false) }
    abMergeManager = { getPendingTaskByLibraryItemId: sinon.stub().returns(undefined) }
    manager = newManager()
  })

  afterEach(async () => {
    sinon.restore()
    LibraryScanner.librariesScanning = []
    LibraryScanner.librariesMatching = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await Database.sequelize.sync({ force: true })
  })

  function newManager() {
    return new OrganizeManager({ sessions }, audioMetadataManager, abMergeManager)
  }

  /**
   * Write the files, scan the folder and set the metadata the templates use
   */
  async function addBook(relDir, fileNames, { title, authors = [], series = null, sequence = null } = {}) {
    const dir = path.join(libraryDir, relDir)
    fs.mkdirSync(dir, { recursive: true })
    for (const name of fileNames) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), name)
    }
    const libraryItem = await LibraryItemScanner.scanPotentialNewLibraryItem(dir, library, libraryFolder, false)
    await setMetadata(libraryItem.id, { title: title || relDir, authors, series, sequence })
    return libraryItem.id
  }

  async function addSingleFileBook(fileName, details) {
    const filePath = path.join(libraryDir, fileName)
    fs.writeFileSync(filePath, fileName)
    const libraryItem = await LibraryItemScanner.scanPotentialNewLibraryItem(filePath, library, libraryFolder, true)
    await setMetadata(libraryItem.id, details)
    return libraryItem.id
  }

  async function setMetadata(libraryItemId, { title, authors = [], series = null, sequence = null }) {
    const book = (await Database.libraryItemModel.getExpandedById(libraryItemId)).media
    book.title = title
    await book.save()
    // The first scan took the author and series from the folder names
    await Database.bookAuthorModel.destroy({ where: { bookId: book.id } })
    await Database.bookSeriesModel.destroy({ where: { bookId: book.id } })
    for (const authorName of authors) {
      const author = await Database.authorModel.create({ name: authorName, libraryId: library.id })
      await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
    }
    if (series) {
      const seriesRow = await Database.seriesModel.create({ name: series, nameIgnorePrefix: series, libraryId: library.id })
      await Database.bookSeriesModel.create({ bookId: book.id, seriesId: seriesRow.id, sequence })
    }
    // The scanner reads this file first, so keep it in step with the book
    await (await Database.libraryItemModel.getExpandedById(libraryItemId)).saveMetadataFile()
  }

  function rel(...parts) {
    return path.join(libraryDir, ...parts)
  }

  function listFiles(dir) {
    return fs.readdirSync(dir, { recursive: true }).sort()
  }

  async function loadItem(libraryItemId) {
    return Database.libraryItemModel.getExpandedById(libraryItemId)
  }

  /**
   * Part 1 is excluded and Part 3 plays before Part 2.
   * It also has a PDF ebook, an EPUB, a chosen cover and progress in Part 2.
   */
  async function addBookWithChoices() {
    const libraryItemId = await addBook('Raw', ['Part 1.mp3', 'Part 2.mp3', 'Part 3.mp3', 'book.pdf', 'extra.epub', 'a.jpg', 'b.jpg'], { title: 'Book', authors: ['Writer'] })
    const item = await loadItem(libraryItemId)
    const indexByName = { 'Part 1.mp3': -1, 'Part 3.mp3': 1, 'Part 2.mp3': 2 }
    item.media.audioFiles = item.media.audioFiles.map((audioFile) => ({ ...audioFile, index: indexByName[audioFile.metadata.filename], exclude: audioFile.metadata.filename === 'Part 1.mp3', manuallyVerified: true })).sort((a, b) => a.index - b.index)
    item.media.changed('audioFiles', true)
    item.media.coverPath = rel('Raw', 'b.jpg')
    await item.media.save()
    await item.setPrimaryEbookFile(item.getLibraryFiles().find((libraryFile) => libraryFile.metadata.filename === 'book.pdf'))
    const user = await Database.userModel.create({ username: 'u', pash: 'h', token: 't', type: 'user', isActive: true, permissions: {}, bookmarks: [], extraData: {} })
    await Database.mediaProgressModel.create({ userId: user.id, mediaItemId: item.mediaId, mediaItemType: 'book', currentTime: 15, duration: 20, isFinished: false, extraData: {} })
    return libraryItemId
  }

  /** What the book holds, by the content each file name stands for. Every file contains its original name. */
  async function describeChoices(libraryItemId) {
    const { media, libraryFiles } = await loadItem(libraryItemId)
    const contentOf = (filePath) => fs.readFileSync(filePath, 'utf8')
    let trackEnd = 0
    const audioFileAtProgress = media.includedAudioFiles.find((audioFile) => (trackEnd += audioFile.duration) > 15)
    return {
      audioFiles: media.audioFiles.map((audioFile) => ({ content: contentOf(audioFile.metadata.path), index: audioFile.index, exclude: audioFile.exclude, manuallyVerified: audioFile.manuallyVerified })),
      duration: media.duration,
      includedDuration: media.includedAudioFiles.reduce((total, audioFile) => total + audioFile.duration, 0),
      playOrder: media.includedAudioFiles.map((audioFile) => contentOf(audioFile.metadata.path)),
      audioFileAtProgress: contentOf(audioFileAtProgress.metadata.path),
      primaryEbook: contentOf(media.ebookFile.metadata.path),
      supplementaryEbooks: libraryFiles.filter((libraryFile) => libraryFile.isSupplementary).map((libraryFile) => contentOf(libraryFile.metadata.path)),
      cover: contentOf(media.coverPath)
    }
  }

  /** Every move goes through the copy-and-delete fallback used across file systems */
  function simulateCrossDeviceMoves() {
    const originalRename = fsExtra.rename
    sinon.stub(fsExtra, 'rename').callsFake((src, dest) => {
      if (src.endsWith('.tmp')) return originalRename(src, dest)
      return Promise.reject(Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }))
    })
  }

  describe('organizing an item', () => {
    for (const mode of ['on the same file system', 'across file systems']) {
      describe(mode, () => {
        beforeEach(() => {
          if (mode === 'across file systems') simulateCrossDeviceMoves()
        })

        it('keeps the id and progress and points every path at the new files', async () => {
          const libraryItemId = await addBook('Raw Folder', ['Part 2.mp3', 'Part 10.mp3', 'Part 1.mp3', 'cover.jpg', 'notes.txt', 'book.epub'], { title: 'The Way of Kings', authors: ['Brandon Sanderson'], series: 'Stormlight', sequence: '1' })
          const before = await loadItem(libraryItemId)
          const user = await Database.userModel.create({ username: 'u', pash: 'h', token: 't', type: 'user', isActive: true, permissions: {}, bookmarks: [], extraData: {} })
          await Database.mediaProgressModel.create({ userId: user.id, mediaItemId: before.mediaId, mediaItemType: 'book', currentTime: 42, duration: 100, isFinished: false, extraData: {} })
          const inoBefore = fs.statSync(rel('Raw Folder', 'cover.jpg')).ino
          expect(before.media.coverPath).to.equal(rel('Raw Folder', 'cover.jpg'))
          expect(before.media.ebookFile.metadata.path).to.equal(rel('Raw Folder', 'book.epub'))

          const result = await manager.organizeItem(libraryItemId)

          expect(result).to.deep.equal({ itemId: libraryItemId, status: 'moved' })
          const newDir = rel('Brandon Sanderson', 'Stormlight', '1. The Way of Kings')
          expect(listFiles(libraryDir)).to.deep.equal(['Brandon Sanderson', 'Brandon Sanderson/Stormlight', 'Brandon Sanderson/Stormlight/1. The Way of Kings', ...['The Way of Kings - Part 1.mp3', 'The Way of Kings - Part 2.mp3', 'The Way of Kings - Part 3.mp3', 'The Way of Kings.epub', 'cover.jpg', 'notes.txt'].map((name) => `Brandon Sanderson/Stormlight/1. The Way of Kings/${name}`)])
          if (mode === 'across file systems') expect(fs.statSync(path.join(newDir, 'cover.jpg')).ino).to.not.equal(inoBefore)

          const after = await loadItem(libraryItemId)
          expect(after.id).to.equal(libraryItemId)
          expect(after.mediaId).to.equal(before.mediaId)
          expect(after.isMissing).to.be.false
          expect(after.path).to.equal(newDir)
          expect(after.relPath).to.equal('Brandon Sanderson/Stormlight/1. The Way of Kings')
          expect(after.libraryFiles.map((lf) => lf.metadata.path).sort()).to.deep.equal(
            fs
              .readdirSync(newDir)
              .map((name) => path.join(newDir, name))
              .sort()
          )
          expect(after.libraryFiles.every((lf) => lf.metadata.relPath === lf.metadata.filename && fs.existsSync(lf.metadata.path))).to.be.true
          expect(after.media.coverPath).to.equal(path.join(newDir, 'cover.jpg'))
          expect(after.media.ebookFile.metadata.path).to.equal(path.join(newDir, 'The Way of Kings.epub'))
          expect(after.media.audioFiles).to.have.length(3)
          expect(after.media.audioFiles.every((af) => fs.existsSync(af.metadata.path) && af.metadata.path.startsWith(newDir))).to.be.true
          expect(after.media.title).to.equal('The Way of Kings')

          // The first track still holds the content of "Part 1.mp3"
          const orderedContent = [...after.media.audioFiles].sort((a, b) => a.index - b.index).map((af) => fs.readFileSync(af.metadata.path, 'utf8'))
          expect(orderedContent).to.deep.equal(['Part 1.mp3', 'Part 2.mp3', 'Part 10.mp3'])

          const progress = await Database.mediaProgressModel.findOne({ where: { mediaItemId: after.mediaId } })
          expect(progress.currentTime).to.equal(42)
        })

        it('moves a single file item into its own folder and keeps the cover and metadata file linked', async () => {
          global.ServerSettings.storeMetadataWithItem = true
          const libraryItemId = await addBook('Raw', ['audio.m4b', 'cover.png', 'metadata.json'], { title: 'Dune', authors: ['Frank Herbert'] })

          await manager.organizeItem(libraryItemId)

          const newDir = rel('Frank Herbert', 'Dune')
          expect(listFiles(newDir)).to.deep.equal(['Dune.m4b', 'cover.png', 'metadata.json'])
          const after = await loadItem(libraryItemId)
          expect(after.media.coverPath).to.equal(path.join(newDir, 'cover.png'))
          expect(after.libraryFiles.find((lf) => lf.metadata.filename === 'metadata.json').metadata.path).to.equal(path.join(newDir, 'metadata.json'))
          expect(fs.existsSync(rel('Raw'))).to.be.false
        })

        it('keeps excluded tracks, the track order, the primary ebook and the chosen cover', async () => {
          const libraryItemId = await addBookWithChoices()
          const before = await describeChoices(libraryItemId)
          expect(before).to.deep.include({ playOrder: ['Part 3.mp3', 'Part 2.mp3'], audioFileAtProgress: 'Part 2.mp3', primaryEbook: 'book.pdf', cover: 'b.jpg', duration: 30, includedDuration: 20 })

          const result = await manager.organizeItem(libraryItemId)

          expect(result.status).to.equal('moved')
          // Only playable tracks are numbered, in play order; the excluded track keeps its name
          const contentOf = (name) => fs.readFileSync(rel('Writer', 'Book', name), 'utf8')
          expect(['Book - Part 1.mp3', 'Book - Part 2.mp3', 'Part 1.mp3'].map(contentOf)).to.deep.equal(['Part 3.mp3', 'Part 2.mp3', 'Part 1.mp3'])
          expect(listFiles(rel('Writer', 'Book')))
            .to.include('Book.pdf')
            .and.not.include('Book - Part 3.mp3')
          expect(await describeChoices(libraryItemId)).to.deep.equal(before)
        })

        it('keeps those choices when the run is rolled back after the rescan', async () => {
          const libraryItemId = await addBookWithChoices()
          const before = await describeChoices(libraryItemId)
          const realScan = LibraryItemScanner.scanLibraryItem.bind(LibraryItemScanner)
          sinon
            .stub(LibraryItemScanner, 'scanLibraryItem')
            .onFirstCall()
            .callsFake(async (...args) => {
              await realScan(...args)
              throw new Error('failed after the rescan')
            })
            .callsFake(realScan)

          const result = await manager.organizeItem(libraryItemId)

          expect(result.status).to.equal('failed')
          expect(listFiles(libraryDir)).to.include('Raw/Part 1.mp3')
          expect(await describeChoices(libraryItemId)).to.deep.equal(before)
        })

        it('does nothing on a second run', async () => {
          const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
          await manager.organizeItem(libraryItemId)
          const filesAfterFirstRun = listFiles(libraryDir)
          const itemAfterFirstRun = await loadItem(libraryItemId)

          const result = await manager.organizeItem(libraryItemId)

          expect(result.status).to.equal('unchanged')
          expect(listFiles(libraryDir)).to.deep.equal(filesAfterFirstRun)
          expect((await loadItem(libraryItemId)).path).to.equal(itemAfterFirstRun.path)
        })
      })
    }

    it('keeps a book without a primary ebook that way after the rescan promotes one', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'book.epub'], { title: 'Book', authors: ['Writer'] })
      const before = await loadItem(libraryItemId)
      expect(before.media.ebookFile).to.not.be.null
      await before.setPrimaryEbookFile(null)

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('moved')
      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['Book.mp3', 'book.epub'])
      const after = await loadItem(libraryItemId)
      expect(after.media.ebookFile).to.be.null
      expect(
        after
          .getLibraryFiles()
          .filter((libraryFile) => libraryFile.isEBookFile)
          .map((libraryFile) => libraryFile.isSupplementary)
      ).to.deep.equal([true])
    })

    describe('item_updated event', () => {
      let emitter

      beforeEach(() => {
        emitter = sinon.stub(SocketAuthority, 'libraryItemEmitter')
      })

      it('is sent again with the restored settings after the rescan', async () => {
        const libraryItemId = await addBookWithChoices()

        await manager.organizeItem(libraryItemId)

        const updates = emitter.getCalls().filter((call) => call.args[0] === 'item_updated' && call.args[1].id === libraryItemId)
        expect(updates.length).to.be.at.least(2)
        const lastUpdate = updates[updates.length - 1].args[1]
        expect(lastUpdate.path).to.equal(rel('Writer', 'Book'))
        expect(lastUpdate.media.audioFiles.map((audioFile) => [path.basename(audioFile.metadata.path), audioFile.exclude])).to.deep.equal([
          ['Part 1.mp3', true],
          ['Book - Part 1.mp3', false],
          ['Book - Part 2.mp3', false]
        ])
        expect(path.basename(lastUpdate.media.ebookFile.metadata.path)).to.equal('Book.pdf')
        expect(path.basename(lastUpdate.media.coverPath)).to.equal('b.jpg')
      })

      it('is not sent again when the rescan left the settings as they were', async () => {
        const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })

        await manager.organizeItem(libraryItemId)

        expect(emitter.getCalls().filter((call) => call.args[1].id === libraryItemId)).to.have.length(1)
      })
    })

    it('numbers the tracks by the stored audio file index, not the order they are stored in', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3', 'c.mp3'], { title: 'Book', authors: ['Writer'] })
      const book = (await loadItem(libraryItemId)).media
      book.audioFiles = [...book.audioFiles].sort((x, y) => y.index - x.index)
      book.changed('audioFiles', true)
      await book.save()

      await manager.organizeItem(libraryItemId)

      const contentByName = Object.fromEntries(listFiles(rel('Writer', 'Book')).map((name) => [name, fs.readFileSync(rel('Writer', 'Book', name), 'utf8')]))
      expect(contentByName).to.deep.equal({ 'Book - Part 1.mp3': 'a.mp3', 'Book - Part 2.mp3': 'b.mp3', 'Book - Part 3.mp3': 'c.mp3' })
    })

    it('fills {disc} from the embedded disc number, then the one in the file name, and keeps disc 0', async () => {
      await library.update({ settings: { ...library.settings, organizeFileTemplate: '{title}< - Disc {disc}> - {track}' } })
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3', 'c.mp3'], { title: 'Book', authors: ['Writer'] })
      const book = (await loadItem(libraryItemId)).media
      const discs = [
        { discNumFromMeta: 2, discNumFromFilename: 7 },
        { discNumFromMeta: null, discNumFromFilename: 0 },
        { discNumFromMeta: null, discNumFromFilename: null }
      ]
      book.audioFiles = [...book.audioFiles].sort((x, y) => x.index - y.index).map((audioFile, i) => ({ ...audioFile, ...discs[i] }))
      book.changed('audioFiles', true)
      await book.save()

      await manager.organizeItem(libraryItemId)

      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['Book - 3.mp3', 'Book - Disc 0 - 2.mp3', 'Book - Disc 2 - 1.mp3'])
    })

    it('has the file watcher ignore the old and the new folder while it works', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

      await manager.organizeItem(libraryItemId)

      for (const stub of [Watcher.addIgnoreDir, Watcher.removeIgnoreDir]) {
        expect(stub.getCalls().map((call) => call.args[0])).to.have.members([rel('Raw'), rel('Writer', 'Book')])
      }
    })

    it('moves a single-file item into a folder and puts its cover and metadata next to it when stored with the item', async () => {
      const libraryItemId = await addSingleFileBook('Loose Book.m4b', { title: 'Loose Book', authors: ['Some Author'] })
      const metadataFolder = path.join(global.MetadataPath, 'items', libraryItemId)
      fs.mkdirSync(metadataFolder, { recursive: true })
      fs.writeFileSync(path.join(metadataFolder, 'cover.jpg'), 'cover')
      fs.writeFileSync(path.join(metadataFolder, 'metadata.json'), '{}')
      const book = (await loadItem(libraryItemId)).media
      book.coverPath = path.join(metadataFolder, 'cover.jpg')
      await book.save()
      global.ServerSettings.storeCoverWithItem = true
      global.ServerSettings.storeMetadataWithItem = true

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('moved')
      const newDir = rel('Some Author', 'Loose Book')
      expect(listFiles(libraryDir)).to.not.include('Loose Book.m4b')
      expect(listFiles(newDir)).to.deep.equal(['Loose Book.m4b', 'cover.jpg', 'metadata.json'])
      const after = await loadItem(libraryItemId)
      expect(after.isFile).to.be.false
      expect(after.path).to.equal(newDir)
      expect(after.media.coverPath).to.equal(path.join(newDir, 'cover.jpg'))
      expect(fs.readdirSync(metadataFolder)).to.deep.equal([])
    })

    it('moves the file of a single-file item into the folder when the file is excluded', async () => {
      const libraryItemId = await addSingleFileBook('Loose Book.m4b', { title: 'Loose Book', authors: ['Some Author'] })
      const metadataFolder = path.join(global.MetadataPath, 'items', libraryItemId)
      fs.mkdirSync(metadataFolder, { recursive: true })
      fs.writeFileSync(path.join(metadataFolder, 'cover.jpg'), 'cover')
      const book = (await loadItem(libraryItemId)).media
      book.audioFiles = book.audioFiles.map((audioFile) => ({ ...audioFile, exclude: true }))
      book.changed('audioFiles', true)
      book.coverPath = path.join(metadataFolder, 'cover.jpg')
      await book.save()
      global.ServerSettings.storeCoverWithItem = true

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('moved')
      const newDir = rel('Some Author', 'Loose Book')
      expect(listFiles(libraryDir)).to.not.include('Loose Book.m4b')
      expect(listFiles(newDir)).to.deep.equal(['Loose Book.m4b', 'cover.jpg'])
      const after = await loadItem(libraryItemId)
      expect(after.media.audioFiles.map((audioFile) => audioFile.exclude)).to.deep.equal([true])
      expect(after.media.coverPath).to.equal(path.join(newDir, 'cover.jpg'))
    })

    it('leaves the cover in the metadata folder when covers are not stored with the item', async () => {
      const libraryItemId = await addSingleFileBook('Loose Book.m4b', { title: 'Loose Book', authors: ['Some Author'] })
      const metadataFolder = path.join(global.MetadataPath, 'items', libraryItemId)
      fs.mkdirSync(metadataFolder, { recursive: true })
      fs.writeFileSync(path.join(metadataFolder, 'cover.jpg'), 'cover')
      const book = (await loadItem(libraryItemId)).media
      book.coverPath = path.join(metadataFolder, 'cover.jpg')
      await book.save()

      await manager.organizeItem(libraryItemId)

      expect(listFiles(rel('Some Author', 'Loose Book'))).to.deep.equal(['Loose Book.m4b'])
      expect((await loadItem(libraryItemId)).media.coverPath).to.equal(path.join(metadataFolder, 'cover.jpg'))
      expect(fs.existsSync(path.join(metadataFolder, 'cover.jpg'))).to.be.true
    })

    it('removes emptied parent folders but never a folder that still holds another book', async () => {
      const bookA = await addBook('Old Shelf/Book A', ['a.m4b'], { title: 'Book A', authors: ['Writer'] })
      const bookB = await addBook('Old Shelf/Book B', ['b.m4b'], { title: 'Book B', authors: ['Writer'] })

      await manager.organizeItem(bookA)

      expect(fs.existsSync(rel('Old Shelf', 'Book A'))).to.be.false
      expect(fs.readFileSync(rel('Old Shelf', 'Book B', 'b.m4b'), 'utf8')).to.equal('b.m4b')
      expect((await loadItem(bookB)).path).to.equal(rel('Old Shelf', 'Book B'))

      await manager.organizeItem(bookB)

      expect(fs.existsSync(rel('Old Shelf'))).to.be.false
      expect(fs.existsSync(libraryDir)).to.be.true
      expect(listFiles(rel('Writer'))).to.deep.equal(['Book A', 'Book A/Book A.m4b', 'Book B', 'Book B/Book B.m4b'])
    })

    it('renames files in place when the folder already matches', async () => {
      const libraryItemId = await addBook('Writer/Book', ['01.mp3', '02.mp3'], { title: 'Book', authors: ['Writer'] })

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('moved')
      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['Book - Part 1.mp3', 'Book - Part 2.mp3'])
      expect((await loadItem(libraryItemId)).path).to.equal(rel('Writer', 'Book'))
    })

    it('keeps subfolders inside the item', async () => {
      const libraryItemId = await addBook('Raw', ['CD1/Track 1.mp3', 'CD2/Track 1.mp3'], { title: 'Book', authors: ['Writer'] })

      await manager.organizeItem(libraryItemId)

      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['CD1', 'CD1/Book - Part 1.mp3', 'CD2', 'CD2/Book - Part 2.mp3'])
      expect(fs.readFileSync(rel('Writer', 'Book', 'CD2', 'Book - Part 2.mp3'), 'utf8')).to.equal('CD2/Track 1.mp3')
    })
  })

  describe('metadata of the book', () => {
    it('is kept when the files disagree with it', async () => {
      const libraryItemId = await addBook('Raw', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.writeFileSync(rel('Raw', 'metadata.json'), JSON.stringify({ title: 'Stale Title', authors: ['Stale Author'], narrators: ['Stale Narrator'] }))

      expect(await manager.organizeItem(libraryItemId)).to.deep.equal({ itemId: libraryItemId, status: 'moved' })

      const { media, path: itemPath } = await loadItem(libraryItemId)
      expect(itemPath).to.equal(rel('Writer', 'Book'))
      expect([media.title, media.authors.map((author) => author.name), media.narrators]).to.deep.equal(['Book', ['Writer'], []])
    })
  })

  describe('skipping and failing', () => {
    it('skips an item whose target is the path of a missing item', async () => {
      const missingId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Missing', authors: ['Writer'] })
      fs.rmSync(rel('Writer'), { recursive: true })
      await Database.libraryItemModel.update({ isMissing: true }, { where: { id: missingId } })
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

      const preview = await manager.previewItems([libraryItemId])
      const result = await manager.organizeItem(libraryItemId)

      expect(preview.plans.map((plan) => plan.skipReason)).to.deep.equal(['targetExists'])
      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetExists' })
      expect((await loadItem(libraryItemId)).path).to.equal(rel('Raw'))
    })

    it('skips an item whose target folder already exists and moves nothing', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.mkdirSync(rel('Writer', 'Book'), { recursive: true })
      fs.writeFileSync(rel('Writer', 'Book', 'other.m4b'), 'other')

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetExists' })
      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['other.m4b'])
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
    })

    it('skips an item whose target folder is inside the folder of another item', async () => {
      await addBook('Stephen King/The Dark Tower', ['tower.m4b'], { title: 'The Gunslinger', authors: ['Stephen King'], series: 'Other', sequence: '1' })
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'The Drawing of the Three', authors: ['Stephen King'], series: 'The Dark Tower', sequence: '2' })

      const result = await manager.organizeItem(libraryItemId)
      const preview = await manager.previewItems([libraryItemId])

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetInsideItem' })
      expect(preview.plans[0].skipReason).to.equal('targetInsideItem')
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.m4b', 'Stephen King', 'Stephen King/The Dark Tower', 'Stephen King/The Dark Tower/tower.m4b'])
    })

    it('skips an item whose target is a dangling symlink and leaves the symlink', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.mkdirSync(rel('Writer'))
      fs.symlinkSync(rel('nowhere'), rel('Writer', 'Book'))

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetExists' })
      expect(fs.readlinkSync(rel('Writer', 'Book'))).to.equal(rel('nowhere'))
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
    })

    it('skips an item when a new file name is already taken or two files would share a name', async () => {
      const taken = await addBook('Writer/Book', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      fs.writeFileSync(rel('Writer', 'Book', 'Book - Part 1.mp3'), 'unscanned file')
      expect((await manager.organizeItem(taken)).reason).to.equal('fileNameConflict')
      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['Book - Part 1.mp3', 'a.mp3', 'b.mp3'])

      await library.update({ settings: { ...library.settings, organizeFileTemplate: '{title}' } })
      const duplicate = await addBook('Other/Thing', ['a.mp3', 'b.mp3'], { title: 'Thing', authors: ['Other'] })
      expect((await manager.organizeItem(duplicate)).reason).to.equal('fileNameConflict')
    })

    it('skips an item that is missing on disk', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.rmSync(rel('Raw'), { recursive: true })

      expect((await manager.organizeItem(libraryItemId)).reason).to.equal('missing')
    })

    it('skips while its library is scanning and while someone is streaming it', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

      LibraryScanner.librariesScanning = [library.id]
      expect((await manager.organizeItem(libraryItemId)).reason).to.equal('libraryScanning')
      LibraryScanner.librariesScanning = []

      sessions.push({ id: 'play_1', libraryItemId })
      expect((await manager.organizeItem(libraryItemId)).reason).to.equal('streaming')
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true

      sessions.length = 0
      expect((await manager.organizeItem(libraryItemId)).status).to.equal('moved')
    })

    it('skips while a metadata embed or an m4b merge is queued or running for the item', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const otherItemId = await addBook('Raw Two', ['b.m4b'], { title: 'Other', authors: ['Writer'] })

      audioMetadataManager.getIsLibraryItemQueuedOrProcessing.callsFake((id) => id === libraryItemId)
      expect(await manager.organizeItem(libraryItemId)).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'toolRunning' })
      expect((await manager.previewItems([libraryItemId])).plans[0].skipReason).to.equal('toolRunning')
      audioMetadataManager.getIsLibraryItemQueuedOrProcessing.returns(false)

      abMergeManager.getPendingTaskByLibraryItemId.callsFake((id) => (id === libraryItemId ? { task: {} } : undefined))
      expect((await manager.organizeItem(libraryItemId)).reason).to.equal('toolRunning')
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
      expect((await manager.organizeItem(otherItemId)).status).to.equal('moved')

      abMergeManager.getPendingTaskByLibraryItemId.returns(undefined)
      expect((await manager.organizeItem(libraryItemId)).status).to.equal('moved')
    })

    it('skips a second request for an item that is already being organized', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const firstRun = manager.organizeItem(libraryItemId)
      const secondRun = await manager.organizeItem(libraryItemId)
      await firstRun

      expect(secondRun).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'inProgress' })
    })

    it('lets two runs that target the same folder organize one after the other', async () => {
      const firstId = await addSingleFileBook('first.m4b', { title: 'Book', authors: ['Writer'] })
      const secondId = await addSingleFileBook('second.m4b', { title: 'Book', authors: ['Writer'] })

      const results = await Promise.all([manager.organizeItem(firstId), manager.organizeItem(secondId)])

      expect(results).to.deep.equal([
        { itemId: firstId, status: 'moved' },
        { itemId: secondId, status: 'skipped', reason: 'targetExists' }
      ])
      expect(listFiles(libraryDir)).to.deep.equal(['Writer', 'Writer/Book', 'Writer/Book/Book.m4b', 'second.m4b'])
      expect(fs.readFileSync(rel('Writer', 'Book', 'Book.m4b'), 'utf8')).to.equal('first.m4b')
      expect(fs.readFileSync(rel('second.m4b'), 'utf8')).to.equal('second.m4b')
    })

    it('carries on with the next run after a run failed', async () => {
      const failingId = await addBook('Raw A', ['a.m4b'], { title: 'Book A', authors: ['Writer'] })
      const nextId = await addBook('Raw B', ['b.m4b'], { title: 'Book B', authors: ['Writer'] })
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').onFirstCall().rejects(new Error('scan exploded')).callThrough()

      const results = await Promise.all([manager.organizeItem(failingId), manager.organizeItem(nextId)])

      expect(results.map((result) => result.status)).to.deep.equal(['failed', 'moved'])
    })

    it('restores the files and reports the original error when the rescan fails', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3', 'cover.jpg'], { title: 'Book', authors: ['Writer'] })
      const before = await loadItem(libraryItemId)
      const realScan = LibraryItemScanner.scanLibraryItem.bind(LibraryItemScanner)
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').onFirstCall().rejects(new Error('scan exploded')).callsFake(realScan)

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'scan exploded' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3', 'Raw/cover.jpg'])
      const after = await loadItem(libraryItemId)
      expect(after.path).to.equal(before.path)
      expect(after.media.coverPath).to.equal(rel('Raw', 'cover.jpg'))
      expect(fs.existsSync(path.join(global.MetadataPath, 'organize', `${libraryItemId}.json`))).to.be.false
    })

    it('undoes the renames that already happened when the folder move fails', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      const realRename = fsExtra.rename
      sinon.stub(fsExtra, 'rename').callsFake((from, to) => (to === rel('Writer', 'Book') ? Promise.reject(new Error('disk full')) : realRename(from, to)))

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'disk full' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
      expect(fs.readFileSync(rel('Raw', 'a.mp3'), 'utf8')).to.equal('a.mp3')
    })

    it('removes the partial copy a move interrupted across file systems left behind', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      simulateCrossDeviceMoves()
      const realCopy = fsExtra.copy
      sinon.stub(fsExtra, 'copy').callsFake(async (from, to, options) => {
        if (from !== rel('Raw')) return realCopy(from, to, options)
        fs.mkdirSync(to)
        fs.writeFileSync(path.join(to, 'a.mp3'), 'partial')
        throw new Error('disk full')
      })

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'disk full' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
      expect(fs.readFileSync(rel('Raw', 'a.mp3'), 'utf8')).to.equal('a.mp3')
    })

    it('rescans the item at its original path when the failure comes after the rescan started', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3', 'cover.jpg'], { title: 'Book', authors: ['Writer'] })
      const realScan = LibraryItemScanner.scanLibraryItem.bind(LibraryItemScanner)
      sinon
        .stub(LibraryItemScanner, 'scanLibraryItem')
        .onFirstCall()
        .callsFake(async (...args) => {
          await realScan(...args)
          throw new Error('failed after the rescan')
        })
        .callsFake(realScan)

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'failed after the rescan' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3', 'Raw/cover.jpg'])
      const after = await loadItem(libraryItemId)
      expect(after.path).to.equal(rel('Raw'))
      expect(after.relPath).to.equal('Raw')
      expect(after.media.coverPath).to.equal(rel('Raw', 'cover.jpg'))
      expect(after.media.audioFiles.every((audioFile) => audioFile.metadata.path.startsWith(rel('Raw')))).to.be.true
    })

    it('removes the folders it created when it fails, but not the ones that already existed', async () => {
      fs.mkdirSync(rel('Writer'))
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').rejects(new Error('scan exploded'))

      await manager.organizeItem(libraryItemId)

      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.m4b', 'Writer'])
    })

    it('keeps a folder another writer created at the target after the plan was made', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      const realWriteJournal = manager.writeJournal.bind(manager)
      let isTargetCreated = false
      sinon.stub(manager, 'writeJournal').callsFake(async (journal) => {
        if (!isTargetCreated) {
          isTargetCreated = true
          fs.mkdirSync(rel('Writer', 'Book'), { recursive: true })
          fs.writeFileSync(rel('Writer', 'Book', 'sentinel.txt'), 'keep me')
        }
        return realWriteJournal(journal)
      })

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('failed')
      expect(result.error).to.include('the destination already exists')
      expect(fs.readFileSync(rel('Writer', 'Book', 'sentinel.txt'), 'utf8')).to.equal('keep me')
      expect(listFiles(rel('Raw'))).to.deep.equal(['a.mp3', 'b.mp3'])
    })

    it('does not replace a file another writer created while a copy across file systems ran', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      simulateCrossDeviceMoves()
      const realCopy = fsExtra.copy
      sinon.stub(fsExtra, 'copy').callsFake(async (from, to, options) => {
        await realCopy(from, to, options)
        if (from === rel('Raw', 'a.mp3')) fs.writeFileSync(rel('Raw', 'Book - Part 1.mp3'), 'keep me')
      })

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('failed')
      expect(fs.readFileSync(rel('Raw', 'Book - Part 1.mp3'), 'utf8')).to.equal('keep me')
      expect(listFiles(rel('Raw'))).to.deep.equal(['Book - Part 1.mp3', 'a.mp3', 'b.mp3'])
      expect(fs.readFileSync(rel('Raw', 'a.mp3'), 'utf8')).to.equal('a.mp3')
    })

    it('restores what a failed source removal deleted from the folder it copied across file systems', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      simulateCrossDeviceMoves()
      const realRemove = fsExtra.remove
      sinon.stub(fsExtra, 'remove').callsFake(async (target) => {
        if (target !== rel('Raw')) return realRemove(target)
        fs.rmSync(rel('Raw', 'Book - Part 1.mp3'))
        throw new Error('permission denied')
      })

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'permission denied' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
      expect(fs.readFileSync(rel('Raw', 'a.mp3'), 'utf8')).to.equal('a.mp3')
      expect(fs.readFileSync(rel('Raw', 'b.mp3'), 'utf8')).to.equal('b.mp3')
    })

    describe('with a read-only subfolder', () => {
      beforeEach(function () {
        // The permission checks these tests rely on do not apply to root
        if (process.getuid() === 0) this.skip()
      })

      afterEach(() => {
        execFileSync('chmod', ['-R', 'u+rwX', tmpDir]) // So the temp folder can be removed even when a test left read-only folders
      })

      it('removes the copy again when the source cannot be removed', async () => {
        const libraryItemId = await addBook('Raw', ['a.mp3', 'sub/notes.txt'], { title: 'Book', authors: ['Writer'] })
        fs.chmodSync(rel('Raw', 'sub'), 0o555)
        simulateCrossDeviceMoves()

        const result = await manager.organizeItem(libraryItemId)

        expect(result.status).to.equal('failed')
        expect(result.error).to.contain('EACCES')
        expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/sub', 'Raw/sub/notes.txt'])
        expect(fs.readdirSync(path.join(global.MetadataPath, 'organize'))).to.deep.equal([])
        expect((await loadItem(libraryItemId)).path).to.equal(rel('Raw'))
      })

      it('removes a partial copy that came out read-only', async () => {
        const libraryItemId = await addBook('Raw', ['a.mp3'], { title: 'Book', authors: ['Writer'] })
        simulateCrossDeviceMoves()
        const realCopy = fsExtra.copy
        sinon.stub(fsExtra, 'copy').callsFake(async (from, to, options) => {
          if (from !== rel('Raw')) return realCopy(from, to, options)
          fs.mkdirSync(path.join(to, 'sub'), { recursive: true })
          fs.writeFileSync(path.join(to, 'sub', 'partial.txt'), 'partial')
          fs.chmodSync(path.join(to, 'sub'), 0o555)
          throw new Error('disk full')
        })

        const result = await manager.organizeItem(libraryItemId)

        expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'disk full' })
        expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3'])
        expect(fs.readdirSync(path.join(global.MetadataPath, 'organize'))).to.deep.equal([])
      })
    })

    it('restores the files of a run that crashed after the copy was complete', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      simulateCrossDeviceMoves()
      const realRemove = fsExtra.remove
      sinon.stub(fsExtra, 'remove').callsFake(async (target) => {
        if (target !== rel('Raw')) return realRemove(target)
        fs.rmSync(rel('Raw', 'Book - Part 1.mp3'))
        throw new Error('process killed')
      })
      sinon.stub(manager, 'rollback').resolves()
      await manager.organizeItem(libraryItemId)
      manager.rollback.restore()
      fsExtra.remove.restore()

      await newManager().recoverInterrupted()

      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
      expect(fs.readFileSync(rel('Raw', 'b.mp3'), 'utf8')).to.equal('b.mp3')
      expect(fs.readdirSync(path.join(global.MetadataPath, 'organize'))).to.deep.equal([])
    })

    it('moves a rename back when it landed but the step was not recorded as done', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      const realRename = fsExtra.rename
      sinon.stub(fsExtra, 'rename').callsFake(async (from, to) => {
        await realRename(from, to)
        if (to === rel('Raw', 'Book - Part 1.mp3')) throw new Error('lost connection')
      })

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'lost connection' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
    })

    it('renames a file whose new name is the same file under another name', async () => {
      const libraryItemId = await addBook('Writer/Book', ['book.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.linkSync(rel('Writer', 'Book', 'book.m4b'), rel('Writer', 'Book', 'Book.m4b'))

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'moved' })
      expect(fs.readFileSync(rel('Writer', 'Book', 'Book.m4b'), 'utf8')).to.equal('book.m4b')
    })

    it('renames a folder that a case-insensitive file system reports as already there', async () => {
      const libraryItemId = await addBook('Writer/book', ['book.m4b'], { title: 'Book', authors: ['Writer'] })
      const realLstat = fsExtra.lstat
      sinon.stub(fsExtra, 'lstat').callsFake((target) => realLstat(target === rel('Writer', 'Book') ? rel('Writer', 'book') : target))

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'moved' })
      expect(listFiles(rel('Writer'))).to.deep.equal(['Book', 'Book/Book.m4b'])
    })

    it('keeps both names when undoing a rename of a file that is the same file under another name', async () => {
      const libraryItemId = await addBook('Writer/Book', ['book.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.linkSync(rel('Writer', 'Book', 'book.m4b'), rel('Writer', 'Book', 'Book.m4b'))
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').rejects(new Error('scan exploded'))

      const result = await manager.organizeItem(libraryItemId)

      expect(result.status).to.equal('failed')
      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['Book.m4b', 'book.m4b'])
      expect(fs.readFileSync(rel('Writer', 'Book', 'book.m4b'), 'utf8')).to.equal('book.m4b')
    })

    it('does not remove the copy when it is the source file', async () => {
      fs.writeFileSync(rel('a.mp3'), 'audio')
      fs.linkSync(rel('a.mp3'), rel('b.mp3'))

      await manager.restoreSourceFromCopy({ from: rel('a.mp3'), to: rel('b.mp3'), state: 'copied', tempPath: rel('missing.tmp') })

      expect(fs.readFileSync(rel('a.mp3'), 'utf8')).to.equal('audio')
      expect(fs.readFileSync(rel('b.mp3'), 'utf8')).to.equal('audio')
    })

    it('finishes or rolls back a run that was interrupted before the next startup', async () => {
      const rolledBackId = await addBook('Raw A', ['a.mp3', 'b.mp3'], { title: 'Book A', authors: ['Writer'] })
      sinon.stub(manager, 'rollback').resolves()
      sinon.stub(manager, 'runSteps').callsFake(async (journal) => {
        await fsExtra.rename(journal.steps[0].from, journal.steps[0].to)
        journal.steps[0].state = 'done'
        await manager.writeJournal(journal)
        throw new Error('process killed')
      })
      await manager.organizeItem(rolledBackId)
      expect(listFiles(rel('Raw A'))).to.not.include('a.mp3')
      manager.runSteps.restore()
      manager.rollback.restore()

      const finishedId = await addBook('Raw B', ['c.m4b'], { title: 'Book B', authors: ['Writer'] })
      sinon.stub(manager, 'rollback').resolves()
      const realScan = LibraryItemScanner.scanLibraryItem.bind(LibraryItemScanner)
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').callsFake(async () => {
        throw new Error('process killed')
      })
      await manager.organizeItem(finishedId)
      expect(fs.existsSync(rel('Writer', 'Book B', 'Book B.m4b'))).to.be.true
      manager.rollback.restore()
      LibraryItemScanner.scanLibraryItem.callsFake(realScan)

      await newManager().recoverInterrupted()

      expect(listFiles(rel('Raw A'))).to.deep.equal(['a.mp3', 'b.mp3'])
      expect((await loadItem(finishedId)).path).to.equal(rel('Writer', 'Book B'))
      expect(fs.readdirSync(path.join(global.MetadataPath, 'organize'))).to.deep.equal([])
    })
  })

  describe('recovery', () => {
    it('restores the choices when it finishes a run that crashed after the rescan started', async () => {
      const libraryItemId = await addBookWithChoices()
      const before = await describeChoices(libraryItemId)
      sinon.stub(manager, 'rollback').resolves()
      const realScan = LibraryItemScanner.scanLibraryItem.bind(LibraryItemScanner)
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').rejects(new Error('process killed'))
      await manager.organizeItem(libraryItemId)
      LibraryItemScanner.scanLibraryItem.callsFake(realScan)

      await newManager().recoverInterrupted()

      expect((await loadItem(libraryItemId)).path).to.equal(rel('Writer', 'Book'))
      expect(await describeChoices(libraryItemId)).to.deep.equal(before)
    })
  })

  describe('feeds', () => {
    it('points feed episodes at the new file paths', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      const before = await loadItem(libraryItemId)
      const feed = await Database.feedModel.create({ slug: 'feed-1', entityType: 'libraryItem', entityId: libraryItemId, entityUpdatedAt: new Date(), coverPath: rel('Raw', 'cover.jpg'), serverAddress: 'http://localhost', feedURL: '/feed/feed-1' })
      for (const audioFile of before.media.audioFiles) {
        await Database.feedEpisodeModel.create({ feedId: feed.id, title: audioFile.metadata.filename, filePath: audioFile.metadata.path, enclosureURL: `/feed/feed-1/item/${audioFile.index}/media.mp3` })
      }

      await manager.organizeItem(libraryItemId)

      const episodes = await Database.feedEpisodeModel.findAll({ where: { feedId: feed.id } })
      expect(episodes.map((episode) => episode.filePath).sort()).to.deep.equal([rel('Writer', 'Book', 'Book - Part 1.mp3'), rel('Writer', 'Book', 'Book - Part 2.mp3')])
      expect(episodes.every((episode) => fs.existsSync(episode.filePath))).to.be.true
    })
  })

  describe('preview and confirmed runs', () => {
    it('lists items that would change with warnings, and only counts organized items', async () => {
      const toMove = await addBook('Raw', ['a.m4b'], { title: 'Foo: Bar', authors: ['Writer'] })
      await addBook('Writer/Done', ['d.m4b'], { title: 'Done', authors: ['Writer'] })
      fs.renameSync(rel('Writer', 'Done', 'd.m4b'), rel('Writer', 'Done', 'Done.m4b'))
      const organized = await addBook('Writer/Organized', ['Organized.m4b'], { title: 'Organized', authors: ['Writer'] })

      const preview = await manager.previewItems([toMove, organized])

      expect(preview.unchangedCount).to.equal(1)
      expect(preview.plans).to.have.length(1)
      const [plan] = preview.plans
      expect(plan).to.include({ itemId: toMove, title: 'Foo: Bar', fromPath: rel('Raw'), toPath: rel('Writer', 'Foo - Bar'), fromRelPath: 'Raw', toRelPath: 'Writer/Foo - Bar', skipReason: null, changed: true })
      expect(plan.fileRenames).to.deep.equal([{ from: 'a.m4b', to: 'Foo - Bar.m4b' }])
      expect(plan.warnings).to.deep.equal([{ field: 'title', expected: 'Foo: Bar', parsed: 'Foo - Bar' }])
      expect(plan.hash).to.be.a('string')
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
    })

    it('does not list the file of a single-file item as renamed when it keeps its name', async () => {
      const libraryItemId = await addSingleFileBook('Loose.m4b', { title: 'Loose', authors: ['Writer'] })

      const { plans } = await manager.previewItems([libraryItemId])

      expect(plans).to.have.length(1)
      expect(plans[0]).to.include({ toRelPath: 'Writer/Loose', changed: true })
      expect(plans[0].fileRenames).to.deep.equal([])
    })

    it('skips an item whose plan changed since the preview', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const [{ hash }] = (await manager.previewItems([libraryItemId])).plans
      await setMetadata(libraryItemId, { title: 'Book Renamed', authors: [] })

      const result = await manager.organizeItem(libraryItemId, hash)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'planChanged' })
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
    })

    it('a task organizes every item, counts the results and carries on after a failure', async () => {
      const first = await addBook('Raw 1', ['a.m4b'], { title: 'One', authors: ['Writer'] })
      const second = await addBook('Raw 2', ['b.m4b'], { title: 'Two', authors: ['Writer'] })
      const third = await addBook('Raw 3', ['c.m4b'], { title: 'Three', authors: ['Writer'] })
      fs.mkdirSync(rel('Writer', 'Three'), { recursive: true })
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').callsFake(async (id) => {
        if (id === first) throw new Error('scan exploded')
        return 2
      })
      const task = TaskManager.createAndAddTask('organize-files', { text: 'Organizing files' }, null, true)

      await manager.runTask(task, [first, second, third], null)

      expect(task.isFinished).to.be.true
      expect(task.descriptionKey).to.equal('MessageTaskOrganizeResult')
      expect(task.descriptionSubs).to.deep.equal(['1', '1', '1'])
      expect(task.data.results).to.deep.equal([
        { itemId: first, title: 'One', status: 'failed', error: 'scan exploded' },
        { itemId: third, title: 'Three', status: 'skipped', reason: 'targetExists' }
      ])
      expect(fs.existsSync(rel('Raw 1', 'a.m4b'))).to.be.true
      expect(fs.existsSync(rel('Writer', 'Two', 'Two.m4b'))).to.be.true
      expect(fs.existsSync(rel('Raw 3', 'c.m4b'))).to.be.true
    })
  })

  describe('item paths of the library', () => {
    it('are loaded once for a preview of many items', async () => {
      const ids = []
      for (let i = 0; i < 5; i++) ids.push(await addBook(`Raw ${i}`, ['a.m4b'], { title: `Book ${i}`, authors: ['Writer'] }))
      const findByAncestorPath = sinon.spy(Database.libraryItemModel, 'findByAncestorPath')
      const findAll = sinon.spy(Database.libraryItemModel, 'findAll')

      const preview = await manager.previewItems(ids)

      expect(preview.plans).to.have.length(5)
      expect(findByAncestorPath.called).to.be.false
      expect(findAll.getCalls().filter((call) => call.args[0]?.attributes?.[0] === 'path')).to.have.length(1)

      // A book added after the preview is seen by the next preview
      await addBook('Writer', ['w.m4b'], { title: 'Writer Book', authors: ['Someone'] })
      const nextPreview = await manager.previewItems(ids)
      expect(nextPreview.plans.map((plan) => plan.skipReason)).to.deep.equal(Array(5).fill('targetInsideItem'))
    })

    it('are loaded once for a task and include the folders earlier items moved to', async () => {
      const saga = await addBook('Raw 1', ['a.m4b'], { title: 'Saga', authors: ['Writer'] })
      const bookOfSaga = await addBook('Raw 2', ['b.m4b'], { title: 'One', authors: ['Writer'], series: 'Saga', sequence: '1' })
      const other = await addBook('Raw 3', ['c.m4b'], { title: 'Other', authors: ['Writer'] })
      const findByAncestorPath = sinon.spy(Database.libraryItemModel, 'findByAncestorPath')
      const findAll = sinon.spy(Database.libraryItemModel, 'findAll')
      const task = TaskManager.createAndAddTask('organize-files', { text: 'Organizing files' }, null, true)

      await manager.runTask(task, [saga, bookOfSaga, other], null)

      expect(task.descriptionSubs).to.deep.equal(['2', '1', '0'])
      expect(task.data.results).to.deep.equal([{ itemId: bookOfSaga, title: 'One', status: 'skipped', reason: 'targetInsideItem' }])
      expect(listFiles(rel('Writer'))).to.deep.equal(['Other', 'Other/Other.m4b', 'Saga', 'Saga/Saga.m4b'])
      expect(fs.existsSync(rel('Raw 2', 'b.m4b'))).to.be.true
      // Planning uses the loaded paths. Only the two items that move are looked up right before their move
      expect(findByAncestorPath.callCount).to.equal(2)
      expect(findAll.getCalls().filter((call) => call.args[0]?.attributes?.[0] === 'path')).to.have.length(1)
    })

    it('are looked up in the database when no preview or task is running', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const findByAncestorPath = sinon.spy(Database.libraryItemModel, 'findByAncestorPath')

      expect((await manager.organizeItem(libraryItemId)).status).to.equal('moved')

      // Once to plan and once right before the move
      expect(findByAncestorPath.calledTwice).to.be.true
    })

    it('do not hide an item added after they were loaded from the check made right before a move', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

      const result = await manager.withSharedItemPaths(async () => {
        await manager.getItemPaths(library.id)
        await addBook('Writer', ['w.m4b'], { title: 'Writer Book', authors: ['Someone'] })
        return manager.organizeItem(libraryItemId)
      })

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetInsideItem' })
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
      expect(fs.existsSync(rel('Writer', 'Book'))).to.be.false
    })

    describe('of a missing item', () => {
      // Only the row is left, so the folder checks on disk cannot see it
      async function addMissingBook(relDir) {
        const missingId = await addBook(relDir, ['Sub.m4b'], { title: 'Missing', authors: ['Writer'] })
        fs.rmSync(rel(relDir.split('/')[0]), { recursive: true })
        await Database.libraryItemModel.update({ isMissing: true }, { where: { id: missingId } })
      }

      it('below the target skip the item in a preview and when organizing it', async () => {
        await addMissingBook('Writer/Book/2. Sub')
        const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

        const preview = await manager.previewItems([libraryItemId])
        const result = await manager.organizeItem(libraryItemId)

        expect(preview.plans.map((plan) => plan.skipReason)).to.deep.equal(['targetExists'])
        expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetExists' })
        expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
      })

      it('below the target skip the item in the check made right before a move', async () => {
        const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

        const result = await manager.withSharedItemPaths(async () => {
          await manager.getItemPaths(library.id)
          await addMissingBook('Writer/Book/2. Sub')
          return manager.organizeItem(libraryItemId)
        })

        expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetExists' })
        expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true
      })

      it('are not found by the ignored path', async () => {
        await addMissingBook('Writer/Book/2. Sub')

        expect(await Database.libraryItemModel.findByDescendantPath(rel('Writer', 'Book'), rel('Raw'))).to.not.be.null
        expect(await Database.libraryItemModel.findByDescendantPath(rel('Writer', 'Book'), rel('Writer', 'Book', '2. Sub'))).to.be.null
      })

      it('beside the target and named like it do not block the item', async () => {
        await addMissingBook('Writer/Book Messiah')
        await addMissingBook('Writer/Booker')
        await addMissingBook('Writer/Bak/2. Sub')
        const prefixId = await addBook('Raw 1', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
        const wildcardId = await addBook('Raw 2', ['b.m4b'], { title: 'B_k', authors: ['Writer'] })

        const preview = await manager.previewItems([prefixId, wildcardId])
        const results = [await manager.organizeItem(prefixId), await manager.organizeItem(wildcardId)]

        expect(preview.plans.map((plan) => plan.skipReason)).to.deep.equal([null, null])
        expect(results).to.deep.equal([
          { itemId: prefixId, status: 'moved' },
          { itemId: wildcardId, status: 'moved' }
        ])
      })
    })
  })

  describe('tasks with a preview', () => {
    it('leaves alone the items the preview did not list', async () => {
      const previewed = await addBook('Raw 1', ['a.m4b'], { title: 'One', authors: ['Writer'] })
      const notPreviewed = await addBook('Raw 2', ['b.m4b'], { title: 'Two', authors: ['Writer'] })
      const { plans } = await manager.previewItems([previewed])
      const task = TaskManager.createAndAddTask('organize-files', { text: 'Organizing files' }, null, true)

      await manager.runTask(task, [previewed, notPreviewed], { [previewed]: plans[0].hash })

      expect(fs.existsSync(rel('Writer', 'One', 'One.m4b'))).to.be.true
      expect(fs.existsSync(rel('Raw 2', 'b.m4b'))).to.be.true
      expect(task.data.results).to.deep.equal([{ itemId: notPreviewed, title: 'Two', status: 'skipped', reason: 'notPreviewed' }])
    })
  })

  describe('task results', () => {
    it('lists at most 100 items that were not organized, while the counts cover all of them', async () => {
      const missingIds = Array.from({ length: 105 }, (_, i) => `li_missing_${i}`)
      const task = TaskManager.createAndAddTask('organize-files', { text: 'Organizing files' }, null, true)

      await manager.runTask(task, missingIds, null)

      expect(task.descriptionSubs).to.deep.equal(['0', '105', '0'])
      expect(task.data.results).to.have.length(100)
      expect(task.data.results[0]).to.deep.equal({ itemId: 'li_missing_0', title: null, status: 'skipped', reason: 'missing' })
    })
  })

  describe('auto organize', () => {
    it('only organizes when the library setting is on', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })

      const targetWhileOff = await manager.getAutoOrganizeTarget(await loadItem(libraryItemId))
      await setMetadata(libraryItemId, { title: 'Book Two', authors: ['Writer'] })
      expect(targetWhileOff).to.be.null
      expect(await manager.autoOrganizeItem(libraryItemId, targetWhileOff)).to.be.null
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true

      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const targetBefore = await manager.getAutoOrganizeTarget(await loadItem(libraryItemId))
      await setMetadata(libraryItemId, { title: 'Book Three', authors: ['Writer'] })
      const movedItem = await manager.autoOrganizeItem(libraryItemId, targetBefore)
      expect(movedItem.path).to.equal(rel('Writer', 'Book Three'))
      expect(fs.existsSync(rel('Writer', 'Book Three', 'Book Three.m4b'))).to.be.true
      expect(await manager.autoOrganizeItem(libraryItemId, targetBefore)).to.be.null
    })

    it('logs the error of a failed library lookup and starts no task', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const lookupError = new Error('lookup exploded')
      sinon.stub(manager, 'getLibraryIdsOfItems').rejects(lookupError)
      const startTask = sinon.spy(manager, 'startTask')

      await manager.autoOrganizeItemsInBackground(new Map([[libraryItemId, 'target']]))

      expect(Logger.error.calledOnceWith('[OrganizeManager] Failed to start auto organize of edited items', lookupError)).to.be.true
      expect(startTask.called).to.be.false
    })

    it('runs after a metadata edit through the controller and returns the moved item', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      const req = { body: { metadata: { title: 'Book Two' } }, libraryItem: await loadItem(libraryItemId) }
      const res = { json: sinon.spy() }

      await LibraryItemController.updateMedia.call({ organizeManager: manager }, req, res)

      expect(fs.existsSync(rel('Writer', 'Book Two', 'Book Two.m4b'))).to.be.true
      expect(fs.existsSync(rel('Writer', 'Book'))).to.be.false
      expect(res.json.firstCall.args[0].libraryItem.path).to.equal(rel('Writer', 'Book Two'))
    })

    it('keeps the edited metadata when the folder metadata.json is stale', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.copyFileSync(path.join(global.MetadataPath, 'items', libraryItemId, 'metadata.json'), rel('Writer', 'Book', 'metadata.json'))
      const req = { body: { metadata: { title: 'Book Two' } }, libraryItem: await loadItem(libraryItemId) }

      await LibraryItemController.updateMedia.call({ organizeManager: manager }, req, { json: sinon.spy() })

      const { media, path: itemPath } = await loadItem(libraryItemId)
      expect(itemPath).to.equal(rel('Writer', 'Book Two'))
      expect([media.title, media.authors.map((author) => author.name)]).to.deep.equal(['Book Two', ['Writer']])
    })

    it('runs a batch edit in a background task after the response', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      const req = { user: { canUpdate: true, checkCanAccessLibraryItem: () => true }, body: [{ id: libraryItemId, mediaPayload: { metadata: { title: 'Book Two' } } }] }
      let wasMovedAtResponse = null
      const res = { json: sinon.spy(() => (wasMovedAtResponse = fs.existsSync(rel('Writer', 'Book Two')))) }
      const runTask = sinon.spy(manager, 'runTask')
      sinon.spy(manager, 'autoOrganizeItemsInBackground')

      await LibraryItemController.batchUpdate.call({ organizeManager: manager }, req, res)
      await manager.autoOrganizeItemsInBackground.returnValues[0]
      await runTask.firstCall.returnValue

      expect(res.json.firstCall.args[0]).to.deep.equal({ success: true, updates: 1 })
      expect(wasMovedAtResponse).to.be.false
      expect(fs.existsSync(rel('Writer', 'Book Two', 'Book Two.m4b'))).to.be.true
    })

    it('leaves a batch edit alone when its library has auto organize off', async () => {
      const libraryItemId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      const startTask = sinon.spy(manager, 'startTask')

      await manager.autoOrganizeItemsInBackground(new Map([[libraryItemId, null]]))

      expect(startTask.called).to.be.false
      expect(fs.existsSync(rel('Writer', 'Book', 'Book.m4b'))).to.be.true
    })

    it('runs after a quick match and returns the moved item', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      sinon.stub(BookFinder, 'search').resolves([{ title: 'Matched Title', author: 'Writer' }])

      const result = await Scanner.quickMatchLibraryItem({ organizeManager: manager }, await loadItem(libraryItemId), { provider: 'google', overrideDetails: true })

      expect(result.updated).to.be.true
      expect(fs.existsSync(rel('Writer', 'Matched Title', 'Matched Title.m4b'))).to.be.true
      expect(result.libraryItem.path).to.equal(rel('Writer', 'Matched Title'))
    })

    it('organizes the items a match all run matched, but not during a file scan', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const matchedId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      sinon
        .stub(BookFinder, 'search')
        .onFirstCall()
        .resolves([{ title: 'Matched Title', author: 'Writer' }])
        .onSecondCall()
        .resolves([{ title: 'Second Title', author: 'Writer' }])
      Database.serverSettings = { scannerFindCovers: false, scannerPreferMatchedMetadata: true }

      await Scanner.matchLibraryItems({ organizeManager: manager }, library)

      expect(fs.existsSync(rel('Writer', 'Matched Title', 'Matched Title.m4b'))).to.be.true
      expect((await loadItem(matchedId)).path).to.equal(rel('Writer', 'Matched Title'))
      expect(LibraryScanner.isLibraryScanning(library.id)).to.be.false
      expect(LibraryScanner.librariesMatching).to.deep.equal([])

      LibraryScanner.librariesScanning = [library.id]
      const result = await Scanner.quickMatchLibraryItem({ organizeManager: manager }, await loadItem(matchedId), { provider: 'google', overrideDetails: true })

      expect(result.libraryItem.media.metadata.title).to.equal('Second Title')
      expect(listFiles(rel('Writer'))).to.deep.equal(['Matched Title', 'Matched Title/Matched Title.m4b'])
    })

    it('does not run when the edit changed nothing', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addBook('Raw', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      const req = { body: { metadata: { title: 'Book' } }, libraryItem: await loadItem(libraryItemId) }
      const res = { json: sinon.spy() }
      const autoOrganize = sinon.spy(manager, 'autoOrganizeItem')

      await LibraryItemController.updateMedia.call({ organizeManager: manager }, req, res)

      expect(res.json.calledOnce).to.be.true
      expect(autoOrganize.called).to.be.false
      expect(fs.existsSync(rel('Raw', 'Book.m4b'))).to.be.true
    })

    describe('an edit that leaves the target unchanged', () => {
      beforeEach(async () => {
        await library.update({ settings: { ...library.settings, autoOrganize: true } })
      })

      it('does not move an unorganized book after a single edit of its description', async () => {
        const libraryItemId = await addBook('Raw', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
        const req = { body: { metadata: { description: 'A new description' } }, libraryItem: await loadItem(libraryItemId) }
        const res = { json: sinon.spy() }

        await LibraryItemController.updateMedia.call({ organizeManager: manager }, req, res)

        expect(res.json.firstCall.args[0].updated).to.be.true
        expect(fs.existsSync(rel('Raw', 'Book.m4b'))).to.be.true
        expect(fs.existsSync(rel('Writer'))).to.be.false
      })

      it('does not move an unorganized book after a batch edit of its description', async () => {
        const libraryItemId = await addBook('Raw', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
        const req = { user: { canUpdate: true, checkCanAccessLibraryItem: () => true }, body: [{ id: libraryItemId, mediaPayload: { metadata: { description: 'A new description' } } }] }
        const res = { json: sinon.spy() }
        const startTask = sinon.spy(manager, 'startTask')
        sinon.spy(manager, 'autoOrganizeItemsInBackground')

        await LibraryItemController.batchUpdate.call({ organizeManager: manager }, req, res)
        await manager.autoOrganizeItemsInBackground.returnValues[0]

        expect(res.json.firstCall.args[0]).to.deep.equal({ success: true, updates: 1 })
        expect(startTask.called).to.be.false
        expect(fs.existsSync(rel('Raw', 'Book.m4b'))).to.be.true
      })

      it('does not move an unorganized book after a quick match that only adds a description', async () => {
        const libraryItemId = await addBook('Raw', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
        sinon.stub(BookFinder, 'search').resolves([{ title: 'Book', author: 'Writer', description: 'Matched description' }])

        const result = await Scanner.quickMatchLibraryItem({ organizeManager: manager }, await loadItem(libraryItemId), { provider: 'google', overrideDetails: true })

        expect(result.updated).to.be.true
        expect((await loadItem(libraryItemId)).media.description).to.equal('Matched description')
        expect(fs.existsSync(rel('Raw', 'Book.m4b'))).to.be.true
      })
    })
  })

  describe('author and series edits', () => {
    const NO_SERIES_TEMPLATE = '{author}/{title}'

    async function enableAutoOrganize(settings = {}) {
      await library.update({ settings: { ...library.settings, autoOrganize: true, ...settings } })
    }

    function makeRes() {
      return { json: sinon.spy() }
    }

    async function runEditAndWaitForOrganize(edit) {
      const runTask = sinon.spy(manager, 'runTask')
      const autoOrganize = sinon.spy(manager, 'autoOrganizeItemsInBackground')
      await edit()
      await autoOrganize.returnValues[0]
      if (runTask.called) await runTask.firstCall.returnValue
    }

    /** A folder metadata.json from before the edit. The scanner reads it ahead of the server's copy. */
    async function leaveStaleFolderMetadata(libraryItemId) {
      const libraryItem = await loadItem(libraryItemId)
      fs.copyFileSync(path.join(global.MetadataPath, 'items', libraryItemId, 'metadata.json'), path.join(libraryItem.path, 'metadata.json'))
    }

    async function getAuthorNames(libraryItemId) {
      return (await loadItem(libraryItemId)).media.authors.map((author) => author.name)
    }

    function renameAuthor(authorName, newName) {
      return runEditAndWaitForOrganize(async () => {
        await libraryFilters.getFilterData('book', library.id) // A running server has it cached by now
        const author = await Database.authorModel.findOne({ where: { name: authorName, libraryId: library.id } })
        await AuthorController.update.call({ organizeManager: manager }, { body: { name: newName }, author }, makeRes())
      })
    }

    function renameSeries(seriesName, newName) {
      return runEditAndWaitForOrganize(async () => {
        await libraryFilters.getFilterData('book', library.id)
        const series = await Database.seriesModel.findOne({ where: { name: seriesName, libraryId: library.id } })
        await SeriesController.update.call({ organizeManager: manager }, { body: { name: newName }, series }, makeRes())
      })
    }

    describe('renaming an author', () => {
      it('moves every book of the author', async () => {
        await enableAutoOrganize()
        const first = await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        const second = await addBook('Raw Second', ['Second.m4b'], { title: 'Second' })
        const author = await Database.authorModel.findOne({ where: { name: 'Old' } })
        await Database.bookAuthorModel.create({ bookId: (await loadItem(second)).mediaId, authorId: author.id })

        await renameAuthor('Old', 'New')

        expect(fs.existsSync(rel('New', 'First', 'First.m4b'))).to.be.true
        expect(fs.existsSync(rel('New', 'Second', 'Second.m4b'))).to.be.true
        expect(fs.existsSync(rel('Old'))).to.be.false
        expect((await loadItem(first)).path).to.equal(rel('New', 'First'))
        expect((await loadItem(second)).path).to.equal(rel('New', 'Second'))
      })

      it('keeps the renamed author on a book whose folder metadata.json names the old one', async () => {
        await enableAutoOrganize()
        const libraryItemId = await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        await leaveStaleFolderMetadata(libraryItemId)

        await renameAuthor('Old', 'New')

        expect((await loadItem(libraryItemId)).path).to.equal(rel('New', 'First'))
        expect(await getAuthorNames(libraryItemId)).to.deep.equal(['New'])
      })

      it('leaves books alone when their library has auto organize off', async () => {
        await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        const startTask = sinon.spy(manager, 'startTask')

        await renameAuthor('Old', 'New')

        expect(startTask.called).to.be.false
        expect(fs.existsSync(rel('Raw First', 'First.m4b'))).to.be.true
        expect(fs.existsSync(rel('New'))).to.be.false
      })

      it('moves only the books of libraries with auto organize on', async () => {
        await enableAutoOrganize()
        const otherDir = path.join(tmpDir, 'other-library')
        fs.mkdirSync(path.join(otherDir, 'Old', 'Elsewhere'), { recursive: true })
        fs.writeFileSync(path.join(otherDir, 'Old', 'Elsewhere', 'Elsewhere.m4b'), 'x')
        const otherLibrary = await Database.libraryModel.create({ name: 'Other', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
        const otherFolder = await Database.libraryFolderModel.create({ path: otherDir, libraryId: otherLibrary.id })
        otherLibrary.libraryFolders = [otherFolder]
        await LibraryItemScanner.scanPotentialNewLibraryItem(path.join(otherDir, 'Old', 'Elsewhere'), otherLibrary, otherFolder, false)
        await addBook('Raw Here', ['Here.m4b'], { title: 'Here', authors: ['Old'] })
        const sharedAuthor = await Database.authorModel.findOne({ where: { name: 'Old', libraryId: library.id } })
        const otherItem = await Database.libraryItemModel.findOne({ where: { libraryId: otherLibrary.id } })
        await Database.bookAuthorModel.create({ bookId: otherItem.mediaId, authorId: sharedAuthor.id })

        await renameAuthor('Old', 'New')

        expect(fs.existsSync(rel('New', 'Here', 'Here.m4b'))).to.be.true
        expect(fs.existsSync(path.join(otherDir, 'Old', 'Elsewhere', 'Elsewhere.m4b'))).to.be.true
      })

      it('moves nothing when the name is unchanged or only the description changes', async () => {
        await enableAutoOrganize()
        await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        const startTask = sinon.spy(manager, 'startTask')
        const author = await Database.authorModel.findOne({ where: { name: 'Old' } })

        await AuthorController.update.call({ organizeManager: manager }, { body: { name: 'Old', description: 'About' }, author }, makeRes())

        expect(startTask.called).to.be.false
        expect(fs.existsSync(rel('Raw First', 'First.m4b'))).to.be.true
      })

      it('merges into an existing author and moves the books of the merged author', async () => {
        await enableAutoOrganize()
        const merged = await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        const untouched = await addBook('Raw Second', ['Second.m4b'], { title: 'Second', authors: ['Writer'] })

        await renameAuthor('Old', 'Writer')

        expect(fs.existsSync(rel('Writer', 'First', 'First.m4b'))).to.be.true
        expect(fs.existsSync(rel('Old'))).to.be.false
        expect((await loadItem(merged)).path).to.equal(rel('Writer', 'First'))
        expect((await loadItem(untouched)).path).to.equal(rel('Raw Second'))
      })

      it('keeps the merged author on a book whose folder metadata.json names the old one', async () => {
        await enableAutoOrganize()
        const merged = await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        await addBook('Raw Second', ['Second.m4b'], { title: 'Second', authors: ['Writer'] })
        await leaveStaleFolderMetadata(merged)

        await renameAuthor('Old', 'Writer')

        expect((await loadItem(merged)).path).to.equal(rel('Writer', 'First'))
        expect(await getAuthorNames(merged)).to.deep.equal(['Writer'])
        expect(await Database.authorModel.findOne({ where: { name: 'Old' } })).to.be.null
      })

      it('does not move a merged book when its library has auto organize off', async () => {
        await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Old'] })
        await addBook('Raw Second', ['Second.m4b'], { title: 'Second', authors: ['Writer'] })
        const startTask = sinon.spy(manager, 'startTask')

        await renameAuthor('Old', 'Writer')

        expect(startTask.called).to.be.false
        expect(fs.existsSync(rel('Raw First', 'First.m4b'))).to.be.true
      })
    })

    describe('renaming a series', () => {
      it('moves every book of the series and keeps the new series name after the rescan', async () => {
        await enableAutoOrganize()
        const first = await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Writer'], series: 'Old Saga', sequence: '1' })
        const secondId = await addBook('Raw Second', ['Second.m4b'], { title: 'Second', authors: ['Writer'] })
        const series = await Database.seriesModel.findOne({ where: { name: 'Old Saga' } })
        await Database.bookSeriesModel.create({ bookId: (await loadItem(secondId)).mediaId, seriesId: series.id, sequence: '2' })
        await (await loadItem(secondId)).saveMetadataFile()

        await renameSeries('Old Saga', 'New Saga')

        expect(fs.existsSync(rel('Writer', 'New Saga', '1. First', 'First.m4b'))).to.be.true
        expect(fs.existsSync(rel('Writer', 'New Saga', '2. Second', 'Second.m4b'))).to.be.true
        expect(fs.existsSync(rel('Writer', 'Old Saga'))).to.be.false
        const seriesNames = (await loadItem(first)).media.series.map((series) => series.name)
        expect(seriesNames).to.deep.equal(['New Saga'])
      })

      it('keeps the renamed series on a book whose folder metadata.json names the old one', async () => {
        await enableAutoOrganize()
        const libraryItemId = await addBook('Raw First', ['First.m4b'], { title: 'First', authors: ['Writer'], series: 'Old Saga', sequence: '1' })
        await leaveStaleFolderMetadata(libraryItemId)

        await renameSeries('Old Saga', 'New Saga')

        expect((await loadItem(libraryItemId)).path).to.equal(rel('Writer', 'New Saga', '1. First'))
        const bookSeries = (await loadItem(libraryItemId)).media.series.map((series) => [series.name, series.bookSeries.sequence])
        expect(bookSeries).to.deep.equal([['New Saga', '1']])
      })

      it('moves nothing when the templates do not use the series', async () => {
        await enableAutoOrganize({ organizeFolderTemplate: NO_SERIES_TEMPLATE })
        await addBook('Raw Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'], series: 'Old Saga', sequence: '1' })
        const startTask = sinon.spy(manager, 'startTask')

        await renameSeries('Old Saga', 'New Saga')

        expect(startTask.called).to.be.false
        expect(fs.existsSync(rel('Raw Book', 'Book.m4b'))).to.be.true
      })

      it('leaves books alone when their library has auto organize off', async () => {
        await addBook('Raw Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'], series: 'Old Saga', sequence: '1' })
        const startTask = sinon.spy(manager, 'startTask')

        await renameSeries('Old Saga', 'New Saga')

        expect(startTask.called).to.be.false
        expect(fs.existsSync(rel('Raw Book', 'Book.m4b'))).to.be.true
      })

      it('moves books the requesting user cannot see too', async () => {
        await enableAutoOrganize()
        await addBook('Raw Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'], series: 'Old Saga', sequence: '1' })
        const series = await Database.seriesModel.findOne({ where: { name: 'Old Saga' } })

        await runEditAndWaitForOrganize(() => SeriesController.update.call({ organizeManager: manager }, { body: { name: 'New Saga' }, series, libraryItemsInSeries: [] }, makeRes()))

        expect(fs.existsSync(rel('Writer', 'New Saga', '1. Book', 'Book.m4b'))).to.be.true
      })
    })

    for (const { kind, rename, model, getIdByName } of [
      { kind: 'author', rename: renameAuthor, model: () => Database.authorModel, getIdByName: (name) => Database.getAuthorIdByName(library.id, name) },
      { kind: 'series', rename: renameSeries, model: () => Database.seriesModel, getIdByName: (name) => Database.getSeriesIdByName(library.id, name) }
    ]) {
      it(`finds the ${kind} by its new name, and nothing by its old name, in a scan after the rename`, async () => {
        await addBook('Raw Book', ['Book.m4b'], { title: 'Book', authors: ['Old'], series: 'Old' })
        const { id } = await model().findOne({ where: { name: 'Old' } })

        await rename('Old', 'New')

        expect(await getIdByName('New')).to.equal(id)
        expect(await getIdByName('Old')).to.be.null
      })
    }
  })

  describe('library scans while organizing', () => {
    let scanLibrary

    function deferred() {
      const result = {}
      result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }))
      return result
    }

    /** Resolves once the library has this many tracked organize runs */
    function whenRunsTracked(libraryId, count) {
      const tracked = deferred()
      const originalTrack = LibraryScanner.trackOrganizeRun.bind(LibraryScanner)
      sinon.stub(LibraryScanner, 'trackOrganizeRun').callsFake((libraryIds, run) => {
        const result = originalTrack(libraryIds, run)
        Promise.all(LibraryScanner.organizeRunLookups).then(() => {
          if (LibraryScanner.organizeRunsByLibraryId.get(libraryId)?.size >= count) tracked.resolve()
        })
        return result
      })
      return tracked.promise
    }

    /** Each call of executePlan stops until its hold is released */
    function holdExecutePlan(count) {
      const holds = Array.from({ length: count }, () => ({ entered: deferred(), release: deferred() }))
      const originalExecutePlan = manager.executePlan.bind(manager)
      let callCount = 0
      sinon.stub(manager, 'executePlan').callsFake(async (...args) => {
        const hold = holds[callCount++]
        hold.entered.resolve()
        await hold.release.promise
        return originalExecutePlan(...args)
      })
      return holds
    }

    async function addUnorganizedBook(name) {
      return addBook(`Raw ${name}`, [`${name}.m4b`], { title: name, authors: ['Writer'] })
    }

    async function addOtherLibrary() {
      const otherLibrary = await Database.libraryModel.create({ name: 'Other', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
      otherLibrary.libraryFolders = [await Database.libraryFolderModel.create({ path: path.join(tmpDir, 'other'), libraryId: otherLibrary.id })]
      return otherLibrary
    }

    function scannedLibraryIds() {
      return scanLibrary.getCalls().map((call) => call.args[0].libraryId)
    }

    beforeEach(() => {
      scanLibrary = sinon.stub(LibraryScanner, 'scanLibrary').resolves(false)
    })

    afterEach(() => {
      LibraryScanner.organizeRunsByLibraryId.clear()
    })

    it('starts right away when nothing is organizing', async () => {
      await LibraryScanner.scan(library)

      expect(scannedLibraryIds()).to.deep.equal([library.id])
    })

    it('waits for an organize task and starts when it has ended', async () => {
      const libraryItemId = await addUnorganizedBook('Book')
      const [hold] = holdExecutePlan(1)
      let wasMovedWhenScanned = null
      scanLibrary.callsFake(async () => {
        wasMovedWhenScanned = fs.existsSync(rel('Writer', 'Book', 'Book.m4b'))
        return false
      })
      manager.startTask([libraryItemId])
      await hold.entered.promise

      const scan = LibraryScanner.scan(library)
      await flush()
      expect(scanLibrary.called).to.be.false
      hold.release.resolve()
      await scan

      expect(wasMovedWhenScanned).to.be.true
      expect(Logger.info.getCalls().some((call) => /Waiting for organize to finish before the library scan/.test(call.args[0]))).to.be.true
    })

    describe('rescans of items', () => {
      const endpoints = {
        'one item': (libraryItemId, loadedItem) => ({ rescan: LibraryItemController.scan({ user: { isAdminOrUp: true }, libraryItem: loadedItem }, { json: sinon.spy() }), responded: Promise.resolve() }),
        // The batch responds before it rescans
        'a batch': (libraryItemId) => {
          const responded = deferred()
          const rescan = LibraryItemController.batchScan({ user: { isAdminOrUp: true }, body: { libraryItemIds: [libraryItemId] } }, { sendStatus: responded.resolve })
          return { rescan, responded: responded.promise }
        }
      }

      Object.entries(endpoints).forEach(([name, rescanEndpoint]) => {
        it(`hold the rescan of ${name} until the organize run has ended`, async () => {
          const libraryItemId = await addUnorganizedBook('Book')
          const [hold] = holdExecutePlan(1)
          const scanLibraryItem = sinon.stub(LibraryItemScanner, 'scanLibraryItem').resolves(ScanResult.NOTHING)
          manager.startTask([libraryItemId])
          await hold.entered.promise

          const { rescan, responded } = rescanEndpoint(libraryItemId, await loadItem(libraryItemId))
          await responded
          await flush()
          expect(scanLibraryItem.called).to.be.false
          hold.release.resolve()
          await rescan

          // The organize run rescans the moved item first. The endpoint passes no options.
          expect(scanLibraryItem.lastCall.args).to.deep.equal([libraryItemId])
        })
      })
    })

    /** Resolves when the nth task has started its items */
    function whenTaskStarted(taskNumber) {
      const started = deferred()
      const organizeTaskItems = manager.organizeTaskItems.bind(manager)
      let callCount = 0
      sinon.stub(manager, 'organizeTaskItems').callsFake((...args) => {
        if (++callCount === taskNumber) started.resolve()
        return organizeTaskItems(...args)
      })
      return started.promise
    }

    it('waits for every organize run on the library', async () => {
      const first = await addUnorganizedBook('First')
      const second = await addUnorganizedBook('Second')
      const [firstHold, secondHold] = holdExecutePlan(2)
      const secondTaskStarted = whenTaskStarted(2)
      const runTask = sinon.spy(manager, 'runTask')
      manager.startTask([first])
      manager.startTask([second])
      await secondTaskStarted

      const scan = LibraryScanner.scan(library)
      await firstHold.entered.promise
      firstHold.release.resolve()
      await runTask.firstCall.returnValue
      await secondHold.entered.promise
      await flush()
      expect(scanLibrary.called).to.be.false
      secondHold.release.resolve()
      await scan

      expect(scanLibrary.calledOnce).to.be.true
      expect(fs.existsSync(rel('Writer', 'Second', 'Second.m4b'))).to.be.true
    })

    it('waits for a run that starts while it waits', async () => {
      const first = await addUnorganizedBook('First')
      const second = await addUnorganizedBook('Second')
      const [firstHold, secondHold] = holdExecutePlan(2)
      const secondTaskStarted = whenTaskStarted(2)
      const runTask = sinon.spy(manager, 'runTask')
      manager.startTask([first])
      await firstHold.entered.promise
      const scan = LibraryScanner.scan(library)
      manager.startTask([second])
      await secondTaskStarted

      firstHold.release.resolve()
      await runTask.firstCall.returnValue
      await secondHold.entered.promise
      await flush()
      expect(scanLibrary.called).to.be.false
      secondHold.release.resolve()
      await scan

      expect(scanLibrary.calledOnce).to.be.true
    })

    it('waits for an inline auto organize of one item', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addUnorganizedBook('Book')
      const targetBefore = await manager.getAutoOrganizeTarget(await loadItem(libraryItemId))
      await setMetadata(libraryItemId, { title: 'Book Two', authors: ['Writer'] })
      const [hold] = holdExecutePlan(1)
      const autoOrganize = manager.autoOrganizeItem(libraryItemId, targetBefore)
      await hold.entered.promise

      const scan = LibraryScanner.scan(library)
      await flush()
      expect(scanLibrary.called).to.be.false
      hold.release.resolve()
      await autoOrganize
      await scan

      expect(scanLibrary.calledOnce).to.be.true
    })

    it('does not delay a scan of another library', async () => {
      const libraryItemId = await addUnorganizedBook('Book')
      const otherLibrary = await addOtherLibrary()
      const [hold] = holdExecutePlan(1)
      const runTask = sinon.spy(manager, 'runTask')
      manager.startTask([libraryItemId])
      await hold.entered.promise

      await LibraryScanner.scan(otherLibrary)
      expect(scannedLibraryIds()).to.deep.equal([otherLibrary.id])
      hold.release.resolve()
      await runTask.firstCall.returnValue
    })

    it('starts one scan when it is requested again while waiting', async () => {
      const libraryItemId = await addUnorganizedBook('Book')
      const [hold] = holdExecutePlan(1)
      manager.startTask([libraryItemId])
      await hold.entered.promise

      const firstRequest = LibraryScanner.scan(library)
      const secondRequest = LibraryScanner.scan(library)
      hold.release.resolve()
      await Promise.all([firstRequest, secondRequest])
      await flush()

      expect(scanLibrary.calledOnce).to.be.true
    })

    describe('when the organize run fails', () => {
      const failures = {
        'an item that fails to move': (manager, gate) => sinon.stub(manager, 'executePlan').callsFake(() => gate.promise.then(() => Promise.reject(new Error('Disk is full')))),
        'a task that crashes': (manager, gate) => sinon.stub(manager, 'organizeTaskItems').callsFake(() => gate.promise.then(() => Promise.reject(new Error('Task crashed'))))
      }

      for (const [name, stubFailure] of Object.entries(failures)) {
        it(`starts the scan after ${name}`, async () => {
          const libraryItemId = await addUnorganizedBook('Book')
          const gate = deferred()
          stubFailure(manager, gate)
          const tracked = whenRunsTracked(library.id, 1)
          const runTask = sinon.spy(manager, 'runTask')
          manager.startTask([libraryItemId])
          await tracked

          const scan = LibraryScanner.scan(library)
          await flush()
          expect(scanLibrary.called).to.be.false
          gate.resolve()
          await scan
          await runTask.firstCall.returnValue.catch(() => {})

          expect(scanLibrary.calledOnce).to.be.true
          expect(LibraryScanner.organizeRunsByLibraryId.size).to.equal(0)
        })
      }
    })

    it('does not wait for a preview', async () => {
      const libraryItemId = await addUnorganizedBook('Book')
      let wasTrackedDuringPreview = null
      const planItem = manager.planItem.bind(manager)
      sinon.stub(manager, 'planItem').callsFake(async (...args) => {
        await flush()
        wasTrackedDuringPreview = LibraryScanner.organizeRunsByLibraryId.has(library.id)
        return planItem(...args)
      })

      await manager.previewItems([libraryItemId])

      expect(wasTrackedDuringPreview).to.be.false
    })

    it('holds the watcher batch scan of the library as well', async () => {
      const libraryItemId = await addUnorganizedBook('Book')
      const [hold] = holdExecutePlan(1)
      let wasOrganizeActiveWhenScanned = null
      sinon.stub(LibraryScanner, 'scanFolderUpdates').callsFake(async () => {
        wasOrganizeActiveWhenScanned = LibraryScanner.organizeRunsByLibraryId.has(library.id)
        return {}
      })
      const runTask = sinon.spy(manager, 'runTask')
      manager.startTask([libraryItemId])
      await hold.entered.promise
      const fileUpdates = [{ libraryId: library.id, folderId: libraryFolder.id, path: rel('Raw New', 'New.m4b'), relPath: 'Raw New/New.m4b', type: 'added' }]
      const pendingTask = new Task()
      pendingTask.setData('watcher-scan', { text: 'Scanning', key: 'MessageTaskScanningFileChanges' }, null, false, {})

      const scan = LibraryScanner.scanFilesChanged(fileUpdates, pendingTask)
      await flush()
      hold.release.resolve()
      await scan
      await runTask.firstCall.returnValue

      expect(wasOrganizeActiveWhenScanned).to.be.false
    })

    describe('watcher batches', () => {
      function watcherBatch(batchLibrary, folder) {
        const fileUpdates = [{ libraryId: batchLibrary.id, folderId: folder.id, path: rel('Raw New', 'New.m4b'), relPath: 'Raw New/New.m4b', type: 'added' }]
        const pendingTask = new Task()
        pendingTask.setData('watcher-scan', { text: 'Scanning', key: 'MessageTaskScanningFileChanges' }, null, false, {})
        return [fileUpdates, pendingTask]
      }

      afterEach(() => {
        LibraryScanner.scanningFilesChanged = false
        LibraryScanner.pendingFileUpdatesToScan = []
        LibraryScanner.librariesWatcherScanning.clear()
      })

      it('scans another library while a batch of the organizing library waits', async () => {
        const otherLibrary = await addOtherLibrary()
        const libraryItemId = await addUnorganizedBook('Book')
        const [hold] = holdExecutePlan(1)
        const scanFolderUpdates = sinon.stub(LibraryScanner, 'scanFolderUpdates').resolves({})
        const runTask = sinon.spy(manager, 'runTask')
        manager.startTask([libraryItemId])
        await hold.entered.promise

        const waitingBatch = LibraryScanner.scanFilesChanged(...watcherBatch(library, libraryFolder))
        await LibraryScanner.scanFilesChanged(...watcherBatch(otherLibrary, otherLibrary.libraryFolders[0]))

        expect(scanFolderUpdates.getCalls().map((call) => call.args[0].id)).to.deep.equal([otherLibrary.id])
        hold.release.resolve()
        await waitingBatch
        await runTask.firstCall.returnValue
        expect(scanFolderUpdates.getCalls().map((call) => call.args[0].id)).to.deep.equal([otherLibrary.id, library.id])
      })

      it('skips organizing items of a library while its batch is scanned, and no other library', async () => {
        const otherLibrary = await addOtherLibrary()
        const libraryItemId = await addUnorganizedBook('Book')
        const scanStarted = deferred()
        const scanRelease = deferred()
        sinon.stub(LibraryScanner, 'scanFolderUpdates').callsFake(async () => {
          scanStarted.resolve()
          await scanRelease.promise
          return {}
        })

        const scan = LibraryScanner.scanFilesChanged(...watcherBatch(library, libraryFolder))
        await scanStarted.promise

        expect(manager.getBusyReason(await loadItem(libraryItemId))).to.equal('libraryScanning')
        expect(manager.getBusyReason({ id: 'other', libraryId: otherLibrary.id })).to.be.null
        scanRelease.resolve()
        await scan
        expect(manager.getBusyReason(await loadItem(libraryItemId))).to.be.null
      })

      it('skips organizing items of every library of a batch while its first folder is scanned, and again once it failed', async () => {
        const otherLibrary = await addOtherLibrary()
        const libraryItemId = await addUnorganizedBook('Book')
        const [firstFileUpdates, pendingTask] = watcherBatch(library, libraryFolder)
        const [otherFileUpdates] = watcherBatch(otherLibrary, otherLibrary.libraryFolders[0])
        const scanStarted = deferred()
        const scanRelease = deferred()
        sinon.stub(LibraryScanner, 'scanFolderUpdates').callsFake(async () => {
          scanStarted.resolve()
          await scanRelease.promise
          throw new Error('scan exploded')
        })

        const scan = LibraryScanner.scanFilesChanged([...otherFileUpdates, ...firstFileUpdates], pendingTask).catch((error) => error)
        await scanStarted.promise

        expect(manager.getBusyReason(await loadItem(libraryItemId))).to.equal('libraryScanning')
        expect(manager.getBusyReason({ id: 'other', libraryId: otherLibrary.id })).to.equal('libraryScanning')
        scanRelease.resolve()
        expect((await scan).message).to.equal('scan exploded')
        expect(manager.getBusyReason(await loadItem(libraryItemId))).to.be.null
        expect(manager.getBusyReason({ id: 'other', libraryId: otherLibrary.id })).to.be.null
      })
    })

    it('waits for the task of an author rename that a scan is requested right after', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      await addUnorganizedBook('Book')
      const [hold] = holdExecutePlan(1)
      let wasMovedWhenScanned = null
      scanLibrary.callsFake(async () => {
        wasMovedWhenScanned = fs.existsSync(rel('Newer', 'Book', 'Book.m4b'))
        return false
      })
      const author = await Database.authorModel.findOne({ where: { name: 'Writer' } })

      await AuthorController.update.call({ organizeManager: manager }, { body: { name: 'Newer' }, author }, { json: sinon.spy() })
      const scan = LibraryScanner.scan(library)
      await hold.entered.promise
      await flush()
      expect(scanLibrary.called).to.be.false
      hold.release.resolve()
      await scan

      expect(wasMovedWhenScanned).to.be.true
    })
  })

  describe('routes and library settings', () => {
    function makeRes() {
      const res = { statusCode: 200, body: undefined }
      res.status = (code) => ((res.statusCode = code), res)
      res.sendStatus = (code) => ((res.statusCode = code), res)
      res.type = (contentType) => ((res.contentType = contentType), res)
      res.send = (body) => ((res.body = body), res)
      res.json = (body) => ((res.body = body), res)
      return res
    }
    const adminUser = { isAdminOrUp: true, checkCanAccessLibrary: () => true }

    it('previews and starts organizing by item ids, rejecting unknown items', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const startTask = sinon.stub(manager, 'startTask')
      const context = { organizeManager: manager }

      const previewRes = makeRes()
      await ToolsController.previewOrganize.call(context, { user: adminUser, body: { libraryItemIds: [libraryItemId] } }, previewRes)
      expect(previewRes.body.plans).to.have.length(1)

      const startRes = makeRes()
      await ToolsController.organize.call(context, { user: adminUser, body: { libraryItemIds: [libraryItemId], planHashes: { [libraryItemId]: previewRes.body.plans[0].hash } } }, startRes)
      expect(startRes.body).to.deep.equal({ itemCount: 1 })
      expect(startTask.firstCall.args).to.deep.equal([[libraryItemId], { [libraryItemId]: previewRes.body.plans[0].hash }])

      const missingRes = makeRes()
      await ToolsController.organize.call(context, { user: adminUser, body: { libraryItemIds: ['li_missing'] } }, missingRes)
      expect(missingRes.statusCode).to.equal(404)
    })

    it('with a preview only organizes the items the preview listed', async () => {
      const previewed = await addBook('Raw 1', ['a.m4b'], { title: 'One', authors: ['Writer'] })
      const added = await addBook('Raw 2', ['b.m4b'], { title: 'Two', authors: ['Writer'] })
      const startTask = sinon.stub(manager, 'startTask')

      const res = makeRes()
      await ToolsController.organize.call({ organizeManager: manager }, { user: adminUser, body: { libraryId: library.id, planHashes: { [previewed]: 'hash' } } }, res)

      expect(startTask.firstCall.args[0]).to.deep.equal([previewed])
      expect(startTask.firstCall.args[0]).to.not.include(added)
    })

    it('rejects podcast libraries and podcast items with a clear message', async () => {
      const podcastLibrary = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast' })
      const podcastFolder = await Database.libraryFolderModel.create({ path: path.join(tmpDir, 'pods'), libraryId: podcastLibrary.id })
      const podcast = await Database.podcastModel.create({ title: 'Pod', tags: [], genres: [] })
      const podcastItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: podcastLibrary.id, libraryFolderId: podcastFolder.id })
      const context = { organizeManager: manager }

      for (const body of [{ libraryId: podcastLibrary.id }, { libraryItemIds: [podcastItem.id] }]) {
        const res = makeRes()
        await ToolsController.previewOrganize.call(context, { user: adminUser, body }, res)
        expect(res.statusCode).to.equal(400)
        expect(res.body).to.equal('Organizing files is not supported for podcast libraries')
      }
    })

    it('rejects invalid templates when a library is updated', async () => {
      const invalidTemplates = [{ organizeFolderTemplate: '{author}/{unknown}' }, { organizeFolderTemplate: '../{title}' }, { organizeFileTemplate: '{title}/{track}' }, { organizeFileTemplate: '<{title}' }]
      for (const settings of invalidTemplates) {
        const res = makeRes()
        const req = { user: adminUser, body: { settings }, library }
        await LibraryController.update.call({ organizeManager: { organizeLibrary: sinon.stub() } }, req, res)
        expect(res.statusCode, JSON.stringify(settings)).to.equal(400)
        expect(res.body).to.include('is invalid')
        expect(res.contentType, 'the error quotes the template, so it MUST NOT be served as HTML').to.equal('text/plain')
      }
    })

    it('keeps the type error for other settings when a library is created or updated', async () => {
      const updateRes = makeRes()
      await LibraryController.update.call({ organizeManager: manager }, { user: adminUser, body: { settings: { autoOrganize: 'yes' } }, library }, updateRes)
      const createRes = makeRes()
      await LibraryController.create.call({}, { user: adminUser, body: { name: 'New', folders: [{ path: path.join(tmpDir, 'new') }], settings: { autoOrganize: 'yes' } } }, createRes)

      for (const res of [updateRes, createRes]) {
        expect(res.statusCode).to.equal(400)
        expect(res.body).to.equal('Invalid request. Setting "autoOrganize" must be of type boolean')
      }
    })

    it('rejects invalid templates when a library is created', async () => {
      const invalidTemplates = [{ organizeFolderTemplate: '{author}/{unknown}' }, { organizeFileTemplate: '{title}/{track}' }]
      for (const settings of invalidTemplates) {
        const res = makeRes()
        const req = { user: adminUser, body: { name: 'New', folders: [{ path: path.join(tmpDir, 'new') }], settings } }
        await LibraryController.create.call({}, req, res)
        expect(res.statusCode, JSON.stringify(settings)).to.equal(400)
        expect(res.body).to.include('is invalid')
        expect(res.contentType, 'the error quotes the template, so it MUST NOT be served as HTML').to.equal('text/plain')
      }
      expect(await Database.libraryModel.count()).to.equal(1)
    })

    it('starts organizing the whole library when a template changes, and only then', async () => {
      const organizeLibrary = sinon.stub(manager, 'organizeLibrary')
      const context = { organizeManager: manager }
      const update = (settings) => LibraryController.update.call(context, { user: adminUser, body: { settings }, library }, makeRes())

      await update({ autoOrganize: true, organizeFolderTemplate: '{author}/{title}' })
      expect(organizeLibrary.calledOnceWithExactly(library.id)).to.be.true

      organizeLibrary.resetHistory()
      await update({ organizeFolderTemplate: '{author}/{title}', organizeFileTemplate: '{title}< - Part {track}>', autoOrganize: false })
      expect(organizeLibrary.called).to.be.false

      await update({ organizeFileTemplate: '{title}' })
      expect(organizeLibrary.calledOnceWithExactly(library.id)).to.be.true
      expect(library.settings.organizeFileTemplate).to.equal('{title}')
    })

    it('treats a library saved before the organize settings existed as using the defaults', async () => {
      const oldLibrary = await Database.libraryModel.create({ name: 'Old', mediaType: 'book', settings: { coverAspectRatio: 1 } })
      oldLibrary.libraryFolders = []
      const organizeLibrary = sinon.stub(manager, 'organizeLibrary')
      const update = (settings) => LibraryController.update.call({ organizeManager: manager }, { user: adminUser, body: { settings }, library: oldLibrary }, makeRes())

      await update({ organizeFolderTemplate: '{author}/{series}/<{sequence}. >{title}' })
      expect(organizeLibrary.called).to.be.false
      expect(oldLibrary.toOldJSON().settings).to.include({ organizeFileTemplate: '{title}< - Part {track}>', autoOrganize: false })

      await update({ organizeFolderTemplate: '{title}' })
      expect(organizeLibrary.calledOnce).to.be.true
    })

    it('organizeLibrary starts a task for every book in the library', async () => {
      const first = await addBook('Raw 1', ['a.m4b'], { title: 'One' })
      const second = await addBook('Raw 2', ['b.m4b'], { title: 'Two' })
      const startTask = sinon.stub(manager, 'startTask')

      await manager.organizeLibrary(library.id)

      expect(startTask.firstCall.args[0].sort()).to.deep.equal([first, second].sort())
    })
  })

  describe('uploads', () => {
    async function upload(libraryId, body, fileNames) {
      const files = fileNames.map((name) => ({ name, mv: async (target) => fs.promises.writeFile(target, name) }))
      const res = { sendStatus: sinon.spy(), status: sinon.stub().returnsThis(), send: sinon.spy() }
      const req = { user: { canUpload: true, checkCanAccessLibrary: () => true }, files: { files }, body: { library: libraryId, folder: libraryFolder.id, ...body } }
      await MiscController.handleUpload.call({}, req, res)
      return res
    }

    it('lands at the templated path with templated file names', async () => {
      const res = await upload(library.id, { title: 'My: Book', author: 'Jane Doe', series: 'Saga' }, ['Track 10.mp3', 'Track 2.mp3', 'Track 1.mp3', 'cover.jpg', 'notes.txt'])

      expect(res.sendStatus.calledWith(200)).to.be.true
      expect(listFiles(libraryDir)).to.deep.equal(['Jane Doe', 'Jane Doe/Saga', 'Jane Doe/Saga/My - Book', ...['My - Book - Part 1.mp3', 'My - Book - Part 2.mp3', 'My - Book - Part 3.mp3', 'cover.jpg', 'notes.txt'].map((name) => `Jane Doe/Saga/My - Book/${name}`)])
      expect(fs.readFileSync(rel('Jane Doe', 'Saga', 'My - Book', 'My - Book - Part 3.mp3'), 'utf8')).to.equal('Track 10.mp3')
    })

    it('follows a customized template and drops folders for details the form lacks', async () => {
      await library.update({ settings: { ...library.settings, organizeFolderTemplate: '<{series}/>{title}< by {author}>', organizeFileTemplate: '<{author} - >{title}' } })

      await upload(library.id, { title: 'Solo' }, ['x.m4b'])

      expect(listFiles(libraryDir)).to.deep.equal(['Solo', 'Solo/Solo.m4b'])
    })

    it('refuses an upload whose rendered folder already exists and writes nothing', async () => {
      await library.update({ settings: { ...library.settings, organizeFolderTemplate: '{author}/{title}' } })
      fs.mkdirSync(rel('Terry Pratchett', 'Mort'), { recursive: true })
      fs.writeFileSync(rel('Terry Pratchett', 'Mort', 'Mort.m4b'), 'original')

      const res = await upload(library.id, { title: 'Mort', author: 'Terry Pratchett', series: 'Discworld' }, ['new.m4b', 'cover.jpg'])

      expect(res.status.calledWith(409)).to.be.true
      expect(res.send.firstCall.args[0]).to.equal('Cannot upload to "Terry Pratchett/Mort": the folder already exists')
      expect(res.sendStatus.called).to.be.false
      expect(listFiles(libraryDir)).to.deep.equal(['Terry Pratchett', 'Terry Pratchett/Mort', 'Terry Pratchett/Mort/Mort.m4b'])
      expect(fs.readFileSync(rel('Terry Pratchett', 'Mort', 'Mort.m4b'), 'utf8')).to.equal('original')
    })

    it('refuses an upload that would land inside the folder of a library item', async () => {
      await addBook('Stephen King/The Dark Tower', ['tower.m4b'], { title: 'The Gunslinger', authors: ['Stephen King'] })

      const res = await upload(library.id, { title: 'The Drawing of the Three', author: 'Stephen King', series: 'The Dark Tower' }, ['a.m4b'])

      expect(res.status.calledWith(409)).to.be.true
      expect(res.send.firstCall.args[0]).to.equal('Cannot upload to "Stephen King/The Dark Tower/The Drawing of the Three": it is inside the folder of the library item "The Dark Tower"')
      expect(listFiles(libraryDir)).to.deep.equal(['Stephen King', 'Stephen King/The Dark Tower', 'Stephen King/The Dark Tower/tower.m4b'])
    })

    it('refuses an upload when the folder appears right before it is created', async () => {
      sinon.stub(fsExtra, 'mkdir').rejects(Object.assign(new Error('exists'), { code: 'EEXIST' }))

      const res = await upload(library.id, { title: 'Solo' }, ['x.m4b'])

      expect(res.status.calledWith(409)).to.be.true
      expect(res.sendStatus.called).to.be.false
      expect(listFiles(libraryDir)).to.deep.equal([])
    })

    it('saves a file under its sanitized name when the file template renders no name', async () => {
      await library.update({ settings: { ...library.settings, organizeFileTemplate: '{subtitle}' } })

      await upload(library.id, { title: 'Solo' }, ['Chapter: 1?.mp3'])

      expect(listFiles(libraryDir)).to.deep.equal(['Solo', 'Solo/Chapter - 1.mp3'])
    })

    it('tells the client the folder an upload goes to and whether it is taken', async () => {
      await addBook('Stephen King/The Dark Tower', ['tower.m4b'], { title: 'The Gunslinger', authors: ['Stephen King'] })
      const check = async (body) => {
        const res = { status: sinon.stub().returnsThis(), send: sinon.spy(), sendStatus: sinon.spy(), json: sinon.spy() }
        await MiscController.getUploadTarget.call({}, { user: { canUpload: true, checkCanAccessLibrary: () => true }, body: { library: library.id, folder: libraryFolder.id, ...body } }, res)
        return res.json.firstCall.args[0]
      }

      expect(await check({ title: 'Free', author: 'Writer', series: 'Saga' })).to.deep.equal({ directory: 'Writer/Saga/Free', exists: false, libraryItemTitle: undefined })
      expect(await check({ title: 'Nested', author: 'Stephen King', series: 'The Dark Tower' })).to.deep.equal({ directory: 'Stephen King/The Dark Tower/Nested', exists: true, libraryItemTitle: 'The Dark Tower' })
      expect((await check({ title: 'The Dark Tower', author: 'Stephen King' })).exists).to.be.true
    })

    it('finds a library item folder at any depth above the path', async () => {
      await addBook('Top', ['top.m4b'], { title: 'Top Book', authors: ['Writer'] })
      const res = { json: sinon.spy(), sendStatus: sinon.spy() }

      await FileSystemController.checkPathExists.call({}, { user: { canUpload: true, checkCanAccessLibrary: () => true }, body: { directory: 'Top/A/B/C', folderPath: libraryDir } }, res)

      expect(res.json.firstCall.args[0]).to.deep.equal({ exists: true, libraryItemTitle: 'Top' })
    })

    it('keeps the podcast upload layout', async () => {
      const podcastLibrary = await Database.libraryModel.create({ name: 'Pods', mediaType: 'podcast' })
      const podcastFolder = await Database.libraryFolderModel.create({ path: libraryDir, libraryId: podcastLibrary.id })
      const files = [{ name: 'ep1.mp3', mv: async (target) => fs.promises.writeFile(target, 'ep') }]
      const res = { sendStatus: sinon.spy() }
      await MiscController.handleUpload.call({}, { user: { canUpload: true, checkCanAccessLibrary: () => true }, files: { files }, body: { library: podcastLibrary.id, folder: podcastFolder.id, title: 'My Podcast', author: 'Ignored' } }, res)

      expect(listFiles(libraryDir)).to.deep.equal(['My Podcast', 'My Podcast/ep1.mp3'])
    })
  })
})
