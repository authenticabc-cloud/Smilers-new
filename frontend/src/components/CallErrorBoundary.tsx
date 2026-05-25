import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface CallErrorBoundaryProps {
  children: React.ReactNode;
  /** Called when the user taps "Close" — typically `router.back()`. */
  onClose: () => void;
}

interface CallErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * CallErrorBoundary — catches render-time crashes inside the call screen
 * (e.g. a WebRTC native-module load failure on the receiver-answer path,
 * a stale ref deref after `activeCall.status → 'active'`, or any other
 * unhandled JS error) and shows a friendly "Call ended" fallback instead
 * of crashing the whole app.
 *
 * Without this, a crash inside the call screen blows away the React
 * tree because the call screen mounts as a modal stack — there's no
 * outer error boundary to catch it.
 */
export default class CallErrorBoundary extends React.Component<
  CallErrorBoundaryProps,
  CallErrorBoundaryState
> {
  constructor(props: CallErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): CallErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log so the dev / Sentry / Crashlytics pipeline still sees it.
    console.warn(
      '[CallErrorBoundary] Recovered from a call-screen crash:',
      error?.message,
      info?.componentStack,
    );
  }

  handleClose = () => {
    this.setState({ hasError: false, error: null });
    try {
      this.props.onClose();
    } catch {
      /* swallow — best effort. */
    }
  };

  render() {
    if (this.state.hasError) {
      const message = this.state.error?.message || 'Something went wrong with this call.';
      return (
        <View style={styles.root} testID="call-error-fallback">
          <View style={styles.iconWrap}>
            <Feather name="phone-off" size={42} color={Colors.white} />
          </View>
          <Text style={styles.title}>Call ended unexpectedly</Text>
          <Text style={styles.body}>
            We hit an error while connecting your call. Please tap close and try again.
          </Text>
          <Text style={styles.errorTechnical} numberOfLines={2}>
            {message.slice(0, 200)}
          </Text>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={this.handleClose}
            activeOpacity={0.85}
            testID="call-error-close-btn"
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
    backgroundColor: 'rgba(220,38,38,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  title: {
    fontSize: 22,
    fontWeight: FontWeight.bold,
    color: Colors.white,
    textAlign: 'center',
  },
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
