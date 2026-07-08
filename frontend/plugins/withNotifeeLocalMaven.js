/**
 * withNotifeeLocalMaven
 *
 * Adds the local Notifee AAR maven repository to allprojects.repositories in
 * android/build.gradle. This must come BEFORE the remote repos so Gradle
 * resolves app.notifee:core from the bundled file instead of hitting the
 * network (JitPack is unreliable on EAS and slow on local builds).
 *
 * The patch-notifee.js postinstall script pins the version; this plugin
 * ensures the local repo URL is present in the root build.gradle after every
 * expo prebuild run.
 */
const { withProjectBuildGradle } = require('@expo/config-plugins');

const LOCAL_MAVEN_LINE = `    maven { url "$rootDir/../node_modules/@notifee/react-native/android/libs" }`;
const COMMENT_LINE = `    // Local Notifee AAR — must come before remote repos so Gradle resolves\n    // app.notifee:core from the bundled file rather than hitting the network.`;

module.exports = function withNotifeeLocalMaven(config) {
  return withProjectBuildGradle(config, (mod) => {
    const contents = mod.modResults.contents;

    // Idempotent — skip if already patched.
    if (contents.includes('@notifee/react-native/android/libs')) {
      return mod;
    }

    // Insert local maven repo at the top of allprojects.repositories block.
    mod.modResults.contents = contents.replace(
      /allprojects\s*\{\s*\n\s*repositories\s*\{\s*\n/,
      `allprojects {\n  repositories {\n${COMMENT_LINE}\n${LOCAL_MAVEN_LINE}\n`,
    );

    return mod;
  });
};
