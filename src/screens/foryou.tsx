// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  StatusBar as RNStatusBar,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
// ✅ WebView is built into Expo Go
import { WebView } from "react-native-webview";

// Import Cache & Auth utilities
import {
  getSecureCache,
  initializeSecureCache,
  setSecureCache
} from "../utils/cache";
import { getToken } from "../utils/tokenManager"; // ✅ Import Token Helper

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL;
const VIDEO_CACHE_KEY = "foryou_manifest";
const CACHE_TTL = 60 * 60 * 1000; // 60 minutes

type VideoItem = {
  id: string;
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
  duration?: number;
  streamUrl?: string;
};

// Helper to construct Google Drive Preview URL (Better for WebView than direct stream)
const getDriveStreamUrl = (fileId: string) => {
  return `https://drive.google.com/file/d/${fileId}/preview`;
};

// ── Cache Helpers ──────────────────────────────────────────────────────────────
async function readVideoCache(): Promise<VideoItem[] | null> {
  try {
    const data = await getSecureCache(VIDEO_CACHE_KEY);
    if (Array.isArray(data)) {
      return data.map((item) => ({
        ...item,
        streamUrl: item.fileId ? getDriveStreamUrl(item.fileId) : undefined,
      }));
    }
    return null;
  } catch {
    return null;
  }
}

async function writeVideoCache(items: VideoItem[]) {
  try {
    await setSecureCache(VIDEO_CACHE_KEY, items, CACHE_TTL);
  } catch (e) {
    console.warn("[Videos] Failed to write cache:", e);
  }
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "Unknown size";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

// ── Video Card / Player (Using WebView) ────────────────────────────────────────
const VideoCard = React.memo(({ item }: { item: VideoItem }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  if (!item.streamUrl) return null;

  return (
    <View style={s.card}>
      <View style={s.videoContainer}>
        {isLoading && !error && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="small" color="#1DB954" />
          </View>
        )}

        {error && (
          <View style={s.errorOverlay}>
            <Ionicons name="warning-outline" size={32} color="#E91429" />
            <Text style={s.errorTextSmall}>Failed to load</Text>
          </View>
        )}

        <WebView
          source={{ uri: item.streamUrl }}
          style={[s.videoPlayer, { opacity: isLoading || error ? 0 : 1 }]}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          onLoadStart={() => setIsLoading(true)}
          onLoadEnd={() => setIsLoading(false)}
          onError={() => {
            setError(true);
            setIsLoading(false);
          }}
          // Inject CSS to hide Google Drive header/footer for a cleaner look
          injectedStyles={`
            body { overflow: hidden; background: #000; }
            .drive-viewer-top-bar, .drive-viewer-bottom-bar, .drive-viewer-sidebar { display: none !important; }
          `}
        />
      </View>

      <View style={s.infoRow}>
        <View style={s.textWrap}>
          <Text style={s.title} numberOfLines={2}>
            {item.name}
          </Text>
          <Text style={s.meta}>
            {formatBytes(item.size)} • {item.mimeType}
          </Text>
        </View>
        <TouchableOpacity style={s.downloadBtn}>
          <Ionicons name="download-outline" size={20} color="#1DB954" />
        </TouchableOpacity>
      </View>
    </View>
  );
});

// ── Main Screen ────────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const init = async () => {
      await initializeSecureCache();
      boot();
    };
    init();

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const connected = !!state.isConnected;
      setIsOffline(!connected);
      if (connected && error) {
        fetchFromBackend(false);
      }
    });
    return () => unsub();
  }, [error]);

  const scheduleRefresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => fetchFromBackend(false), CACHE_TTL);
  };

  const boot = async () => {
    const cached = await readVideoCache();

    if (cached?.length) {
      setVideos(cached);
      setLoading(false);
      if (isOffline) return;
      scheduleRefresh();
    } else {
      setLoading(true);
      if (!isOffline) {
        await fetchFromBackend(false);
      } else {
        setLoading(false);
        setError(true);
      }
    }
  };

  const fetchFromBackend = async (manual = true) => {
    if (isOffline) {
      if (manual) setError(true);
      return;
    }

    if (manual) setRefreshing(true);
    else if (!videos.length) setLoading(true);

    setError(false);

    try {
      // ✅ 1. GET AUTH TOKEN
      const token = await getToken();

      if (!token) {
        console.warn("[Videos] No auth token found.");
        if (manual) {
          Alert.alert("Session Expired", "Please log in again to view videos.");
        }
        throw new Error("NO_TOKEN");
      }

      // ✅ 2. FETCH WITH HEADER
      const res = await fetch(`${API_URL}/api/videos/drive`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        if (res.status === 401) {
          console.error("[Videos] Auth Failed: Invalid or expired token.");
        }
        throw new Error(`HTTP ${res.status}`);
      }

      // ✅ 3. PARSE DATA (FIXED LINE BELOW)
      const data: VideoItem[] = await res.json();

      // Enhance data with stream URLs
      const enrichedData = data.map((item) => ({
        ...item,
        streamUrl: item.fileId ? getDriveStreamUrl(item.fileId) : undefined,
      }));

      if (enrichedData.length > 0) {
        await writeVideoCache(enrichedData);
        setVideos(enrichedData);
        scheduleRefresh();
      } else {
        if (manual) setError(true);
      }
    } catch (e: any) {
      console.warn("[Videos] Fetch failed:", e.message);
      if (e.message !== "NO_TOKEN" && manual) {
        setError(true);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading videos…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View
        style={{
          height:
            Platform.OS === "android"
              ? (RNStatusBar.currentHeight || 24) + 48
              : 48,
        }}
      />

      {videos.length > 0 && (
        <View style={s.countRow}>
          <Text style={s.countText}>
            {videos.length} video{videos.length !== 1 ? "s" : ""} available
          </Text>
        </View>
      )}

      {(error || isOffline) && videos.length === 0 ? (
        <View style={s.centre}>
          <Ionicons
            name={isOffline ? "wifi-off-outline" : "alert-circle-outline"}
            size={48}
            color="#333"
          />
          <Text style={s.errorText}>
            {isOffline ? "No internet connection" : "Could not load videos"}
          </Text>
          {!isOffline && (
            <TouchableOpacity
              style={s.retryBtn}
              onPress={() => fetchFromBackend(true)}
            >
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => !isOffline && fetchFromBackend(true)}
              tintColor="#1DB954"
              colors={["#1DB954"]}
            />
          }
        >
          {videos.length === 0 ? (
            <View style={s.centre}>
              <Text style={s.errorText}>No videos available</Text>
            </View>
          ) : (
            videos.map((item) => <VideoCard key={item.id} item={item} />)
          )}
        </ScrollView>
      )}

      {isOffline && videos.length > 0 && (
        <View style={s.offlineBanner}>
          <Ionicons name="wifi-off-outline" size={16} color="#fff" />
          <Text style={s.offlineText}>Offline • Showing cached videos</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    padding: 24,
  },
  loadingText: { color: "#555", fontSize: 14, marginTop: 8 },
  errorText: { color: "#555", fontSize: 16, textAlign: "center" },
  errorTextSmall: { color: "#E91429", fontSize: 12, fontWeight: "600" },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: "#1DB954",
    borderRadius: 20,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },
  countRow: { paddingHorizontal: 16, paddingBottom: 6 },
  countText: { color: "#3A3A3A", fontSize: 11 },
  list: { paddingHorizontal: 12, paddingBottom: 40 },
  card: {
    backgroundColor: "#111",
    borderRadius: 12,
    marginBottom: 16,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#1E1E1E",
  },
  videoContainer: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
    position: "relative",
  },
  videoPlayer: {
    width: "100%",
    height: "100%",
    backgroundColor: "#000",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#111",
    zIndex: 10,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.8)",
    gap: 8,
    zIndex: 10,
  },
  infoRow: {
    flexDirection: "row",
    padding: 12,
    alignItems: "center",
    gap: 12,
  },
  textWrap: { flex: 1 },
  title: {
    color: "#E8E8E8",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
    marginBottom: 4,
  },
  meta: {
    color: "#555",
    fontSize: 11,
  },
  downloadBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(29, 185, 84, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  offlineBanner: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#333",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  offlineText: { color: "#fff", fontSize: 12, fontWeight: "500" },
});
