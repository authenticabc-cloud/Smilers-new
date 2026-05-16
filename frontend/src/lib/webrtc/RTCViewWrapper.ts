// Native-only RTCView wrapper. Metro picks this file on iOS/Android.
// Web has a sibling file `RTCViewWrapper.web.ts` returning a null stub.
import React from 'react';
import { View } from 'react-native';

let CachedRTCView: any = null;

function getRTCView() {
  if (!CachedRTCView) {
    CachedRTCView = require('react-native-webrtc').RTCView;
  }
  return CachedRTCView;
}

export default function RTCViewWrapper(props: any) {
  const RTCView = getRTCView();
  if (!RTCView) {
    return React.createElement(View, props);
  }
  return React.createElement(RTCView, props);
}
