/**
 * Cross-platform Sentry wrapper.
 *
 * `@sentry/react-native` provides native crash capture for iOS / Android
 * but does NOT support the web target. On web we no-op so the bundle
 * still compiles (the Metro web bundler chokes on the native-only
 * imports otherwise).
 *
 * Native crash visibility (NDK / Java / JS) is what we actually need for
 * the production Android APK — that's what initializes properly here.
 */

import { Platform } from 'react-native';

type SentryUserSubset = {
  id?: string;
  email?: string;
  username?: string;
} | null;

// Defaults — overwritten below on native.
let _init = (_opts: Record<string, any>) => {};
let _captureException = (_err: unknown, _ctx?: Record<string, any>) => undefined as any;
let _captureMessage = (_msg: string, _level?: any) => undefined as any;
let _setUser = (_u: SentryUserSubset) => {};
let _addBreadcrumb = (_bc: Record<string, any>) => {};
let _nativeCrash = () => {};
let _available = false;

if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SentryRN = require('@sentry/react-native');
    if (SentryRN) {
      _init = (opts: Record<string, any>) => {
        try {
          SentryRN.init(opts);
        } catch {}
      };
      _captureException = (err: unknown, ctx?: Record<string, any>) => {
        try {
          return SentryRN.captureException(err, ctx);
        } catch {}
      };
      _captureMessage = (msg: string, level?: any) => {
        try {
          return SentryRN.captureMessage(msg, level);
        } catch {}
      };
      _setUser = (u: SentryUserSubset) => {
        try {
          SentryRN.setUser(u);
        } catch {}
      };
      _addBreadcrumb = (bc: Record<string, any>) => {
        try {
          SentryRN.addBreadcrumb(bc);
        } catch {}
      };
      _nativeCrash = () => {
        try {
          if (typeof SentryRN.nativeCrash === 'function') SentryRN.nativeCrash();
        } catch {}
      };
      _available = true;
    }
  } catch {
    // require failed — leave the no-ops in place.
  }
}

export const sentry = {
  init: _init,
  captureException: _captureException,
  captureMessage: _captureMessage,
  setUser: _setUser,
  addBreadcrumb: _addBreadcrumb,
  nativeCrash: _nativeCrash,
  isAvailable: () => _available,
};

export default sentry;
