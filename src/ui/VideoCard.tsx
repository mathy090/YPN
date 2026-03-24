import React from "react";
import { Dimensions, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

const { height, width } = Dimensions.get("window");

const VideoCard = ({ video, isActive }: any) => {
  return (
    <View style={styles.container}>
      <WebView
        source={{
          uri: `https://www.youtube.com/embed/${video.videoId}?autoplay=${
            isActive ? 1 : 0
          }&mute=1&controls=0&playsinline=1`,
        }}
        style={styles.video}
      />

      {/* Overlay UI */}
      <View style={styles.overlay}>
        <Text style={styles.title}>{video.title}</Text>
        <Text style={styles.channel}>{video.channelTitle}</Text>
      </View>
    </View>
  );
};

export default VideoCard;

const styles = StyleSheet.create({
  container: {
    height,
    width,
    backgroundColor: "#000",
  },
  video: {
    flex: 1,
  },
  overlay: {
    position: "absolute",
    bottom: 100,
    left: 12,
    right: 80,
  },
  title: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  channel: {
    color: "#ccc",
    fontSize: 13,
    marginTop: 4,
  },
});
