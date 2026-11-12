const { expect } = require('chai')
const { LibraryItemPaths } = require('../../../server/utils/organizePlan')

describe('LibraryItemPaths', () => {
  it('finds an item below a folder at any depth and not one beside it or the folder itself', () => {
    const itemPaths = new LibraryItemPaths(['/lib/Dune', '/lib/Dune Messiah/Part 1', '/lib/Sci Fi/Hyperion/2. Sub'])

    expect(itemPaths.hasPathBelow('/lib/Sci Fi', '/lib/Dune')).to.be.true
    expect(itemPaths.hasPathBelow('/lib/Sci Fi/Hyperion', '/lib/Dune')).to.be.true
    expect(itemPaths.hasPathBelow('/lib/Dune', '/lib/Other')).to.be.false
    expect(itemPaths.hasPathBelow('/lib/Dune Messiah', '/lib/Other')).to.be.true
  })

  it('does not count the ignored path', () => {
    const itemPaths = new LibraryItemPaths(['/lib/Dune/Part 1', '/lib/Dune/Part 2'])

    expect(itemPaths.hasPathBelow('/lib/Dune', '/lib/Dune/Part 1')).to.be.true
    itemPaths.delete('/lib/Dune/Part 2')
    expect(itemPaths.hasPathBelow('/lib/Dune', '/lib/Dune/Part 1')).to.be.false
    expect(itemPaths.hasPathBelow('/lib/Dune', '/lib/Other')).to.be.true
  })

  it('follows items that are added, moved and removed', () => {
    const itemPaths = new LibraryItemPaths(['/lib/Raw'])

    itemPaths.delete('/lib/Raw')
    itemPaths.add('/lib/Writer/Book')
    itemPaths.add('/lib/Writer/Book')
    expect(itemPaths.has('/lib/Raw')).to.be.false
    expect(itemPaths.hasPathBelow('/lib/Writer', '/lib/Raw')).to.be.true
    itemPaths.delete('/lib/Writer/Book')
    expect(itemPaths.hasPathBelow('/lib/Writer', '/lib/Raw')).to.be.false
  })
})
