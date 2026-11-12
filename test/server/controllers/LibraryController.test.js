const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const LibraryController = require('../../../server/controllers/LibraryController')
const zipHelpers = require('../../../server/utils/zipHelpers')
const Logger = require('../../../server/Logger')

describe('LibraryController.downloadMultiple', () => {
  let library
  let libraryFolder
  let allowedItemId
  let explicitItemId
  let taggedItemId
  let restrictedUser
  let libraryRecord

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' })
    libraryFolder = await Database.libraryFolderModel.create({ path: '/test-lib', libraryId: library.id })
    libraryRecord = await Database.libraryModel.findByIdWithFolders(library.id)

    const allowedBook = await Database.bookModel.create({
      title: 'Allowed Book',
      explicit: false,
      audioFiles: [],
      tags: ['allowed-tag'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const allowedItem = await Database.libraryItemModel.create({
      path: '/test-lib/allowed',
      isFile: false,
      libraryFiles: [],
      mediaId: allowedBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    allowedItemId = allowedItem.id

    const explicitBook = await Database.bookModel.create({
      title: 'Explicit Book',
      explicit: true,
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    const explicitItem = await Database.libraryItemModel.create({
      path: '/test-lib/explicit',
      isFile: false,
      libraryFiles: [],
      mediaId: explicitBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    explicitItemId = explicitItem.id

    const taggedBook = await Database.bookModel.create({
      title: 'Tagged Book',
      explicit: false,
      audioFiles: [],
      tags: ['restricted-tag'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const taggedItem = await Database.libraryItemModel.create({
      path: '/test-lib/tagged',
      isFile: false,
      libraryFiles: [],
      mediaId: taggedBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    taggedItemId = taggedItem.id

    const permissions = Database.userModel.getDefaultPermissionsForUserType('user')
    permissions.download = true
    permissions.accessExplicitContent = false
    permissions.accessAllLibraries = false
    permissions.accessAllTags = false
    permissions.librariesAccessible = [library.id]
    permissions.itemTagsSelected = ['allowed-tag']
    permissions.selectedTagsNotAccessible = false

    restrictedUser = await Database.userModel.create({
      username: 'restricted',
      pash: 'hash',
      token: 'token',
      type: 'user',
      isActive: true,
      permissions,
      bookmarks: [],
      extraData: {}
    })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(zipHelpers, 'zipDirectoriesPipe').resolves()
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  function makeReq(ids) {
    return {
      query: { ids: ids.join(',') },
      user: restrictedUser,
      library: libraryRecord
    }
  }

  function makeRes() {
    return {
      sendStatus: sinon.spy(),
      status: sinon.stub().returnsThis(),
      send: sinon.spy()
    }
  }

  it('returns 403 for bulk download of an explicit item', async () => {
    const req = makeReq([explicitItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('returns 403 for bulk download of a tag-restricted item', async () => {
    const req = makeReq([taggedItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('returns 403 when bulk download includes both allowed and forbidden items', async () => {
    const req = makeReq([allowedItemId, explicitItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('starts zip download for allowed items only', async () => {
    const req = makeReq([allowedItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.called).to.be.false
    expect(zipHelpers.zipDirectoriesPipe.calledOnce).to.be.true
    const pathObjects = zipHelpers.zipDirectoriesPipe.firstCall.args[0]
    expect(pathObjects).to.have.length(1)
    expect(pathObjects[0].path).to.equal('/test-lib/allowed')
  })
})

describe('LibraryController.update auto match settings', () => {
  let library

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')

    const created = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    library = await Database.libraryModel.findByIdWithFolders(created.id)
  })

  afterEach(() => {
    sinon.restore()
  })

  async function updateSetting(key, value) {
    const res = { statusCode: 200, body: null }
    res.status = (code) => {
      res.statusCode = code
      return res
    }
    res.type = () => res
    res.send = (body) => {
      res.body = body
      return res
    }
    res.json = (body) => {
      res.body = body
      return res
    }
    const req = { user: { isAdminOrUp: true }, library, body: { settings: { [key]: value } } }
    await LibraryController.update.call({ organizeManager: { organizeLibraryIfTemplatesChanged: sinon.stub() } }, req, res)
    return res
  }

  const cases = [
    { key: 'autoMatchMinConfidence', value: 90, expectedStatus: 200, expectedSetting: 90 },
    { key: 'autoMatchMinConfidence', value: 0, expectedStatus: 200, expectedSetting: 0 },
    { key: 'autoMatchMinConfidence', value: 100, expectedStatus: 200, expectedSetting: 100 },
    { key: 'autoMatchMinConfidence', value: null, expectedStatus: 200, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: 101, expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: -1, expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: 'abc', expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: '', expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: '50', expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: true, expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchMinConfidence', value: [50], expectedStatus: 400, expectedSetting: null },
    { key: 'autoMatchProvider', value: 'audible.ca', expectedStatus: 200, expectedSetting: 'audible.ca' },
    { key: 'autoMatchProvider', value: 'google', expectedStatus: 400, expectedSetting: 'audible' },
    { key: 'autoMatchProvider', value: 'custom-test', expectedStatus: 400, expectedSetting: 'audible' }
  ]
  cases.forEach(({ key, value, expectedStatus, expectedSetting }) => {
    it(`returns ${expectedStatus} for ${key} ${JSON.stringify(value)}`, async () => {
      const res = await updateSetting(key, value)

      expect(res.statusCode).to.equal(expectedStatus)
      const stored = await Database.libraryModel.findByPk(library.id)
      expect(stored.settings[key]).to.equal(expectedSetting)
    })
  })
})

describe('LibraryController.create auto match settings', () => {
  beforeEach(async () => {
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
    sinon.stub(Logger, 'error')
  })

  afterEach(() => {
    sinon.restore()
  })

  async function createWithSettings(settings) {
    const res = { statusCode: 200, body: null }
    res.status = (code) => {
      res.statusCode = code
      return res
    }
    res.type = () => res
    res.send = (body) => {
      res.body = body
      return res
    }
    const req = { user: { isAdminOrUp: true }, body: { name: 'New Library', folders: [{ path: '/new-lib' }], settings } }
    await LibraryController.create.call({}, req, res)
    return res
  }

  const cases = [
    { name: 'a provider outside the Audible list', settings: { autoMatchProvider: 'google' }, expectedError: 'Setting "autoMatchProvider" must be one of audible,' },
    { name: 'a minimum above 100', settings: { autoMatchMinConfidence: 101 }, expectedError: 'Setting "autoMatchMinConfidence" must be between 0 and 100' },
    { name: 'a setting key named after an Object prototype member', settings: JSON.parse('{"__proto__":1}'), expectedError: 'Setting "__proto__" must be of type object' }
  ]
  cases.forEach(({ name, settings, expectedError }) => {
    it(`returns 400 for ${name}`, async () => {
      const res = await createWithSettings(settings)

      expect(res.statusCode).to.equal(400)
      expect(res.body).to.include(expectedError)
      expect(await Database.libraryModel.count()).to.equal(0)
    })
  })
})
