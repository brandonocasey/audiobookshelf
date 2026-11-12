const Path = require('path')
const fs = require('../libs/fsExtra')

/**
 * Find a file below a path that changed after a point in time.
 * Uses the change time, which also moves for files copied with their old modified time kept.
 * A file that vanishes during the walk counts as changed.
 *
 * @param {string} path File or folder
 * @param {number} sinceMs
 * @param {Set<string>} [ignoredPaths] Files that do not count
 * @returns {Promise<string|null>} Path of the first changed file, or null
 */
async function findFileChangedAfter(path, sinceMs, ignoredPaths = new Set()) {
  try {
    const stats = await fs.lstat(path)
    if (!stats.isDirectory()) return !ignoredPaths.has(path) && stats.ctimeMs > sinceMs ? path : null

    for (const entry of await fs.readdir(path)) {
      const changedPath = await findFileChangedAfter(Path.join(path, entry), sinceMs, ignoredPaths)
      if (changedPath) return changedPath
    }
    return null
  } catch (error) {
    if (error.code === 'ENOENT') return path
    throw error
  }
}
module.exports.findFileChangedAfter = findFileChangedAfter
