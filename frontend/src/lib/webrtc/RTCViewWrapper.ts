// Native-only RTCView wrapper. Metro picks this file on iOS/Android.
// Web has a sibling file `RTCViewWrapper.web.ts` returning a null stub.
import { RTCView } from 'react-native-webrtc';

export default RTCView;
