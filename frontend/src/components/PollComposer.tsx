import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Colors, FontSize, FontWeight, Spacing, Radius, Shadow } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSubmit: (poll: { question: string; options: { id: string; text: string }[] }) => void;
}

const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;

function randomId() {
  return Math.random().toString(36).slice(2, 9);
}

function createInitialOptions() {
  return [
    { id: randomId(), text: '' },
    { id: randomId(), text: '' },
  ];
}

export default function PollComposer({ visible, onClose, onSubmit }: Props) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<{ id: string; text: string }[]>(createInitialOptions());

  const reset = () => {
    setQuestion('');
    setOptions(createInitialOptions());
  };

  const close = () => {
    reset();
    onClose();
  };

  const updateOption = (id: string, text: string) => {
    setOptions((current) => current.map((option) => (option.id === id ? { ...option, text } : option)));
  };

  const addOption = () => {
    if (options.length < MAX_OPTIONS) {
      setOptions((current) => [...current, { id: randomId(), text: '' }]);
    }
  };

  const removeOption = (id: string) => {
    if (options.length > MIN_OPTIONS) {
      setOptions((current) => current.filter((option) => option.id !== id));
    }
  };

  const submit = () => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      Alert.alert('Add a question', 'Please enter a question for your poll.');
      return;
    }

    const cleanedOptions = options
      .map((option) => ({ ...option, text: option.text.trim() }))
      .filter((option) => option.text.length > 0);

    if (cleanedOptions.length < MIN_OPTIONS) {
      Alert.alert('Add more options', `Please enter at least ${MIN_OPTIONS} options.`);
      return;
    }

    onSubmit({ question: trimmedQuestion, options: cleanedOptions });
    reset();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={() => {}} testID="poll-composer-sheet">
          <View style={styles.grabber} />
          <View style={styles.header}>
            <TouchableOpacity onPress={close} hitSlop={10} testID="poll-close">
              <Feather name="x" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.title}>Create poll</Text>
            <TouchableOpacity onPress={submit} hitSlop={10} testID="poll-submit">
              <Text style={styles.send}>Send</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>QUESTION</Text>
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask something…"
              placeholderTextColor={Colors.textMuted}
              style={styles.questionInput}
              maxLength={140}
              multiline
              testID="poll-question"
            />
            <Text style={styles.charCount}>{question.length}/140</Text>

            <Text style={styles.label}>OPTIONS</Text>
            {options.map((option, index) => (
              <View key={option.id} style={styles.optionRow}>
                <View style={styles.optionDot}>
                  <Text style={styles.optionDotText}>{index + 1}</Text>
                </View>
                <TextInput
                  value={option.text}
                  onChangeText={(text) => updateOption(option.id, text)}
                  placeholder={`Option ${index + 1}`}
                  placeholderTextColor={Colors.textMuted}
                  style={styles.optionInput}
                  maxLength={80}
                  testID={`poll-option-${index}`}
                />
                {options.length > MIN_OPTIONS ? (
                  <TouchableOpacity onPress={() => removeOption(option.id)} hitSlop={10} testID={`poll-remove-${index}`}>
                    <Feather name="x-circle" size={20} color={Colors.textMuted} />
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}

            {options.length < MAX_OPTIONS ? (
              <TouchableOpacity style={styles.addOption} onPress={addOption} testID="poll-add-option">
                <Feather name="plus-circle" size={18} color={Colors.primary} />
                <Text style={styles.addOptionText}>Add option</Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    maxHeight: '90%',
    ...Shadow.lg,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginVertical: Spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: Colors.textPrimary },
  send: { fontSize: FontSize.base, fontWeight: FontWeight.bold, color: Colors.primary },
  scrollContent: { paddingBottom: Spacing.xl },
  label: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
    color: Colors.textSecondary,
    letterSpacing: 1,
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
  },
  questionInput: {
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    padding: Spacing.md,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    minHeight: 60,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  charCount: { fontSize: 10, color: Colors.textMuted, textAlign: 'right', marginTop: 2 },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  optionDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionDotText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.primary },
  optionInput: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addOption: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, marginTop: 4 },
  addOptionText: { fontSize: FontSize.base, color: Colors.primary, fontWeight: FontWeight.medium },
});