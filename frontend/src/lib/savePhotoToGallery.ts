/**
 * savePhotoToGallery — download/save a photo (remote URL, data: URI, or local
 * file://) to the device gallery, with silent-friendly permission handling.
 * Shared by the own-profile and other-user profile photo viewers (iter-226).
 *
 * Returns true on success. Shows an "Open Settings" prompt if permission is
 * permanently denied. Throws are left to the caller to surface a message.
 */
import { Alert, Linking, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as LegacyFileSystem from 'expo-file-system/legacy';

export async function savePhotoToGallery(uri: string | null | undefined): Promise<boolean> {
  if (!uri || Platform.OS === 'web') return false;

  let perm = await MediaLibrary.getPermissionsAsync();
  if (perm.status !== 'granted' && perm.canAskAgain) {
    perm = await MediaLibrary.requestPermissionsAsync();
  }
  if (perm.status !== 'granted') {
    Alert.alert(
      'Photo access needed',
      'Allow photo access to save the picture to your gallery.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return false;
  }

  let localUri = uri;
  if (!uri.startsWith('file://')) {
    const fs: any = LegacyFileSystem;
    const target = `${fs.cacheDirectory}smilers_photo_${Date.now()}.jpg`;
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      await fs.writeAsStringAsync(target, uri.slice(comma + 1), { encoding: 'base64' });
    } else {
      const res = await fs.downloadAsync(uri, target);
      if (res?.status && res.status >= 400) throw new Error('download failed');
    }
    localUri = target;
  }
  await MediaLibrary.saveToLibraryAsync(localUri);
  return true;
}
