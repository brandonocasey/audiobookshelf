const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const fs = require('fs')
const gracefulFs = require('graceful-fs')
const os = require('os')
const path = require('path')

const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const Watcher = require('../../../server/Watcher')
const prober = require('../../../server/utils/prober')
const fsExtra = require('../../../server/libs/fsExtra')
const AudioMetaTags = require('../../../server/objects/metadata/AudioMetaTags')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const OrganizeManager = require('../../../server/managers/OrganizeManager')
const TaskManager = require('../../../server/managers/TaskManager')
const ToolsController = require('../../../server/controllers/ToolsController')
const LibraryController = require('../../../server/controllers/LibraryController')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const MiscController = require('../../../server/controllers/MiscController')
const Scanner = require('../../../server/scanner/Scanner')
const BookFinder = require('../../../server/finders/BookFinder')

describe('OrganizeManager', () => {
  let tmpDir
  let libraryDir
  let library
  let libraryFolder
  let sessions
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
    manager = new OrganizeManager({ sessions })
  })

  afterEach(async () => {
    sinon.restore()
    LibraryScanner.librariesScanning = []
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await Database.sequelize.sync({ force: true })
  })

  /**
   * Write the files, scan the folder into a library item and set the metadata the templates use
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
    // The scanner reads this file back with the highest precedence, so keep it in step with the book like an edit does
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

  /** Every move goes through the copy-and-delete fallback used across file systems */
  function simulateCrossDeviceMoves() {
    const originalRename = gracefulFs.rename
    sinon.stub(gracefulFs, 'rename').callsFake((src, dest, callback) => {
      if (src.endsWith('.tmp')) return originalRename(src, dest, callback)
      callback(Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }))
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

          // Audio files keep their playback order: the first track still holds the content of "Part 1.mp3"
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

  describe('skipping and failing', () => {
    it('skips an item whose target folder already exists and moves nothing', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      fs.mkdirSync(rel('Writer', 'Book'), { recursive: true })
      fs.writeFileSync(rel('Writer', 'Book', 'other.m4b'), 'other')

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'targetExists' })
      expect(listFiles(rel('Writer', 'Book'))).to.deep.equal(['other.m4b'])
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

    it('skips a second request for an item that is already being organized', async () => {
      const libraryItemId = await addBook('Raw', ['a.m4b'], { title: 'Book', authors: ['Writer'] })
      const firstRun = manager.organizeItem(libraryItemId)
      const secondRun = await manager.organizeItem(libraryItemId)
      await firstRun

      expect(secondRun).to.deep.equal({ itemId: libraryItemId, status: 'skipped', reason: 'inProgress' })
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
      const realMove = fsExtra.move
      const moveStub = sinon.stub(fsExtra, 'move').callsFake(realMove)
      moveStub.onCall(2).rejects(new Error('disk full'))

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'disk full' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
      expect(fs.readFileSync(rel('Raw', 'a.mp3'), 'utf8')).to.equal('a.mp3')
    })

    it('removes the partial copy a move interrupted across file systems left behind', async () => {
      const libraryItemId = await addBook('Raw', ['a.mp3', 'b.mp3'], { title: 'Book', authors: ['Writer'] })
      const realMove = fsExtra.move
      sinon.stub(fsExtra, 'move').callsFake(async (from, to) => {
        if (!to.endsWith('Book - Part 2.mp3')) return realMove(from, to)
        fs.writeFileSync(to, 'partial')
        throw new Error('disk full')
      })

      const result = await manager.organizeItem(libraryItemId)

      expect(result).to.deep.equal({ itemId: libraryItemId, status: 'failed', error: 'disk full' })
      expect(listFiles(libraryDir)).to.deep.equal(['Raw', 'Raw/a.mp3', 'Raw/b.mp3'])
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

    it('finishes or rolls back a run that was interrupted before the next startup', async () => {
      const rolledBackId = await addBook('Raw A', ['a.mp3', 'b.mp3'], { title: 'Book A', authors: ['Writer'] })
      sinon.stub(manager, 'rollback').resolves()
      sinon.stub(manager, 'runSteps').callsFake(async (journal) => {
        await fsExtra.move(journal.steps[0].from, journal.steps[0].to)
        journal.steps[0].done = true
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

      await new OrganizeManager({ sessions: [] }).recoverInterrupted()

      expect(listFiles(rel('Raw A'))).to.deep.equal(['a.mp3', 'b.mp3'])
      expect((await loadItem(finishedId)).path).to.equal(rel('Writer', 'Book B'))
      expect(fs.readdirSync(path.join(global.MetadataPath, 'organize'))).to.deep.equal([])
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

      expect(await manager.autoOrganizeItem(libraryItemId)).to.be.false
      expect(fs.existsSync(rel('Raw', 'a.m4b'))).to.be.true

      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      expect(await manager.autoOrganizeItem(libraryItemId)).to.be.true
      expect(fs.existsSync(rel('Writer', 'Book', 'Book.m4b'))).to.be.true
      expect(await manager.autoOrganizeItem(libraryItemId)).to.be.false
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

    it('runs after a batch edit', async () => {
      await library.update({ settings: { ...library.settings, autoOrganize: true } })
      const libraryItemId = await addBook('Writer/Book', ['Book.m4b'], { title: 'Book', authors: ['Writer'] })
      const req = { user: { canUpdate: true, checkCanAccessLibraryItem: () => true }, body: [{ id: libraryItemId, mediaPayload: { metadata: { title: 'Book Two' } } }] }
      const res = { json: sinon.spy() }

      await LibraryItemController.batchUpdate.call({ organizeManager: manager }, req, res)

      expect(res.json.firstCall.args[0]).to.deep.equal({ success: true, updates: 1 })
      expect(fs.existsSync(rel('Writer', 'Book Two', 'Book Two.m4b'))).to.be.true
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
  })

  describe('routes and library settings', () => {
    function makeRes() {
      const res = { statusCode: 200, body: undefined }
      res.status = (code) => ((res.statusCode = code), res)
      res.sendStatus = (code) => ((res.statusCode = code), res)
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
      }
      expect(await Database.libraryModel.count()).to.equal(1)
    })

    it('starts organizing the whole library when a template changes, and only then', async () => {
      const organizeLibrary = sinon.stub()
      const context = { organizeManager: { organizeLibrary } }
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
      const organizeLibrary = sinon.stub()
      const update = (settings) => LibraryController.update.call({ organizeManager: { organizeLibrary } }, { user: adminUser, body: { settings }, library: oldLibrary }, makeRes())

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
