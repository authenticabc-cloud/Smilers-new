/**
 * withPodfileResourceBundleSigning — fix Xcode 14+ resource-bundle signing.
 *
 * Starting with Xcode 14, CocoaPods *resource-bundle* targets are code-signed
 * by default. On EAS Build these bundle targets have no development team set,
 * so the build fails with:
 *
 *   "Signing for "<SomePod>-<SomePod>" requires a development team.
 *    Starting from Xcode 14, resource bundles are signed by default,
 *    which requires setting the development team for each resource
 *    bundle target."
 *
 * The standard, Apple-safe fix is to disable code signing ONLY for the
 * CocoaPods resource-bundle targets (product type
 * `com.apple.product-type.bundle`). The main Smilers app target and all
 * framework/library targets keep their normal signing untouched.
 *
 * Because this project uses Expo prebuild (the `ios/` folder is regenerated
 * on every EAS build), a manual Podfile edit would be wiped. This config
 * plugin re-applies the patch to the generated Podfile at prebuild time via
 * `withDangerousMod`, so the fix always survives.
 *
 * Wired in app.json:
 *   "plugins": [..., "./plugins/withPodfileResourceBundleSigning"]
 */

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# withPodfileResourceBundleSigning — Xcode14 resource-bundle signing fix';

const INJECTION = `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      if target.respond_to?(:product_type) && target.product_type == 'com.apple.product-type.bundle'
        target.build_configurations.each do |bundle_config|
          bundle_config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
        end
      end
    end
`;

module.exports = function withPodfileResourceBundleSigning(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      // Idempotent — skip if already patched.
      if (contents.includes(MARKER)) {
        return cfg;
      }

      // Inject right after the opening of the post_install block so it runs
      // regardless of what react_native_post_install does inside the block.
      const postInstallRegex = /post_install do \|installer\|\n/;
      if (postInstallRegex.test(contents)) {
        contents = contents.replace(
          postInstallRegex,
          (match) => `${match}${INJECTION}`
        );
      } else {
        // No post_install block found — append a fresh one before the final
        // `end` of the outer target block is risky, so append at EOF instead.
        contents += `\npost_install do |installer|${INJECTION}end\n`;
      }

      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};
