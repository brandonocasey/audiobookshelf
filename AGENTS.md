# Agent rules

This is a fork of [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf).

## Upstream compatibility

Make a best effort to keep the fork compatible with upstream. A server that ran the fork SHOULD be able to switch to upstream, and back, with the same config and metadata folders.

- Add no database migrations, tables, or columns. With the version below, the migration manager skips migrations on existing databases. When a feature needs a schema change, stop and ask the user.
- Store new library options as keys in the library `settings` JSON, which upstream keeps and ignores. Server settings keep only the keys `ServerSettings` names, so an extra key there is lost on the next save.
- Keep the `version` in `package.json` equal to the upstream release the fork is based on. The database records it, and a higher version makes upstream treat its own release as a downgrade.
- Keep stored data in the shapes upstream reads. When a feature moves files on disk, update every path the database stores for them.
- Keep API responses compatible with upstream clients. Add fields; do not rename or remove them.
- Keep edits to upstream files small, so upstream syncs merge cleanly. Put new code in new files where you can.
- When a change cannot stay compatible, say so in the pull request description, with what breaks when switching back to upstream.
