import React, { useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useConvex, useMutation } from 'convex/react';
import * as ImagePicker from 'expo-image-picker';
import { pickImageLibrary } from '../../src/lib/nativePickers';
import Header from '../../src/components/Header';
import CountrySelectorModal from '../../src/components/CountrySelectorModal';
import ZoomableImage from '../../src/components/ZoomableImage';
import { useSafeConvexQuery } from '../../src/hooks/useSafeConvexQuery';
import { api } from '../../src/convexApi';
import { uploadFile } from '../../src/lib/uploadFile';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '../../src/theme';

export default function CreateAdScreen() {
  const router = useRouter();
  const convex = useConvex();
  const createAd = useMutation(api.ads.create);
  const { data: me } = useSafeConvexQuery<any | null>(api.users.getCurrentUser, {}, null);
  const [submitting, setSubmitting] = useState(false);
  const [showCountryModal, setShowCountryModal] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [location, setLocation] = useState('');
  const [productName, setProductName] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [description, setDescription] = useState('');
  const [externalLink, setExternalLink] = useState('');
  const [targetCountries, setTargetCountries] = useState<string[]>([]);
  const [imageAsset, setImageAsset] = useState<{ uri: string; mimeType?: string; fileSize?: number } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const targetSummary = useMemo(() => {
    if (!targetCountries.length) return 'Worldwide';
    const visible = targetCountries.slice(0, 3);
    const hidden = targetCountries.length - visible.length;
    return `${visible.join(', ')}${hidden > 0 ? ` +${hidden} more` : ''}`;
  }, [targetCountries]);

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo access to attach a product image.');
      return;
    }
    const result = await pickImageLibrary({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
      exif: false,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    const asset = result.assets[0];
    if (asset.fileSize && asset.fileSize > 10 * 1024 * 1024) {
      Alert.alert('Image too large', 'Please choose an image under 10 MB.');
      return;
    }
    setImageAsset({ uri: asset.uri, mimeType: asset.mimeType, fileSize: asset.fileSize });
  };

  const normalizeUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  };

  const onSubmit = async () => {
    const payload = {
      businessName: businessName.trim(),
      location: location.trim(),
      productName: productName.trim(),
      contactInfo: contactInfo.trim() || undefined,
      description: description.trim(),
      externalLink: normalizeUrl(externalLink),
      targetCountries,
    };

    if (!payload.businessName || !payload.location || !payload.productName || !payload.description || !payload.externalLink) {
      Alert.alert('Missing details', 'Please complete all required fields.');
      return;
    }

    if (!me) {
      Alert.alert('Sign in required', 'Please sign in before posting an ad.');
      return;
    }

    setSubmitting(true);
    try {
      let imageStorageId: string | undefined;
      if (imageAsset?.uri) {
        imageStorageId = await uploadFile(convex, imageAsset.uri, imageAsset.mimeType || 'image/jpeg', api.ads.generateUploadUrl);
      }
      await createAd({ ...payload, ...(imageStorageId ? { imageStorageId } : {}) });
      Alert.alert('Ad submitted', 'Your ad has been sent for review.');
      router.back();
    } catch (errorValue: any) {
      Alert.alert('Could not submit ad', errorValue?.message || 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']} testID="create-ad-screen">
      <Header title="Create Ad" showBack onBack={() => router.back()} variant="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Field label="Business Name*" value={businessName} onChangeText={setBusinessName} testID="ad-business-name" />
        <Field label="Business Location*" value={location} onChangeText={setLocation} testID="ad-business-location" />
        <Field label="Product Name*" value={productName} onChangeText={setProductName} testID="ad-product-name" />
        <Field label="Contact Info" value={contactInfo} onChangeText={setContactInfo} testID="ad-contact-info" />
        <Field label="Product Description*" value={description} onChangeText={setDescription} multiline testID="ad-description" />
        <Field label="Link to Your Page*" value={externalLink} onChangeText={setExternalLink} autoCapitalize="none" keyboardType="url" testID="ad-link" />

        <View style={styles.section}>
          <Text style={styles.label}>Product Image (optional)</Text>
          {imageAsset?.uri ? (
            <TouchableOpacity activeOpacity={0.85} onPress={() => setPreviewOpen(true)} testID="ad-image-preview">
              <Image source={{ uri: imageAsset.uri }} style={styles.previewImage} resizeMode="cover" />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.uploadZone} onPress={pickImage} activeOpacity={0.7} testID="ad-pick-image">
            <Feather name="upload" size={28} color={Colors.textMuted} />
            <Text style={styles.uploadZoneText}>{imageAsset ? 'Change image' : 'Tap to upload image'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Preferred Locations</Text>
          <Text style={styles.helperText}>
            Select countries where your ad should appear. Leave empty for worldwide visibility.
          </Text>
          <TouchableOpacity style={styles.selectorBtn} onPress={() => setShowCountryModal(true)} testID="ad-country-picker">
            <Feather name="map-pin" size={18} color={Colors.primary} />
            <Text style={styles.selectorText}>{targetSummary}</Text>
            <View style={styles.flexOne} />
            <Feather name="chevron-right" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.banner} testID="create-ad-info-banner">
          <Text style={styles.bannerText}>
            Your ad will be reviewed by our team before it goes live. This may take up to 24 hours. Businesses are charged 0.06 per click.
          </Text>
          {!me ? (
            <Text style={styles.authNotice} testID="create-ad-auth-notice">
              Sign in is required before submitting an ad.
            </Text>
          ) : null}
        </View>

        <TouchableOpacity style={[styles.submitBtn, (!me || submitting) && styles.submitBtnDisabled]} onPress={onSubmit} disabled={!me || submitting} testID="ad-submit-button">
          <Text style={styles.submitText}>{!me ? 'Sign in to submit' : submitting ? 'Submitting…' : 'Submit Ad for Review'}</Text>
        </TouchableOpacity>
      </ScrollView>

      <CountrySelectorModal
        selected={targetCountries}
        title="Preferred locations"
        visible={showCountryModal}
        onApply={setTargetCountries}
        onClose={() => setShowCountryModal(false)}
      />

      <Modal visible={previewOpen} transparent animationType="fade" onRequestClose={() => setPreviewOpen(false)}>
        <View style={styles.previewViewerBackdrop}>
          {imageAsset?.uri ? (
            <ZoomableImage uri={imageAsset.uri} onClose={() => setPreviewOpen(false)} />
          ) : null}
          <TouchableOpacity
            style={styles.previewViewerClose}
            onPress={() => setPreviewOpen(false)}
            hitSlop={12}
            testID="ad-image-preview-close"
          >
            <Feather name="x" size={26} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Field(props: any) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        multiline={props.multiline}
        autoCapitalize={props.autoCapitalize}
        keyboardType={props.keyboardType}
        style={[styles.input, props.multiline ? styles.inputMultiline : null]}
        testID={props.testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.base, paddingBottom: Spacing.xxl },
  banner: { backgroundColor: Colors.primaryLight, borderRadius: Radius.lg, padding: Spacing.base },
  bannerText: { fontSize: FontSize.sm, color: Colors.textPrimary, lineHeight: 20 },
  authNotice: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 8, fontWeight: FontWeight.medium },
  section: { marginTop: Spacing.lg },
  label: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: Colors.textPrimary, marginBottom: 8 },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.base,
    paddingVertical: 12,
    fontSize: FontSize.base,
    color: Colors.textPrimary,
  },
  inputMultiline: { minHeight: 120, textAlignVertical: 'top' },
  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: Spacing.base,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  selectorText: { fontSize: FontSize.base, color: Colors.textPrimary },
  helperText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
    marginBottom: Spacing.sm,
    marginTop: -2,
  },
  uploadZone: {
    minHeight: 160,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: Spacing.lg,
  },
  uploadZoneText: {
    fontSize: FontSize.base,
    color: Colors.textSecondary,
    fontWeight: FontWeight.medium,
  },
  flexOne: { flex: 1 },
  previewImage: { width: '100%', height: 200, borderRadius: Radius.lg, marginBottom: Spacing.sm },
  previewViewerBackdrop: { flex: 1, backgroundColor: '#000' },
  previewViewerClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  submitBtn: {
    minHeight: 48,
    marginTop: Spacing.xl,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: { opacity: 0.7 },
  submitText: { fontSize: FontSize.base, color: Colors.white, fontWeight: FontWeight.bold },
});