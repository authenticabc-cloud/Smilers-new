/**
 * LatexView — render a LaTeX expression using KaTeX inside a WebView.
 * KaTeX is loaded from CDN (the Study AI call needs network anyway). The
 * page auto-reports its rendered height so the WebView sizes itself.
 * Pass the raw LaTeX WITHOUT surrounding `$` (per the Study AI contract).
 */
import React, { useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Colors } from '../../theme';

function buildHtml(latex: string, color: string, size: number): string {
  const escaped = (latex || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<style>
  html,body{margin:0;padding:0;background:transparent;}
  #k{padding:2px 0;color:${color};font-size:${size}px;overflow-x:auto;}
</style></head>
<body><span id="k"></span>
<script>
  function report(){
    var h=document.body.scrollHeight;
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(String(h));
  }
  try{
    katex.render(\`${escaped}\`, document.getElementById('k'),
      {throwOnError:false, displayMode:true});
  }catch(e){ document.getElementById('k').textContent=\`${escaped}\`; }
  window.onload=report; setTimeout(report,120); setTimeout(report,400);
</script></body></html>`;
}

export function LatexView({
  latex,
  color = Colors.textPrimary,
  size = 18,
}: {
  latex: string;
  color?: string;
  size?: number;
}) {
  const [height, setHeight] = useState(40);
  const html = useMemo(() => buildHtml(latex, color, size), [latex, color, size]);
  if (!latex || !latex.trim()) return null;

  // On web, react-native-webview isn't reliable — show the raw expression.
  if (Platform.OS === 'web') {
    return <View style={styles.webFallback} />;
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        style={styles.web}
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        onMessage={(e) => {
          const h = Number(e.nativeEvent.data);
          if (h && h > 0 && Math.abs(h - height) > 2) setHeight(Math.ceil(h) + 4);
        }}
        androidLayerType="software"
        backgroundColor="transparent"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', backgroundColor: 'transparent' },
  web: { flex: 1, backgroundColor: 'transparent' },
  webFallback: { height: 0 },
});
