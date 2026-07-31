/**
 * autoEnhanceImage — one-tap "auto enhance" for the Photo Editor.
 *
 * Applies a real color-matrix (contrast + brightness + saturation) to the
 * source image using the Skia engine (offscreen GPU/CPU surface), then
 * re-encodes to a JPEG file and returns its uri. This is a TRUE pixel
 * transform (unlike the overlay-based tint filters), so it actually
 * brightens/pops the photo.
 *
 * Native-only: `@shopify/react-native-skia` requires a native build, so it is
 * lazy-imported (never pulled into the web bundle) and the function no-ops on
 * web. Fully defensive — returns null on any failure so the caller keeps the
 * original image.
 */
import { Platform } from 'react-native';

/**
 * Combined saturation(1.25) × contrast(1.12) + brightness(+0.04) color matrix
 * (4×5, RGBA). Offsets are in the normalized 0..1 range used by Skia.
 */
const ENHANCE_MATRIX = [
  1.3404, -0.2003, -0.0202, 0, -0.02,
  -0.0596, 1.1997, -0.0202, 0, -0.02,
  -0.0596, -0.2003, 1.3798, 0, -0.02,
  0, 0, 0, 1, 0,
];

export async function autoEnhanceImage(uri: string): Promise<string | null> {
  if (Platform.OS === 'web' || !uri) return null;
  try {
    const { Skia, ImageFormat } = await import('@shopify/react-native-skia');
    const LegacyFileSystem = await import('expo-file-system/legacy');

    const data = await Skia.Data.fromURI(uri);
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return null;

    const w = image.width();
    const h = image.height();
    const surface = Skia.Surface.MakeOffscreen(w, h);
    if (!surface) return null;

    const canvas = surface.getCanvas();
    const paint = Skia.Paint();
    paint.setColorFilter(Skia.ColorFilter.MakeMatrix(ENHANCE_MATRIX));
    canvas.drawImage(image, 0, 0, paint);
    surface.flush();

    const snapshot = surface.makeImageSnapshot();
    const b64 = snapshot.encodeToBase64(ImageFormat.JPEG, 92);
    if (!b64) return null;

    const out = `${LegacyFileSystem.cacheDirectory}pe_enhanced_${Date.now()}.jpg`;
    await LegacyFileSystem.writeAsStringAsync(out, b64, {
      encoding: LegacyFileSystem.EncodingType.Base64,
    });
    return out;
  } catch (err) {
    console.log('[autoEnhance] failed', err);
    return null;
  }
}

export default autoEnhanceImage;
