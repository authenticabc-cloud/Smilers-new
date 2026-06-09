import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';
import { recordDiagnostic } from '../lib/diagnostics';

interface ScreenErrorBoundaryProps {
  children: React.ReactNode;
  /** Where the boundary lives — used in diagnostic logs. */
  screenName: string;
  /** Called when the user taps "Close" — typically `router.back()`. */
  onClose: () => void;
}

interface ScreenErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Generic JS render-time error boundary for individual screens.
 * Without this, a render error inside a route file (e.g. a status
 * thumbnail tap navigating into status-view, an earnings hook throwing
 * a ReferenceError, etc.) takes down the whole React tree and Android
 * shows the dreaded "Smilers has stopped" dialog.
 *
 * NOTE: This catches JS errors only — native (JNI / Hermes / expo-video)
 * crashes still go to the OS. We mitigate those separately by guarding
 * native module calls (see status-view StoryVideo split).
 */
export default class ScreenErrorBoundary extends React.Component<
  ScreenErrorBoundaryProps,
  ScreenErrorBoundaryState
> {
  constructor(props: ScreenErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ScreenErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      recordDiagnostic({
        tag: 'ERR',
        source: `ScreenErrorBoundary:${this.props.screenName}`,
        message: `name=${error?.name || 'Error'} msg=${(error?.message || '').slice(0, 280)}`,
        stack: info?.componentStack?.slice(0, 1500) || error?.stack || null,
      });
    } catch {
      /* silent */
    }
    // Also log so adb logcat shows the cause if the user can capture it.
    console.warn(
      `[ScreenErrorBoundary:${this.props.screenName}]`,
      error?.message,
      info?.componentStack,
    );
  }

  handleClose = () => {
    this.setState({ hasError: false, error: null });
    try {
      this.props.onClose();
    } catch {
      /* silent */
    }
  };

  render() {
    if (this.state.hasError) {
      const message = this.state.error?.message || 'Something went wrong on this screen.';
      return (
        <View style={styles.root} testID={`${this.props.screenName}-error-fallback`}>
          <View style={styles.iconWrap}>
            <Feather name="alert-triangle" size={42} color={Colors.white} />
          </View>
          <Text style={styles.title}>This screen hit a snag</Text>
          <Text style={styles.body}>
            Sorry — we caught an error while loading this page. Please go back and try again.
          </Text>
          <Text style={styles.errorTechnical} numberOfLines={3}>
            {message.slice(0, 240)}
          </Text>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={this.handleClose}
            activeOpacity={0.85}
            testID={`${this.props.screenName}-error-close-btn`}
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
    backgroundColor: '#1a1004',
    gap: 16,
  },
  iconWrap: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(220,140,38,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  title: { fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white, textAlign: 'center' },
  body: {
    fontSize: FontSize.base,
    color: 'rgba(255,255,255,0.78)',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: Spacing.md,
  },
  errorTechnical: {
    fontSize: FontSize.xs,
    color: 'rgba(255,255,255,0.45)',
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: -4,
  },
  closeBtn: {
    marginTop: Spacing.lg,
    minHeight: 56,
    paddingHorizontal: 48,
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
