/**
 * Only the workspace watch list.
 *
 * SDK 52 needed a good deal more than this: Metro could not resolve through
 * pnpm's isolated store, so the config named every node_modules path by hand,
 * and two transitive dependencies had to be declared here because Metro could
 * not see them. SDK 57's default config handles all of that — verified by
 * removing this file entirely and bundling, which still worked.
 *
 * What remains is worth keeping. The shared packages are consumed as
 * TypeScript source from outside this project root, so without watching the
 * workspace a change in `packages/offline-queue` needs a bundler restart to
 * show up.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../..')];

module.exports = config;
