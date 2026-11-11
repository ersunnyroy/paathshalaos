/**
 * Two settings, one of which is load-bearing.
 *
 * `unstable_enablePackageExports = false`
 *
 *   The app crashed on a real phone before any of its own code ran:
 *
 *     [runtime not ready]: TypeError: Object is not a function
 *       createWebSocketConnection  <bundle>:93312
 *       ... metroRequire ... global <bundle>:139073
 *
 *   `createWebSocketConnection` is React Native's dev-server client, in the
 *   bundle's prelude. Nothing from `app/` had been evaluated yet, which is why
 *   three rounds of changes to this app's own startup path produced a
 *   byte-identical error.
 *
 *   With package-exports resolution on, Metro resolves React Native's internal
 *   subpath imports through its `exports` map, and a default-exported function
 *   arrives at the import site as a module namespace object. Calling it gives
 *   exactly this message — the same failure reported elsewhere as
 *   "getDevServer is not a function (it is Object)". Turning the resolver back
 *   to `main`-field resolution restores the interop React Native expects.
 *
 *   This is a workaround for a bundler default, not a preference. It should be
 *   removed when Expo's changelog says the interop is fixed.
 *
 * `watchFolders`
 *
 *   The shared packages are consumed as TypeScript source from outside this
 *   project root, so without this a change in `packages/offline-queue` needs a
 *   bundler restart to appear.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = false;
config.watchFolders = [path.resolve(__dirname, '../..')];

module.exports = config;
