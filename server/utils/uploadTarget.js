const Path = require('path')
const fs = require('../libs/fsExtra')
const Database = require('../Database')
const { sanitizeFilename, filePathToPOSIX } = require('./fileUtils')
const { getUploadLayout } = require('./organizeTemplate')

/**
 * @typedef UploadTarget
 * @property {string} directory Folder below the library folder, "/" separated. Empty when the details produce no folder name
 * @property {string} path Absolute folder path
 * @property {Map<string,string>} newNames Uploaded file name to the name it is saved under, for each audio file and a lone ebook. Empty when new names collide.
 * @property {boolean} exists The folder exists or lies inside a library item's folder
 * @property {string} [libraryItemTitle] Title of the library item that contains the folder
 */

/**
 * Where an upload is saved. Book folder and file names come from the library's organize templates.
 *
 * @param {import('../models/Library')} library Library with folders
 * @param {import('../models/LibraryFolder')} libraryFolder
 * @param {{title:string, author:string|null, series:string|null}} details
 * @param {string[]} uploadedNames
 * @returns {Promise<UploadTarget>}
 */
async function getUploadTarget(library, libraryFolder, details, uploadedNames) {
  const layout = library.isPodcast ? { folderSegments: [sanitizeFilename(details.title)], newNames: new Map() } : getUploadLayout(library.librarySettings, details, uploadedNames)
  const folderSegments = layout.folderSegments.filter(Boolean)
  const path = Path.join(libraryFolder.path, ...folderSegments)
  const target = { directory: folderSegments.join('/'), path, newNames: layout.newNames, exists: false }
  if (!folderSegments.length) return target

  if (await fs.pathExists(path)) {
    target.exists = true
    return target
  }
  const libraryItem = await Database.libraryItemModel.findByAncestorPath(libraryFolder.path, filePathToPOSIX(path))
  if (libraryItem) {
    target.exists = true
    target.libraryItemTitle = libraryItem.title
  }
  return target
}

module.exports = { getUploadTarget }
