const { expect } = require('chai')

const { DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE, FILE_TOKENS } = require('../../../server/utils/organizeTemplate')
const { getTemplateExample } = require('../../../server/utils/organizeExample')

describe('organizeExample', () => {
  const previousServerSettings = global.ServerSettings

  beforeEach(() => {
    global.ServerSettings = { sortingPrefixes: ['the', 'a'] }
  })

  afterEach(() => {
    global.ServerSettings = previousServerSettings
  })

  describe('getTemplateExample', () => {
    it('renders the default templates for a series book with an ebook and a standalone book', () => {
      expect(getTemplateExample(DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE)).to.deep.include({
        folder: 'Brandon Sanderson/The Stormlight Archive/1. The Way of Kings',
        folderError: null,
        file: 'The Way of Kings - Part 1.mp3',
        fileError: null,
        samples: [
          {
            id: 'series',
            folder: 'Brandon Sanderson/The Stormlight Archive/1. The Way of Kings',
            files: [
              { name: 'The Way of Kings - Part 1.mp3', isEbook: false },
              { name: 'The Way of Kings - Part 2.mp3', isEbook: false },
              { name: 'The Way of Kings - Part 3.mp3', isEbook: false },
              { name: 'The Way of Kings.epub', isEbook: true }
            ]
          },
          { id: 'standalone', folder: 'Andy Weir/Project Hail Mary', files: [{ name: 'Project Hail Mary.m4b', isEbook: false }] }
        ]
      })
    })

    it('renders each file with its own details', () => {
      const { samples } = getTemplateExample('{titleIgnorePrefix}< ({originalYear})>', '{track}< {trackTitle}>< - {duration}> {format}')
      expect(samples.map((sample) => sample.folder)).to.deep.equal(['Way of Kings (2010)', 'Project Hail Mary'])
      expect(samples[0].files.map((file) => file.name)).to.deep.equal(['1 Prelude - 4 hr 30 min mp3.mp3', '2 Part One - 4 hr 15 min mp3.mp3', '3 Part Two - 3 hr 55 min mp3.mp3', 'epub.epub'])
    })

    it('lists every token once with an example and marks the file-only ones', () => {
      const { tokens } = getTemplateExample(DEFAULT_FOLDER_TEMPLATE, DEFAULT_FILE_TEMPLATE)
      expect(tokens.map((token) => token.name)).to.deep.equal(FILE_TOKENS)
      expect(tokens.filter((token) => !token.example)).to.deep.equal([])
      expect(tokens.filter((token) => token.fileOnly).map((token) => token.name)).to.deep.equal(['track', 'trackTotal', 'trackTitle', 'disc', 'duration'])
      expect(Object.fromEntries(tokens.map((token) => [token.name, token.example]))).to.include({ authorSort: 'Sanderson, Brandon', titleIgnorePrefix: 'Way of Kings', abridged: 'Abridged', duration: '4 hr 30 min', format: 'mp3' })
    })

    it('reports each invalid template and still renders the other one', () => {
      const example = getTemplateExample('{nope}', '{title}')
      expect(example).to.deep.include({ folder: '', folderError: 'Unknown token "{nope}"', file: 'The Way of Kings.mp3', fileError: null })
      expect(example.samples.map((sample) => sample.folder)).to.deep.equal(['', ''])

      const fileInvalid = getTemplateExample(DEFAULT_FOLDER_TEMPLATE, '{title}/x')
      expect(fileInvalid.fileError).to.be.a('string')
      expect(fileInvalid.file).to.equal('')
      expect(fileInvalid.samples.map((sample) => sample.files)).to.deep.equal([[], []])
      expect(fileInvalid.samples[1].folder).to.equal('Andy Weir/Project Hail Mary')
    })
  })
})
