// Thin wrappers around the interactive native pickers that bracket each launch
// with `systemUIActivity` so the App-Lock PIN doesn't re-lock the app while the
// picker/share sheet is open. Behaviour is otherwise identical to calling the
// expo functions directly — same args, same return value. Use these instead of
// the raw ImagePicker/DocumentPicker/Sharing calls everywhere in the app.
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { systemUIActivity } from './systemUIActivity';

export function pickImageLibrary(
  options?: ImagePicker.ImagePickerOptions,
): Promise<ImagePicker.ImagePickerResult> {
  return systemUIActivity.run(() => ImagePicker.launchImageLibraryAsync(options));
}

export function pickCamera(
  options?: ImagePicker.ImagePickerOptions,
): Promise<ImagePicker.ImagePickerResult> {
  return systemUIActivity.run(() => ImagePicker.launchCameraAsync(options));
}

export function pickDocument(
  options?: DocumentPicker.DocumentPickerOptions,
): Promise<DocumentPicker.DocumentPickerResult> {
  return systemUIActivity.run(() => DocumentPicker.getDocumentAsync(options));
}

export function shareFile(url: string, options?: Sharing.SharingOptions): Promise<void> {
  return systemUIActivity.run(() => Sharing.shareAsync(url, options));
}
