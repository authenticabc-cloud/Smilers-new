import React, { Component, ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../theme';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
  /** If provided, called whenever the boundary catches an error */
  onError?: (errorValue: Error) => void;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Bubble-scoped error boundary. If a single message bubble's render fails
 * (e.g. a Convex query for `files.getUrl` throws on a broken storageId), we
 * isolate the failure so the rest of the conversation keeps rendering and
 * the entire screen does not crash.
 */
export default class BubbleErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(errorValue: any): State {
    return {
      hasError: true,
      message:
        (errorValue && (errorValue.message || String(errorValue))) ||
        'Could not render this message',
    };
  }

  componentDidCatch(errorValue: Error) {
    console.warn('[BubbleErrorBoundary] caught render error:', errorValue?.message);
    if (this.props.onError) {
      this.props.onError(errorValue);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.bubble} testID="bubble-error-fallback">
          <Feather name="alert-triangle" size={14} color={Colors.danger} />
          <Text style={styles.label}>
            {this.props.fallbackLabel || 'Message unavailable'}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(220,38,38,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.18)',
    alignSelf: 'flex-start',
    marginVertical: Spacing.xs,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
    color: Colors.danger,
  },
});
