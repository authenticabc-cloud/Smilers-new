// metro.config.js
//
// NOTE: Sentry's `getSentryExpoConfig` helper was removed because we
// dropped the `@sentry/react-native/expo` plugin from app.json (it was
// causing the EAS Gradle build to fail because its source-map upload
// task requires an auth token we don't yet have). We use the standard
// Expo metro config instead. The Sentry RUNTIME SDK (`@sentry/react-native`)
// is still installed and `sentry.init({dsn})` still runs at app start —
// but without the build-time plugin, source maps won't be uploaded and
// JS stack traces will appear minified on the Sentry dashboard.
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const { FileStore } = require('metro-cache');

const config = getDefaultConfig(__dirname);

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];


// // Exclude unnecessary directories from file watching
// config.watchFolders = [__dirname];
// config.resolver.blacklistRE = /(.*)\/(__tests__|android|ios|build|dist|.git|node_modules\/.*\/android|node_modules\/.*\/ios|node_modules\/.*\/windows|node_modules\/.*\/macos)(\/.*)?$/;

// // Alternative: use a more aggressive exclusion pattern
// config.resolver.blacklistRE = /node_modules\/.*\/(android|ios|windows|macos|__tests__|\.git|.*\.android\.js|.*\.ios\.js)$/;

// Reduce the number of workers to decrease resource usage
config.maxWorkers = 2;

module.exports = config;
