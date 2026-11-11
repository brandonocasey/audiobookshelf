const { expect } = require('chai')
const sinon = require('sinon')

const Logger = require('../../server/Logger')
const Watcher = require('../../server/Watcher')

describe('Watcher ignored directories', () => {
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    sinon.stub(Logger, 'debug')
    Watcher.ignoreDirs = []
    Watcher.pendingDirsToRemoveFromIgnore = []
  })

  afterEach(() => {
    sinon.restore()
    Watcher.ignoreDirs = []
    Watcher.pendingDirsToRemoveFromIgnore = []
  })

  it('stops ignoring every directory released within the delay, not only the last one', () => {
    Watcher.addIgnoreDir('/library/Old Book')
    Watcher.addIgnoreDir('/library/New Book')

    Watcher.removeIgnoreDir('/library/Old Book')
    Watcher.removeIgnoreDir('/library/New Book')
    expect(Watcher.checkShouldIgnorePath('/library/Old Book/a.mp3')).to.be.true

    clock.tick(5000)

    expect(Watcher.ignoreDirs).to.deep.equal([])
  })

  it('keeps ignoring a directory that is added again before the delay ends', () => {
    Watcher.addIgnoreDir('/library/Book')
    Watcher.removeIgnoreDir('/library/Book')
    Watcher.addIgnoreDir('/library/Book')

    clock.tick(5000)

    expect(Watcher.checkShouldIgnorePath('/library/Book/a.mp3')).to.be.true
  })
})
