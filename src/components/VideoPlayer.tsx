// src/components/VideoPlayer.tsx
// Kept in its own file so Metro only registers RNCWebView once.
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
    Platform,
    StatusBar as RNStatusBar,
    StyleSheet,
    TouchableOpacity,
    View,
} from "react-native";
import { WebView } from "react-native-webview";

const STATUS_BAR_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

type Props = { videoId: string; onClose: () => void };

export default function VideoPlayer({ videoId, onClose }: Props) {
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <style>
      *{margin:0;padding:0;box-sizing:border-box;background:#000}
      html,body{width:100%;height:100%;overflow:hidden}
      iframe{width:100%;height:100%;border:none;display:block}
    </style>
  </head>
  <body>
    <iframe
      src="https://www.youtube.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1&fs=1"
      allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;fullscreen"
      allowfullscreen
    ></iframe>
  </body>
</html>`;

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        source={{ html }}
        style={{ flex: 1, backgroundColor: "#000" }}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={["*"]}
      />
      <TouchableOpacity style={s.close} onPress={onClose} activeOpacity={0.8}>
        <Ionicons name="close" size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  close: {
    position: "absolute",
    top: STATUS_BAR_H + 12,
    right: 14,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.65)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
});
