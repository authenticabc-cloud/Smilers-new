/**
 * PhotoEditor — reusable full-screen photo editor (Phase 1).
 *
 * Tools: freehand DRAW (color + brush size), TEXT (color + size, draggable),
 * EMOJI/STICKERS (draggable, resizable), CROP (movable/resizable rect) and
 * 90° ROTATE. The base image + SVG strokes + draggable overlays are composited
 * with `react-native-view-shot` on Save; crop/rotate bake the current result
 * first (via `expo-image-manipulator`) so annotations are preserved & correctly
 * transformed. Filters & blur are Phase 2.
 *
 * Native only: view-shot + image-manipulator require a native build — the
 * modules are lazy-imported so the rest of the app (and web preview) is
 * unaffected. Use as a controlled <Modal>: pass `imageUri`, get `onDone(uri)`.
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { BlurView } from 'expo-blur';
import Slider from '@react-native-community/slider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildAdjustMatrix, applyColorMatrixToImage, AdjustParams } from '../../lib/photo/colorMatrix';

// Skia live preview — lazy so Skia never enters the web bundle's eager path.
const ColorMatrixPreview = React.lazy(() => import('./ColorMatrixPreview'));

const PREFS_KEY = 'smilers.photoeditor.prefs.v1';
const LOOK_KEY = 'smilers.photoeditor.customlook.v1';

type Tool = 'draw' | 'text' | 'sticker' | 'crop' | 'filter' | 'blur' | 'adjust' | null;

const ADJUST_DEFAULT: Required<AdjustParams> = { grayscale: 0, contrast: 1, saturation: 1, brightness: 0 };

/** One-tap looks built on the Adjust sliders. */
const ADJUST_PRESETS: { key: string; label: string; params: Required<AdjustParams> }[] = [
  { key: 'original', label: 'Original', params: { grayscale: 0, contrast: 1, saturation: 1, brightness: 0 } },
  { key: 'vivid', label: 'Vivid', params: { grayscale: 0, contrast: 1.18, saturation: 1.5, brightness: 0.02 } },
  { key: 'punch', label: 'Punch', params: { grayscale: 0, contrast: 1.32, saturation: 1.3, brightness: 0 } },
  { key: 'muted', label: 'Muted', params: { grayscale: 0, contrast: 0.95, saturation: 0.6, brightness: 0.02 } },
  { key: 'bw', label: 'B&W', params: { grayscale: 1, contrast: 1.12, saturation: 0, brightness: 0 } },
];

interface Stroke {
  d: string;
  color: string;
  width: number;
}
interface TextItem {
  id: string;
  text: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  color: string;
  fontSize: number;
}
interface StickerItem {
  id: string;
  emoji: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  fontSize: number;
}
interface BlurItem {
  id: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** Full-image tint filters (overlay-based → captured reliably by view-shot). */
const FILTERS: { key: string; label: string; color: string; opacity: number }[] = [
  { key: 'none', label: 'Original', color: 'transparent', opacity: 0 },
  { key: 'warm', label: 'Warm', color: '#FF7A00', opacity: 0.2 },
  { key: 'cool', label: 'Cool', color: '#0A6CFF', opacity: 0.2 },
  { key: 'vintage', label: 'Vintage', color: '#6B4A2B', opacity: 0.3 },
  { key: 'sunset', label: 'Sunset', color: '#FF2D55', opacity: 0.22 },
  { key: 'bright', label: 'Bright', color: '#FFFFFF', opacity: 0.22 },
  { key: 'fade', label: 'Fade', color: '#F5F0E6', opacity: 0.3 },
  { key: 'dim', label: 'Dim', color: '#000000', opacity: 0.28 },
];

const PALETTE = [
  '#FFFFFF',
  '#000000',
  '#FF3B30',
  '#FF9500',
  '#FFCC00',
  '#34C759',
  '#00C7BE',
  '#0A84FF',
  '#5856D6',
  '#FF2D92',
];
const BRUSHES = [4, 8, 14];
const TEXT_SIZES = [20, 28, 40];
const EMOJIS = [
  '😀', '😂', '🥰', '😍', '😎', '🤩', '😭', '😡', '👍', '👏',
  '🙏', '🔥', '❤️', '💯', '🎉', '⭐', '✨', '💫', '🌈', '☀️',
  '🎂', '🎁', '💐', '🌹', '⚡', '💦', '👀', '💀', '🤝', '✅',
];

export interface PhotoEditorProps {
  visible: boolean;
  imageUri: string | null;
  onCancel: () => void;
  onDone: (uri: string) => void;
  /** Optional hint (e.g. "profile") — currently only used for the title. */
  contextLabel?: string;
}

export default function PhotoEditor({ visible, imageUri, onCancel, onDone, contextLabel }: PhotoEditorProps) {
  const insets = useSafeAreaInsets();
  const screen = Dimensions.get('window');

  const [baseUri, setBaseUri] = useState<string | null>(imageUri);
  const [natW, setNatW] = useState(0);
  const [natH, setNatH] = useState(0);
  const [tool, setTool] = useState<Tool>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [stickers, setStickers] = useState<StickerItem[]>([]);
  const [blurs, setBlurs] = useState<BlurItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [filter, setFilter] = useState('none');
  const [adjust, setAdjust] = useState<Required<AdjustParams>>(ADJUST_DEFAULT);
  const [customLook, setCustomLook] = useState<Required<AdjustParams> | null>(null);
  // Preferred default Adjust values applied whenever the editor opens.
  const defaultLookRef = useRef<Required<AdjustParams>>(ADJUST_DEFAULT);
  const [eraser, setEraser] = useState(false);
  const [color, setColor] = useState('#FF3B30');
  const [brush, setBrush] = useState(8);
  const [textSize, setTextSize] = useState(28);
  const [busy, setBusy] = useState(false);

  // text input modal
  const [textDraft, setTextDraft] = useState('');
  const [textModal, setTextModal] = useState(false);

  const canvasRef = useRef<View>(null);
  const pathRef = useRef('');

  // Remember the last-used color & brush size across editing sessions.
  const prefsLoaded = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PREFS_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (typeof p.color === 'string') setColor(p.color);
          if (typeof p.brush === 'number') setBrush(p.brush);
        }
      } catch {}
      prefsLoaded.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ color, brush })).catch(() => {});
  }, [color, brush]);

  // Load the user's saved custom "My look" adjustment preset.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(LOOK_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (typeof p?.contrast === 'number' && typeof p?.saturation === 'number') {
            const look = { grayscale: p.grayscale ?? 0, contrast: p.contrast, saturation: p.saturation, brightness: p.brightness ?? 0 };
            setCustomLook(look);
            defaultLookRef.current = look; // pre-fill the editor with the user's signature look
          }
        }
      } catch {}
    })();
  }, []);

  const saveCustomLook = useCallback(() => {
    const look = { ...adjust };
    setCustomLook(look);
    defaultLookRef.current = look;
    AsyncStorage.setItem(LOOK_KEY, JSON.stringify(look)).catch(() => {});
  }, [adjust]);

  useEffect(() => {
    setBaseUri(imageUri);
    setStrokes([]);
    setTexts([]);
    setStickers([]);
    setBlurs([]);
    setSelectedId(null);
    setFilter('none');
    setAdjust(defaultLookRef.current);
    setTool(null);
  }, [imageUri]);

  // Measure the natural size to compute a fitted canvas box.
  useEffect(() => {
    if (!baseUri) return;
    Image.getSize(
      baseUri,
      (w, h) => {
        setNatW(w);
        setNatH(h);
      },
      () => {
        setNatW(1);
        setNatH(1);
      },
    );
  }, [baseUri]);

  useEffect(() => {
    if (tool !== 'draw' && eraser) setEraser(false);
  }, [tool, eraser]);

  const HEADER_H = 52 + insets.top;
  const TOOLBAR_H = (tool === 'adjust' ? 288 : 132) + insets.bottom;
  const areaW = screen.width;
  const areaH = screen.height - HEADER_H - TOOLBAR_H;

  const { cw, ch } = useMemo(() => {
    if (!natW || !natH) return { cw: areaW, ch: areaH };
    const scale = Math.min(areaW / natW, areaH / natH);
    return { cw: Math.max(1, Math.round(natW * scale)), ch: Math.max(1, Math.round(natH * scale)) };
  }, [natW, natH, areaW, areaH]);

  // crop rect (display coords, relative to the canvas box)
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 0, h: 0 });
  useEffect(() => {
    setCrop({ x: 0, y: 0, w: cw, h: ch });
  }, [cw, ch]);

  // ── Drawing capture (only mounted when tool === 'draw') ──────────────────
  const strokesRef = useRef<Stroke[]>([]);
  strokesRef.current = strokes;
  const eraseAt = useCallback((x: number, y: number, radius: number) => {
    const survivors = strokesRef.current.filter((s) => {
      // parse the numeric coords out of the "M x y L x y …" path and test proximity
      const nums = s.d.match(/-?\d+(?:\.\d+)?/g);
      if (!nums) return true;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const px = parseFloat(nums[i]);
        const py = parseFloat(nums[i + 1]);
        if (Math.hypot(px - x, py - y) <= radius) return false; // touched → remove
      }
      return true;
    });
    if (survivors.length !== strokesRef.current.length) setStrokes(survivors);
  }, []);
  const drawResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          if (eraser) {
            eraseAt(locationX, locationY, Math.max(18, brush * 2));
            return;
          }
          pathRef.current = `M ${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          setCurrentPath(pathRef.current);
        },
        onPanResponderMove: (e) => {
          const { locationX, locationY } = e.nativeEvent;
          if (eraser) {
            eraseAt(locationX, locationY, Math.max(18, brush * 2));
            return;
          }
          pathRef.current += ` L ${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
          setCurrentPath(pathRef.current);
        },
        onPanResponderRelease: () => {
          if (!eraser && pathRef.current.includes('L')) {
            const d = pathRef.current;
            setStrokes((prev) => [...prev, { d, color, width: brush }]);
          }
          pathRef.current = '';
          setCurrentPath('');
        },
      }),
    [color, brush, eraser, eraseAt],
  );

  // ── Draggable overlay factory ────────────────────────────────────────────
  const addText = () => {
    setEditingTextId(null);
    setTextDraft('');
    setTextModal(true);
  };
  const openEditText = (t: TextItem) => {
    setEditingTextId(t.id);
    setTextDraft(t.text);
    setColor(t.color);
    setTextSize(t.fontSize);
    setTool('text');
    setTextModal(true);
  };
  const commitText = () => {
    const t = textDraft.trim();
    setTextModal(false);
    if (!t) {
      setEditingTextId(null);
      return;
    }
    if (editingTextId) {
      setTexts((prev) =>
        prev.map((p) => (p.id === editingTextId ? { ...p, text: t, color, fontSize: textSize } : p)),
      );
      setEditingTextId(null);
      return;
    }
    setTexts((prev) => [
      ...prev,
      { id: `t_${Date.now()}`, text: t, x: cw / 2 - 40, y: ch / 2 - textSize, scale: 1, rotation: 0, color, fontSize: textSize },
    ]);
    setTool(null);
  };

  const addSticker = (emoji: string) => {
    setStickers((prev) => [
      ...prev,
      { id: `s_${Date.now()}`, emoji, x: cw / 2 - 24, y: ch / 2 - 24, scale: 1, rotation: 0, fontSize: 48 },
    ]);
    setTool(null);
  };

  const addBlur = () => {
    setBlurs((prev) => [...prev, { id: `b_${Date.now()}`, x: cw / 2 - 70, y: ch / 2 - 45, scale: 1, rotation: 0 }]);
  };

  const deleteItem = (id: string) => {
    setTexts((p) => p.filter((i) => i.id !== id));
    setStickers((p) => p.filter((i) => i.id !== id));
    setBlurs((p) => p.filter((i) => i.id !== id));
    setSelectedId(null);
  };

  const undo = () => {
    if (strokes.length) setStrokes((p) => p.slice(0, -1));
    else if (blurs.length) setBlurs((p) => p.slice(0, -1));
    else if (stickers.length) setStickers((p) => p.slice(0, -1));
    else if (texts.length) setTexts((p) => p.slice(0, -1));
  };

  // Flatten current canvas (image + annotations) → temp png uri.
  const flatten = useCallback(async (): Promise<string | null> => {
    try {
      setSelectedId(null); // hide selection border/delete handle from the export
      await new Promise((r) => setTimeout(r, 60));
      const { captureRef } = await import('react-native-view-shot');
      const uri = await captureRef(canvasRef, { format: 'png', quality: 1, result: 'tmpfile' });
      return uri as string;
    } catch (err) {
      console.log('[PhotoEditor] capture failed', err);
      return null;
    }
  }, []);

  const clearAnnotations = () => {
    setStrokes([]);
    setTexts([]);
    setStickers([]);
    setBlurs([]);
    setSelectedId(null);
    setCurrentPath('');
  };

  const applyRotate = async () => {
    if (!baseUri || busy) return;
    setBusy(true);
    try {
      const flat = (await flatten()) || baseUri;
      const IM = await import('expo-image-manipulator');
      const res = await IM.manipulateAsync(flat, [{ rotate: 90 }], {
        compress: 1,
        format: IM.SaveFormat.PNG,
      });
      clearAnnotations();
      setNatW(0);
      setNatH(0);
      setBaseUri(res.uri);
    } catch (err) {
      console.log('[PhotoEditor] rotate failed', err);
    } finally {
      setBusy(false);
      setTool(null);
    }
  };

  const applyEnhance = async () => {
    if (!baseUri || busy) return;
    setBusy(true);
    try {
      const flat = (await flatten()) || baseUri;
      const { autoEnhanceImage } = await import('../../lib/photo/autoEnhance');
      const enhanced = await autoEnhanceImage(flat);
      if (enhanced) {
        clearAnnotations();
        setFilter('none');
        setNatW(0);
        setNatH(0);
        setBaseUri(enhanced);
      }
    } catch (err) {
      console.log('[PhotoEditor] enhance failed', err);
    } finally {
      setBusy(false);
      setTool(null);
    }
  };

  const applyAdjust = async () => {
    if (!baseUri || busy) return;
    // Nothing changed → just close.
    const changed = adjust.grayscale !== 0 || adjust.contrast !== 1 || adjust.saturation !== 1;
    if (!changed) {
      setTool(null);
      return;
    }
    setBusy(true);
    try {
      // Apply to the PHOTO only (keep annotations untouched, matching the preview).
      const matrix = buildAdjustMatrix(adjust);
      const out = await applyColorMatrixToImage(baseUri, matrix);
      if (out) {
        setNatW(0);
        setNatH(0);
        setBaseUri(out);
      }
    } catch (err) {
      console.log('[PhotoEditor] adjust failed', err);
    } finally {
      setAdjust(ADJUST_DEFAULT);
      setBusy(false);
      setTool(null);
    }
  };

  const applyCrop = async () => {
    if (!baseUri || busy || !natW) return;
    setBusy(true);
    try {
      const flat = (await flatten()) || baseUri;
      // map crop rect (display) → source pixels of the flattened image (== cw×ch scaled to natW×natH)
      const sx = natW / cw;
      const sy = natH / ch;
      const IM = await import('expo-image-manipulator');
      const res = await IM.manipulateAsync(
        flat,
        [
          {
            crop: {
              originX: Math.max(0, Math.round(crop.x * sx)),
              originY: Math.max(0, Math.round(crop.y * sy)),
              width: Math.max(1, Math.round(crop.w * sx)),
              height: Math.max(1, Math.round(crop.h * sy)),
            },
          },
        ],
        { compress: 1, format: IM.SaveFormat.PNG },
      );
      clearAnnotations();
      setNatW(0);
      setNatH(0);
      setBaseUri(res.uri);
    } catch (err) {
      console.log('[PhotoEditor] crop failed', err);
    } finally {
      setBusy(false);
      setTool(null);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const flat = await flatten();
      if (!flat) {
        onCancel();
        return;
      }
      // Re-encode to a reasonably sized JPEG for sending/storage.
      const IM = await import('expo-image-manipulator');
      const longest = Math.max(natW || cw, natH || ch);
      const actions: any[] = [];
      if (longest > 1600) {
        actions.push({ resize: natW >= natH ? { width: 1600 } : { height: 1600 } });
      }
      const res = await IM.manipulateAsync(flat, actions, {
        compress: 0.85,
        format: IM.SaveFormat.JPEG,
      });
      onDone(res.uri);
    } catch (err) {
      console.log('[PhotoEditor] save failed', err);
      onCancel();
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  const inCrop = tool === 'crop';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.root}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
          <TouchableOpacity onPress={onCancel} hitSlop={10} style={styles.headerBtn} testID="pe-cancel">
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{contextLabel ? `Edit ${contextLabel}` : 'Edit photo'}</Text>
          <TouchableOpacity onPress={save} hitSlop={10} style={styles.headerBtn} disabled={busy} testID="pe-save">
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.doneText}>Done</Text>}
          </TouchableOpacity>
        </View>

        {/* Canvas area */}
        <View style={[styles.area, { height: areaH }]}>
          <View
            ref={canvasRef}
            collapsable={false}
            style={{ width: cw, height: ch, backgroundColor: '#000' }}
          >
            {baseUri ? (
              <Image source={{ uri: baseUri }} style={{ width: cw, height: ch }} resizeMode="contain" />
            ) : null}

            {/* live Skia adjust preview (native only) — overlays the photo */}
            {tool === 'adjust' && baseUri && Platform.OS !== 'web' ? (
              <Suspense fallback={null}>
                <ColorMatrixPreview uri={baseUri} width={cw} height={ch} matrix={buildAdjustMatrix(adjust)} />
              </Suspense>
            ) : null}

            {/* filter tint overlay (sits directly on the photo) */}
            {filter !== 'none'
              ? (() => {
                  const f = FILTERS.find((x) => x.key === filter);
                  if (!f) return null;
                  return (
                    <View
                      pointerEvents="none"
                      style={[StyleSheet.absoluteFill, { backgroundColor: f.color, opacity: f.opacity }]}
                    />
                  );
                })()
              : null}

            {/* blur boxes (hide sensitive areas) */}
            {blurs.map((b) => (
              <DraggableItem
                key={b.id}
                item={b}
                selected={selectedId === b.id}
                disabled={tool === 'draw' || inCrop}
                onSelect={() => setSelectedId(b.id)}
                onDelete={() => deleteItem(b.id)}
                onChange={(u) => setBlurs((prev) => prev.map((p) => (p.id === b.id ? { ...p, ...u } : p)))}
              >
                <BlurView
                  intensity={70}
                  tint="default"
                  experimentalBlurMethod="dimezisBlurView"
                  style={styles.blurBox}
                />
              </DraggableItem>
            ))}

            {/* strokes */}
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              {strokes.map((s, i) => (
                <Path
                  key={i}
                  d={s.d}
                  stroke={s.color}
                  strokeWidth={s.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ))}
              {currentPath ? (
                <Path
                  d={currentPath}
                  stroke={color}
                  strokeWidth={brush}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ) : null}
            </Svg>

            {/* text overlays */}
            {texts.map((t) => (
              <DraggableItem
                key={t.id}
                item={t}
                selected={selectedId === t.id}
                disabled={tool === 'draw' || inCrop}
                onSelect={() => setSelectedId(t.id)}
                onDelete={() => deleteItem(t.id)}
                onChange={(u) => setTexts((prev) => prev.map((p) => (p.id === t.id ? { ...p, ...u } : p)))}
                onDoubleTap={() => openEditText(t)}
              >
                <Text style={{ color: t.color, fontSize: t.fontSize, fontWeight: '700' }}>{t.text}</Text>
              </DraggableItem>
            ))}

            {/* sticker overlays */}
            {stickers.map((s) => (
              <DraggableItem
                key={s.id}
                item={s}
                selected={selectedId === s.id}
                disabled={tool === 'draw' || inCrop}
                onSelect={() => setSelectedId(s.id)}
                onDelete={() => deleteItem(s.id)}
                onChange={(u) => setStickers((prev) => prev.map((p) => (p.id === s.id ? { ...p, ...u } : p)))}
              >
                <Text style={{ fontSize: s.fontSize }}>{s.emoji}</Text>
              </DraggableItem>
            ))}

            {/* draw capture layer */}
            {tool === 'draw' ? (
              <View style={StyleSheet.absoluteFill} {...drawResponder.panHandlers} testID="pe-draw-layer" />
            ) : null}

            {/* crop overlay */}
            {inCrop ? <CropOverlay cw={cw} ch={ch} crop={crop} setCrop={setCrop} /> : null}
          </View>
        </View>

        {/* Toolbar */}
        <View style={[styles.toolbar, { paddingBottom: insets.bottom + 8 }]}>
          {/* contextual controls */}
          {tool === 'draw' || tool === 'text' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowPad}>
              {PALETTE.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => {
                    setColor(c);
                    if (tool === 'draw') setEraser(false);
                  }}
                  style={[styles.swatch, { backgroundColor: c }, color === c && !eraser && styles.swatchSel]}
                />
              ))}
              <View style={styles.sizeGroup}>
                {(tool === 'draw' ? BRUSHES : TEXT_SIZES).map((sz) => {
                  const sel = tool === 'draw' ? brush === sz : textSize === sz;
                  return (
                    <TouchableOpacity
                      key={sz}
                      onPress={() => (tool === 'draw' ? setBrush(sz) : setTextSize(sz))}
                      style={[styles.sizeBtn, sel && styles.sizeBtnSel]}
                    >
                      <View style={{ width: sz, height: sz, borderRadius: sz / 2, backgroundColor: '#fff' }} />
                    </TouchableOpacity>
                  );
                })}
                {tool === 'draw' ? (
                  <TouchableOpacity
                    onPress={() => setEraser((v) => !v)}
                    style={[styles.sizeBtn, styles.eraserBtn, eraser && styles.sizeBtnSel]}
                    testID="pe-eraser"
                  >
                    <Ionicons name="backspace-outline" size={20} color="#fff" />
                  </TouchableOpacity>
                ) : null}
                {tool === 'text' ? (
                  <TouchableOpacity onPress={addText} style={styles.addTextBtn}>
                    <Text style={styles.addTextLabel}>+ Add text</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </ScrollView>
          ) : null}

          {tool === 'sticker' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowPad}>
              {EMOJIS.map((e) => (
                <TouchableOpacity key={e} onPress={() => addSticker(e)} style={styles.emojiBtn}>
                  <Text style={{ fontSize: 28 }}>{e}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}

          {tool === 'filter' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowPad}>
              {FILTERS.map((f) => (
                <TouchableOpacity
                  key={f.key}
                  onPress={() => setFilter(f.key)}
                  style={[styles.filterChip, filter === f.key && styles.filterChipSel]}
                >
                  <View
                    style={[
                      styles.filterSwatch,
                      { backgroundColor: f.color === 'transparent' ? '#666' : f.color },
                    ]}
                  />
                  <Text style={[styles.filterLabel, filter === f.key && { color: '#0A84FF' }]}>{f.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}

          {tool === 'blur' ? (
            <View style={styles.rowPad}>
              <TouchableOpacity onPress={addBlur} style={styles.applyBtn}>
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.applyText}>Add blur area</Text>
              </TouchableOpacity>
              <Text style={styles.blurHint}>Drag to move · pinch to resize · tap to delete</Text>
            </View>
          ) : null}

          {tool === 'adjust' ? (
            <View style={styles.adjustPanel}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
                {ADJUST_PRESETS.map((p) => {
                  const sel =
                    adjust.grayscale === p.params.grayscale &&
                    adjust.contrast === p.params.contrast &&
                    adjust.saturation === p.params.saturation;
                  return (
                    <TouchableOpacity
                      key={p.key}
                      onPress={() => setAdjust(p.params)}
                      style={[styles.presetChip, sel && styles.presetChipSel]}
                      testID={`pe-adjust-preset-${p.key}`}
                    >
                      <Text style={[styles.presetLabel, sel && { color: '#0A84FF' }]}>{p.label}</Text>
                    </TouchableOpacity>
                  );
                })}
                {customLook ? (
                  (() => {
                    const sel =
                      adjust.grayscale === customLook.grayscale &&
                      adjust.contrast === customLook.contrast &&
                      adjust.saturation === customLook.saturation;
                    return (
                      <TouchableOpacity
                        onPress={() => setAdjust(customLook)}
                        style={[styles.presetChip, sel && styles.presetChipSel]}
                        testID="pe-adjust-preset-mylook"
                      >
                        <Ionicons name="bookmark" size={12} color={sel ? '#0A84FF' : '#FFCC00'} />
                        <Text style={[styles.presetLabel, sel && { color: '#0A84FF' }, { marginLeft: 4 }]}>My look</Text>
                      </TouchableOpacity>
                    );
                  })()
                ) : null}
                <TouchableOpacity onPress={saveCustomLook} style={[styles.presetChip, styles.presetSaveChip]} testID="pe-adjust-save-look">
                  <Ionicons name="bookmark-outline" size={12} color="#fff" />
                  <Text style={[styles.presetLabel, { marginLeft: 4 }]}>{customLook ? 'Update look' : 'Save look'}</Text>
                </TouchableOpacity>
              </ScrollView>
              <AdjustSlider
                label="Grayscale"
                value={adjust.grayscale}
                min={0}
                max={1}
                display={`${Math.round(adjust.grayscale * 100)}%`}
                onChange={(v) => setAdjust((a) => ({ ...a, grayscale: v }))}
              />
              <AdjustSlider
                label="Contrast"
                value={adjust.contrast}
                min={0.5}
                max={1.5}
                display={`${Math.round(adjust.contrast * 100)}%`}
                onChange={(v) => setAdjust((a) => ({ ...a, contrast: v }))}
              />
              <AdjustSlider
                label="Saturation"
                value={adjust.saturation}
                min={0}
                max={2}
                display={`${Math.round(adjust.saturation * 100)}%`}
                onChange={(v) => setAdjust((a) => ({ ...a, saturation: v }))}
              />
              <View style={styles.adjustRow}>
                <TouchableOpacity onPress={applyAdjust} style={styles.applyBtn} disabled={busy} testID="pe-adjust-apply">
                  <Ionicons name="checkmark" size={18} color="#fff" />
                  <Text style={styles.applyText}>Apply</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setAdjust(ADJUST_DEFAULT)} style={styles.resetBtn} testID="pe-adjust-reset">
                  <Text style={styles.resetText}>Reset</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {inCrop ? (
            <View style={styles.rowPad}>
              <TouchableOpacity onPress={applyCrop} style={styles.applyBtn} disabled={busy}>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={styles.applyText}>Apply crop</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setCrop({ x: 0, y: 0, w: cw, h: ch })} style={styles.resetBtn}>
                <Text style={styles.resetText}>Reset</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* main tool row */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tools}
          >
            <ToolBtn icon="brush" label="Draw" active={tool === 'draw'} onPress={() => setTool(tool === 'draw' ? null : 'draw')} />
            <ToolBtn icon="text" label="Text" active={tool === 'text'} onPress={() => setTool(tool === 'text' ? null : 'text')} />
            <ToolBtn icon="happy-outline" label="Sticker" active={tool === 'sticker'} onPress={() => setTool(tool === 'sticker' ? null : 'sticker')} />
            <ToolBtn icon="color-filter" label="Filter" active={tool === 'filter'} onPress={() => setTool(tool === 'filter' ? null : 'filter')} />
            <ToolBtn icon="options" label="Adjust" active={tool === 'adjust'} onPress={() => setTool(tool === 'adjust' ? null : 'adjust')} />
            <ToolBtn icon="sparkles" label="Enhance" active={false} onPress={applyEnhance} />
            <ToolBtn icon="eye-off" label="Blur" active={tool === 'blur'} onPress={() => setTool(tool === 'blur' ? null : 'blur')} />
            <ToolBtn icon="crop" label="Crop" active={inCrop} onPress={() => setTool(inCrop ? null : 'crop')} />
            <ToolBtn icon="refresh" label="Rotate" active={false} onPress={applyRotate} />
            <ToolBtn icon="arrow-undo" label="Undo" active={false} onPress={undo} />
          </ScrollView>
        </View>

        {/* text entry modal */}
        <Modal visible={textModal} transparent animationType="fade" onRequestClose={() => setTextModal(false)}>
          <View style={styles.textModalBg}>
            <View style={styles.textModalCard}>
              <TextInput
                value={textDraft}
                onChangeText={setTextDraft}
                placeholder="Type text…"
                placeholderTextColor="#888"
                style={styles.textInput}
                autoFocus
                multiline
              />
              <View style={styles.textModalRow}>
                <TouchableOpacity onPress={() => setTextModal(false)}>
                  <Text style={styles.textModalCancel}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={commitText}>
                  <Text style={styles.textModalAdd}>Add</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

function ToolBtn({
  icon,
  label,
  active,
  onPress,
}: {
  icon: any;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.toolBtn} onPress={onPress} testID={`pe-tool-${label.toLowerCase()}`}>
      <Ionicons name={icon} size={24} color={active ? '#0A84FF' : '#fff'} />
      <Text style={[styles.toolLabel, active && { color: '#0A84FF' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function AdjustSlider({
  label,
  value,
  min,
  max,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.adjustSliderRow}>
      <Text style={styles.adjustLabel}>{label}</Text>
      <Slider
        style={styles.adjustSlider}
        minimumValue={min}
        maximumValue={max}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor="#0A84FF"
        maximumTrackTintColor="#444"
        thumbTintColor="#fff"
      />
      <Text style={styles.adjustValue}>{display}</Text>
    </View>
  );
}

interface DraggableItemProps {
  item: { x: number; y: number; scale: number; rotation: number };
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onChange: (u: { x: number; y: number; scale: number; rotation: number }) => void;
  onDoubleTap?: () => void;
  children: React.ReactNode;
}

/**
 * Draggable / pinch-to-resize / rotatable overlay used for text, emoji and blur
 * boxes. Transform lives in reanimated shared values (smooth on the UI thread)
 * and is synced back to parent state on each gesture end so it survives
 * re-renders and is captured correctly by view-shot.
 */
function DraggableItem({ item, selected, disabled, onSelect, onDelete, onChange, onDoubleTap, children }: DraggableItemProps) {
  const tx = useSharedValue(item.x);
  const ty = useSharedValue(item.y);
  const sc = useSharedValue(item.scale ?? 1);
  const rot = useSharedValue(item.rotation ?? 0);
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);
  const ss = useSharedValue(1);
  const sr = useSharedValue(0);

  const commit = useCallback(() => {
    onChange({ x: tx.value, y: ty.value, scale: sc.value, rotation: rot.value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange]);

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .onStart(() => {
      sx.value = tx.value;
      sy.value = ty.value;
    })
    .onUpdate((e) => {
      tx.value = sx.value + e.translationX;
      ty.value = sy.value + e.translationY;
    })
    .onEnd(() => runOnJS(commit)());

  const pinch = Gesture.Pinch()
    .enabled(!disabled)
    .onStart(() => {
      ss.value = sc.value;
    })
    .onUpdate((e) => {
      sc.value = Math.max(0.3, Math.min(8, ss.value * e.scale));
    })
    .onEnd(() => runOnJS(commit)());

  const rotation = Gesture.Rotation()
    .enabled(!disabled)
    .onStart(() => {
      sr.value = rot.value;
    })
    .onUpdate((e) => {
      rot.value = sr.value + e.rotation;
    })
    .onEnd(() => runOnJS(commit)());

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd(() => runOnJS(onSelect)());

  const doubleTap = Gesture.Tap()
    .enabled(!disabled && !!onDoubleTap)
    .numberOfTaps(2)
    .onEnd(() => {
      if (onDoubleTap) runOnJS(onDoubleTap)();
    });

  const gesture = Gesture.Simultaneous(pan, pinch, rotation, Gesture.Exclusive(doubleTap, tap));

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: sc.value },
      { rotateZ: `${rot.value}rad` },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.overlay, style, selected && styles.overlaySel]}>
        {children}
        {selected && !disabled ? (
          <TouchableOpacity onPress={onDelete} style={styles.overlayDelete} hitSlop={8}>
            <Ionicons name="close" size={12} color="#fff" />
          </TouchableOpacity>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

/** Movable + corner-resizable crop rectangle with a dimmed surround. */
function CropOverlay({
  cw,
  ch,
  crop,
  setCrop,
}: {
  cw: number;
  ch: number;
  crop: { x: number; y: number; w: number; h: number };
  setCrop: (c: { x: number; y: number; w: number; h: number }) => void;
}) {
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const MIN = 48;

  const moveResp = useMemo(() => {
    let s = { x: 0, y: 0 };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        s = { x: cropRef.current.x, y: cropRef.current.y };
      },
      onPanResponderMove: (_e, g) => {
        const c = cropRef.current;
        const nx = Math.min(Math.max(0, s.x + g.dx), cw - c.w);
        const ny = Math.min(Math.max(0, s.y + g.dy), ch - c.h);
        setCrop({ ...c, x: nx, y: ny });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cw, ch]);

  const cornerResp = (corner: 'tl' | 'tr' | 'bl' | 'br') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        (cornerResp as any)._s = { ...cropRef.current };
      },
      onPanResponderMove: (_e, g) => {
        const s = (cornerResp as any)._s || cropRef.current;
        let { x, y, w, h } = s;
        if (corner === 'tl') {
          x = Math.min(s.x + g.dx, s.x + s.w - MIN);
          y = Math.min(s.y + g.dy, s.y + s.h - MIN);
          x = Math.max(0, x);
          y = Math.max(0, y);
          w = s.x + s.w - x;
          h = s.y + s.h - y;
        } else if (corner === 'tr') {
          y = Math.max(0, Math.min(s.y + g.dy, s.y + s.h - MIN));
          w = Math.min(cw - s.x, Math.max(MIN, s.w + g.dx));
          h = s.y + s.h - y;
        } else if (corner === 'bl') {
          x = Math.max(0, Math.min(s.x + g.dx, s.x + s.w - MIN));
          w = s.x + s.w - x;
          h = Math.min(ch - s.y, Math.max(MIN, s.h + g.dy));
        } else {
          w = Math.min(cw - s.x, Math.max(MIN, s.w + g.dx));
          h = Math.min(ch - s.y, Math.max(MIN, s.h + g.dy));
        }
        setCrop({ x, y, w, h });
      },
    });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* dim surrounds */}
      <View style={[styles.dim, { left: 0, top: 0, width: cw, height: crop.y }]} pointerEvents="none" />
      <View style={[styles.dim, { left: 0, top: crop.y + crop.h, width: cw, height: ch - crop.y - crop.h }]} pointerEvents="none" />
      <View style={[styles.dim, { left: 0, top: crop.y, width: crop.x, height: crop.h }]} pointerEvents="none" />
      <View style={[styles.dim, { left: crop.x + crop.w, top: crop.y, width: cw - crop.x - crop.w, height: crop.h }]} pointerEvents="none" />
      {/* crop box */}
      <View
        {...moveResp.panHandlers}
        style={[styles.cropBox, { left: crop.x, top: crop.y, width: crop.w, height: crop.h }]}
      >
        <View {...cornerResp('tl').panHandlers} style={[styles.corner, styles.tl]} />
        <View {...cornerResp('tr').panHandlers} style={[styles.corner, styles.tr]} />
        <View {...cornerResp('bl').panHandlers} style={[styles.corner, styles.bl]} />
        <View {...cornerResp('br').panHandlers} style={[styles.corner, styles.br]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  headerBtn: { minWidth: 60, height: 40, justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  doneText: { color: '#0A84FF', fontSize: 17, fontWeight: '700', textAlign: 'right' },
  area: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  overlay: { position: 'absolute', left: 0, top: 0, padding: 4 },
  overlaySel: { borderWidth: 1, borderColor: '#0A84FF', borderStyle: 'dashed' },
  overlayDelete: {
    position: 'absolute',
    top: -10,
    right: -10,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
  },
  blurBox: { width: 140, height: 90, borderRadius: 8, overflow: 'hidden' },
  filterChip: { alignItems: 'center', marginRight: 14, paddingVertical: 4 },
  filterChipSel: {},
  filterSwatch: { width: 44, height: 44, borderRadius: 8, marginBottom: 4, borderWidth: 2, borderColor: '#333' },
  filterLabel: { color: '#fff', fontSize: 12 },
  blurHint: { color: '#888', fontSize: 11, flex: 1, marginLeft: 10 },
  toolbar: { backgroundColor: '#111', paddingTop: 8 },
  rowPad: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  swatch: { width: 30, height: 30, borderRadius: 15, marginRight: 8, borderWidth: 2, borderColor: 'transparent' },
  swatchSel: { borderColor: '#fff', transform: [{ scale: 1.15 }] },
  sizeGroup: { flexDirection: 'row', alignItems: 'center', marginLeft: 8, gap: 8 },
  sizeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#222',
  },
  sizeBtnSel: { backgroundColor: '#0A84FF' },
  eraserBtn: { backgroundColor: '#333' },
  addTextBtn: { paddingHorizontal: 14, height: 40, borderRadius: 20, backgroundColor: '#0A84FF', justifyContent: 'center' },
  addTextLabel: { color: '#fff', fontWeight: '700' },
  emojiBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tools: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 8,
    paddingHorizontal: 6,
  },
  toolBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 6, minWidth: 48 },
  toolLabel: { color: '#fff', fontSize: 11, marginTop: 2 },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#34C759',
    paddingHorizontal: 16,
    height: 40,
    borderRadius: 20,
  },
  applyText: { color: '#fff', fontWeight: '700' },
  resetBtn: { paddingHorizontal: 16, height: 40, borderRadius: 20, backgroundColor: '#333', justifyContent: 'center' },
  resetText: { color: '#fff', fontWeight: '600' },
  adjustPanel: { paddingHorizontal: 14, paddingTop: 4, paddingBottom: 4 },
  presetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 },
  presetChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 30, borderRadius: 15, backgroundColor: '#222', justifyContent: 'center' },
  presetChipSel: { backgroundColor: 'rgba(10,132,255,0.2)', borderWidth: 1, borderColor: '#0A84FF' },
  presetSaveChip: { backgroundColor: '#0A84FF' },
  presetLabel: { color: '#fff', fontSize: 12, fontWeight: '600' },
  adjustSliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  adjustLabel: { color: '#fff', fontSize: 13, width: 78 },
  adjustSlider: { flex: 1, height: 34 },
  adjustValue: { color: '#8e8e93', fontSize: 12, width: 44, textAlign: 'right' },
  adjustRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  textModalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  textModalCard: { backgroundColor: '#1c1c1e', borderRadius: 16, padding: 16 },
  textInput: { color: '#fff', fontSize: 20, minHeight: 60, textAlignVertical: 'top' },
  textModalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  textModalCancel: { color: '#888', fontSize: 16, fontWeight: '600' },
  textModalAdd: { color: '#0A84FF', fontSize: 16, fontWeight: '700' },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.5)' },
  cropBox: { position: 'absolute', borderWidth: 2, borderColor: '#fff' },
  corner: { position: 'absolute', width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tl: { left: -22, top: -22, borderTopWidth: 4, borderLeftWidth: 4, borderColor: '#fff' },
  tr: { right: -22, top: -22, borderTopWidth: 4, borderRightWidth: 4, borderColor: '#fff' },
  bl: { left: -22, bottom: -22, borderBottomWidth: 4, borderLeftWidth: 4, borderColor: '#fff' },
  br: { right: -22, bottom: -22, borderBottomWidth: 4, borderRightWidth: 4, borderColor: '#fff' },
});
