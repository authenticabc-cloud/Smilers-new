/**
 * ColorMatrixPreview — live Skia preview of the base photo with a color matrix
 * applied (grayscale / contrast / saturation). Rendered only while the Adjust
 * tool is active, on NATIVE only (lazy-loaded, so Skia never enters the web
 * bundle's eager path). No-ops until the image decodes.
 */
import React from 'react';
import { Canvas, Image as SkiaImage, ColorMatrix, useImage } from '@shopify/react-native-skia';

export default function ColorMatrixPreview({
  uri,
  width,
  height,
  matrix,
}: {
  uri: string;
  width: number;
  height: number;
  matrix: number[];
}) {
  const image = useImage(uri);
  if (!image) return null;
  return (
    <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height }}>
      <SkiaImage image={image} x={0} y={0} width={width} height={height} fit="contain">
        <ColorMatrix matrix={matrix} />
      </SkiaImage>
    </Canvas>
  );
}
