// src/screens/ArticlePreview.tsx
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

type RouteParams = {
  url: string;
  title?: string;
  source?: string;
  sourceColor?: string;
};

export default function ArticlePreviewScreen() {
  const params = useLocalSearchParams<RouteParams>();
  const router = useRouter();

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [articleTitle, setArticleTitle] = useState(
    params.title ? decodeURIComponent(params.title) : "Article",
  );

  // Animation for Chrome-like progress bar
  const progressAnim = useRef(new Animated.Value(0)).current;
  const [progressVisible, setProgressVisible] = useState(false);

  const articleUrl = params.url ? decodeURIComponent(params.url) : null;
  const sourceColor = params.sourceColor || "#1DB954";
  const webViewRef = useRef<WebView>(null);

  // Handle Progress (Chrome-like animation)
  const handleProgress = ({ nativeEvent }: any) => {
    const { progress } = nativeEvent;
    setProgressVisible(progress < 1);

    Animated.spring(progressAnim, {
      toValue: progress,
      useNativeDriver: false,
      tension: 50,
      friction: 5,
    }).start();

    if (progress === 1) {
      setLoading(false);
      setTimeout(() => setProgressVisible(false), 300);
    }
  };

  const handleLoadStart = () => {
    setLoading(true);
    setError(null);
    progressAnim.setValue(0);
    setProgressVisible(true);
  };

  const handleLoadEnd = () => {
    setLoading(false);
  };

  const handleError = () => {
    setLoading(false);
    setProgressVisible(false);
    setError("Failed to load article. Check your connection.");
  };

  // Inject JS to grab real title from page if available
  const INJECTED_JAVASCRIPT = `(function() {
    window.onload = function() {
      const title = document.title;
      if (title && title !== "") {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'TITLE', value: title }));
      }
    };
    // Observe changes
    const observer = new MutationObserver(() => {
      const title = document.title;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'TITLE', value: title }));
    });
    observer.observe(document.querySelector('title'), { childList: true });
  })();`;

  const handleMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "TITLE" && data.value) {
        setArticleTitle(data.value);
      }
    } catch (e) {}
  };

  const handleRefresh = () => {
    webViewRef.current?.reload();
  };

  if (!articleUrl) {
    return (
      <View style={s.center}>
        <Ionicons name="alert-circle-outline" size={48} color="#FF453A" />
        <Text style={s.errorText}>No article URL</Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => router.back()}>
          <Text style={s.retryText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: sourceColor + "40" }]}>
        <TouchableOpacity
          style={s.backButton}
          onPress={() => router.back()}
          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        <View style={s.titleContainer}>
          <Text style={s.title} numberOfLines={1}>
            {articleTitle}
          </Text>
          {params.source && (
            <Text style={s.source} numberOfLines={1}>
              {params.source}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={s.refreshButton}
          onPress={handleRefresh}
          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        >
          <Ionicons
            name="refresh"
            size={22}
            color={loading ? sourceColor : "#888"}
          />
        </TouchableOpacity>
      </View>

      {/* Chrome-like Progress Bar */}
      {progressVisible && (
        <View style={s.progressContainer}>
          <Animated.View
            style={[
              s.progressBar,
              {
                width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0%", "100%"],
                }),
                backgroundColor: sourceColor,
              },
            ]}
          />
        </View>
      )}

      {/* Error Overlay */}
      {error && (
        <View style={s.errorOverlay}>
          <Ionicons name="wifi-outline" size={48} color="#666" />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity
            style={[s.errorBtn, { backgroundColor: sourceColor }]}
            onPress={handleRefresh}
          >
            <Text style={s.errorBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* WebView */}
      <WebView
        ref={webViewRef}
        source={{ uri: articleUrl }}
        style={s.webview}
        // ✅ Android Specific: Fit to Screen
        scalesPageToFit={Platform.OS === "android"}
        useWebView2={true} // Uses modern Android WebView engine
        androidHardwareAccelerationDisabled={false}
        // ✅ Viewport & Zoom
        startInLoadingState={true}
        domStorageEnabled={true}
        javaScriptEnabled={true}
        thirdPartyCookiesEnabled={true}
        sharedCookiesEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        // ✅ Events
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onProgress={handleProgress}
        onError={handleError}
        onMessage={handleMessage}
        // ✅ Pull to Refresh
        pullToRefreshEnabled={true}
        onRefresh={handleRefresh}
        // ✅ Cache & Performance
        cacheEnabled={true}
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        mixedContentMode="always"
        // ✅ User Agent (Mobile View)
        applicationNameForUserAgent="Chrome/120.0.0.0 Mobile Safari/537.36"
        // ✅ Appearance
        backgroundColor="#000"
        renderLoading={() => (
          <View style={s.webviewLoading}>
            <ActivityIndicator color={sourceColor} size="large" />
            <Text style={s.loadingText}>Loading article...</Text>
          </View>
        )}
        // ✅ Navigation Gestures
        allowsBackForwardNavigationGestures={true}
        bounces={Platform.OS === "ios"}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    gap: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#0a0a0a",
    borderBottomWidth: 1,
    paddingTop: Platform.OS === "ios" ? 50 : 12,
    zIndex: 10,
  },
  backButton: { padding: 8, marginRight: 8 },
  refreshButton: { padding: 8, marginLeft: 8 },
  titleContainer: { flex: 1, gap: 2 },
  title: { color: "#fff", fontSize: 15, fontWeight: "600" },
  source: { color: "#888", fontSize: 12 },

  // Chrome-like Progress Bar
  progressContainer: {
    position: "absolute",
    top: Platform.OS === "ios" ? 90 : 55, // Adjust based on header height
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: "transparent",
    zIndex: 20,
  },
  progressBar: {
    height: "100%",
    borderRadius: 1.5,
    shadowColor: "#1DB954",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },

  webview: { flex: 1, backgroundColor: "#fff" },
  webviewLoading: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    gap: 12,
  },
  loadingText: { color: "#888", fontSize: 14 },

  errorOverlay: {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 16,
    zIndex: 30,
    padding: 24,
  },
  errorText: {
    color: "#FF453A",
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
  errorBtnText: { color: "#000", fontWeight: "700", fontSize: 14 },
  retryBtn: {
    backgroundColor: "#1DB954",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },
});
