import React from 'react';
import ComingSoon from '../src/components/ComingSoon';

export default function FaceIdScreen() {
  return (
    <ComingSoon
      title="Face ID"
      description="Verify your identity on new devices using face recognition. We'll roll this out shortly."
      icon="face-recognition"
      iconLib="mc"
    />
  );
}