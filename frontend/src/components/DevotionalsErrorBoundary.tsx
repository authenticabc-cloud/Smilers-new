import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';
import { recordDiagnostic } from '../lib/diagnostics';

interface Props {
  children: React.ReactNode;
  /** Called when the user taps "Close" (typically `router.back()`). */
  onClose: () => void;
  /** Logical screen name — e.g. 'devotionals-feed', 'devotionals-compose'. */
  source: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack?: string | null;
}

/**
 * DevotionalsErrorBoundary
 *
 * Catches render-time crashes inside the Devotionals stack (feed, compose,
 * preferences) and BOTH:
 *   1. Shows a friendly "Something went wrong" fallback so the rest of the
 *      app keeps working (no full process kill).
 *   2. Records the error message + component stack via `recordDiagnostic`,
 *      which persists it to AsyncStorage and POSTs it to the backend's
 *      `/api/diagnostic-logs` endpoint on the next app launch. The main
 *      agent can then read the actual crash trace via supervisor logs
 *      without needing the user to copy/paste anything.
 *
 * Without this, a render-time crash in the Devotionals stack would blow
 * up the React tree and Android would show "Smilers has stopped" / the
 * iOS process would die silently.
 */
export default class DevotionalsErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      // Pin the component stack onto state so the fallback can show it.
      this.setState((prev) => ({ ...prev, componentStack: info?.componentStack ?? null }));
    } catch {
      /* ignore */
    }
    try {
      // Forward to our diagnostics pipeline so it reaches the backend on
      // the next launch even if Sentry isn't configured / DSN missing.
      recordDiagnostic({
        tag: 'ERR',
        source: this.props.source || 'devotionals',
        message: `[DevotionalsErrorBoundary] ${error?.message || 'unknown error'}`,
        stack: `${error?.stack || ''}\n--- componentStack ---\n${info?.componentStack || ''}`.slice(
          0,
          4000,
        ),
      });
    } catch {
      /* swallow — best-effort log */
    }
    try {
      // Also log to JS console so `adb logcat` / Sentry breadcrumbs still
      // pick it up during development builds.
      // eslint-disable-next-line no-console
      console.warn(
        '[DevotionalsErrorBoundary] caught:',
        error?.message,
        info?.componentStack?.slice(0, 800),
      );
    } catch {
      /* ignore */
    }
  }

  handleClose = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
    try {
      this.props.onClose();
    } catch {
      /* swallow */
    }
  };

  render() {
    if (this.state.hasError) {
      const errorMessage = this.state.error?.message || 'Something went wrong.';
      return (
        <View style={styles.root} testID="devotionals-error-fallback">
          <View style={styles.iconWrap}>
            <Feather name="alert-triangle" size={36} color={Colors.white} />
          </View>
          <Text style={styles.title}>Devotionals can't open right now</Text>
          <Text style={styles.body}>
            We hit a snag loading this screen. The error was sent to our team — please tap close
            and try again in a moment.
          </Text>
          <Text style={styles.errorTechnical} numberOfLines={3}>
            {errorMessage.slice(0, 240)}
          </Text>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={this.handleClose}
            activeOpacity={0.85}
            testID="devotionals-error-close-btn"
          >
            <Text style={styles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children as any;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xxl,
    backgroundColor: Colors.background,
    gap: 14,
  },
  iconWrap: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#B45309',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  title: {
    fontSize: 20,
    fontWeight: FontWeight.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  body: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: Spacing.md,
  },
  errorTechnical: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: -2,
  },
  closeBtn: {
    marginTop: Spacing.lg,
    minHeight: 52,
    paddingHorizontal: 44,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: '#3D2A00',
    fontWeight: FontWeight.bold,
    fontSize: FontSize.base,
    letterSpacing: 0.4,
  },
});
