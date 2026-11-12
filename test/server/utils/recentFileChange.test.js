const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findFileChangedAfter } = require('../../../server/utils/recentFileChange')

describe('findFileChangedAfter', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-recent-'))
    fs.mkdirSync(path.join(tmpDir, 'CD 1'))
    fs.writeFileSync(path.join(tmpDir, 'CD 1', 'Part 1.mp3'), 'audio')
    fs.writeFileSync(path.join(tmpDir, 'cover.jpg'), 'cover')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds a changed file in a subfolder', async () => {
    const changedPath = await findFileChangedAfter(tmpDir, Date.now() - 1000)

    expect([path.join(tmpDir, 'CD 1', 'Part 1.mp3'), path.join(tmpDir, 'cover.jpg')]).to.include(changedPath)
  })

  it('finds nothing when every file is older', async () => {
    expect(await findFileChangedAfter(tmpDir, Date.now() + 1000)).to.be.null
  })

  it('checks a single file item', async () => {
    const filePath = path.join(tmpDir, 'Book.m4b')
    fs.writeFileSync(filePath, 'audio')

    expect(await findFileChangedAfter(filePath, Date.now() - 1000)).to.equal(filePath)
    expect(await findFileChangedAfter(filePath, Date.now() + 1000)).to.be.null
  })

  it('skips the ignored files', async () => {
    const ignoredPaths = new Set([path.join(tmpDir, 'CD 1', 'Part 1.mp3'), path.join(tmpDir, 'cover.jpg')])

    expect(await findFileChangedAfter(tmpDir, Date.now() - 1000, ignoredPaths)).to.be.null
  })

  it('counts a path that is gone as changed', async () => {
    const missingPath = path.join(tmpDir, 'gone.m4b')

    expect(await findFileChangedAfter(missingPath, Date.now() + 1000)).to.equal(missingPath)
  })
})
