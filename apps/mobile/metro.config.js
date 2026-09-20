/**
 * Metro, taught about this workspace.
 *
 * Metro resolves by walking `node_modules` upwards from a file, with no
 * understanding of pnpm's isolated store. The obvious fix is to hoist
 * everything — and that was tried and reverted, because this workspace holds
 * two React majors: React Native 0.76 requires React 18, the web app is on
 * React 19, and a single hoisted root gives one of them the wrong one. The web
 * build failed with a null `useRef` during prerender, which is a duplicate
 * React by another name.
 *
 * So Metro is configured rather than the installer. This is the contained
 * change: it affects only the app that needs it, and every other package keeps
 * the strict linking that stops it importing what it never declared.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The shared packages are consumed as TypeScript source, so Metro has to watch
// them or a change in `packages/offline-queue` needs a bundler restart.
config.watchFolders = [workspaceRoot];

// This app's own modules first, then the root. Order matters: it is what makes
// React resolve to the 18 this app pins rather than the 19 next door.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// pnpm links workspace packages by symlink, and the shared ones live outside
// this project root.
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
