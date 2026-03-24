// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewToken,
} from "react-native";
import { WebView } from "react-native-webview";
import { auth } from "../firebase/auth";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ─── Cache config ─────────────────────────────────────────────────────────────
const CACHE_KEY = "YPN_FORYOU_VIDEOS_V2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const BG_REFRESH_AFTER_MS = 3 * 60 * 60 * 1000; // background-refresh after 3h

// ─── Types ────────────────────────────────────────────────────────────────────
interface VideoItem {
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  channelTitle: string;
  channelURL: string;
}

interface CacheEntry {
  videos: VideoItem[];
  savedAt: number;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
async function loadCache(): Promise<CacheEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

async function saveCache(videos: VideoItem[]): Promise<void> {
  try {
    const entry: CacheEntry = { videos, savedAt: Date.now() };
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Non-critical
  }
}

// ─── Build YouTube embed HTML ─────────────────────────────────────────────────
// Using youtube-nocookie.com + full HTML injection fixes Error 153
// ("Video unavailable / not configured for embedded playback")
// that appears with source={{ uri }} on many YouTube videos.
function buildEmbedHtml(videoId: string, autoplay: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;background:#000;overflow:hidden}
    iframe{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100%;height:100%;border:none}
  </style>
</head>
<body>
  <iframe
    src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplay ? 1 : 0}&playsinline=1&rel=0&modestbranding=1&controls=1&enablejsapi=1"
    allow="autoplay;encrypted-media;fullscreen"
    allowfullscreen
    frameborder="0"
  ></iframe>
</body>
</html>`;
}

// ─── Skeleton card ────────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <View style={styles.card}>
      <View
        style={[StyleSheet.absoluteFillObject, { backgroundColor: "#111" }]}
      />
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.92)"]}
        style={styles.gradientOverlay}
        pointerEvents="none"
      >
        <View style={{ padding: 20, paddingBottom: 110 }}>
          <View
            style={[styles.skeletonLine, { width: "40%", marginBottom: 10 }]}
          />
          <View style={[styles.skeletonLine, { width: "78%" }]} />
          <View style={[styles.skeletonLine, { width: "55%", marginTop: 7 }]} />
        </View>
      </LinearGradient>
    </View>
  );
}

// ─── Video card ───────────────────────────────────────────────────────────────
function VideoCard({
  item,
  isActive,
  liked,
  likeCount,
  onLike,
}: {
  item: VideoItem;
  isActive: boolean;
  liked: boolean;
  likeCount: number;
  onLike: () => void;
}) {
  const embedHtml = buildEmbedHtml(item.videoId, isActive);

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${item.title}\n\nWatch on YouTube: ${item.url}`,
        url: item.url,
        title: item.title,
      });
    } catch {
      // user dismissed
    }
  };

  const formatCount = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

  return (
    <View style={styles.card}>
      {/* ── Player ─────────────────────────────────────────────────────── */}
      <WebView
        source={{
          html: embedHtml,
          baseUrl: "https://www.youtube-nocookie.com",
        }}
        style={styles.webview}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={["*"]}
        mixedContentMode="always"
        backgroundColor="#000000"
        onShouldStartLoadWithRequest={(req) =>
          req.url.includes("youtube-nocookie.com") ||
          req.url.includes("youtube.com") ||
          req.url === "about:blank"
        }
      />

      {/* ── Gradient overlay ────────────────────────────────────────────── */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.5)", "rgba(0,0,0,0.93)"]}
        locations={[0, 0.35, 1]}
        style={styles.gradientOverlay}
        pointerEvents="none"
      />

      {/* ── Right actions ───────────────────────────────────────────────── */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={onLike}
          activeOpacity={0.7}
        >
          <Ionicons
            name={liked ? "heart" : "heart-outline"}
            size={34}
            color={liked ? "#FF2D55" : "#FFFFFF"}
          />
          <Text style={styles.actionLabel}>{formatCount(likeCount)}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={handleShare}
          activeOpacity={0.7}
        >
          <Ionicons name="share-social-outline" size={32} color="#FFFFFF" />
          <Text style={styles.actionLabel}>Share</Text>
        </TouchableOpacity>
      </View>

      {/* ── Bottom metadata ─────────────────────────────────────────────── */}
      <View style={styles.meta} pointerEvents="none">
        <Text style={styles.channelName} numberOfLines={1}>
          {item.channelTitle}
        </Text>
        <Text style={styles.videoTitle} numberOfLines={2}>
          {item.title}
        </Text>
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [likes, setLikes] = useState<
    Record<string, { liked: boolean; count: number }>
  >({});

  const flatListRef = useRef<FlatList>(null);
  const watchedRef = useRef<Set<string>>(new Set());

  // ── Seed like counters ────────────────────────────────────────────────────
  const initLikes = (vids: VideoItem[]) => {
    setLikes((prev) => {
      const next = { ...prev };
      vids.forEach((v) => {
        if (!next[v.videoId]) {
          next[v.videoId] = {
            liked: false,
            count: Math.floor(Math.random() * 4800) + 200,
          };
        }
      });
      return next;
    });
  };

  // ── Fetch from backend ────────────────────────────────────────────────────
  const fetchFromNetwork = useCallback(async (silent = false) => {
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      const res = await fetch(`${API_URL}/api/videos/foryou`, {
        headers: { "x-user-uid": uid },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `Server error ${res.status}`);
      }
      const data: VideoItem[] = await res.json();
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error("No videos available right now.");
      }
      if (!silent) setVideos(data);
      else setVideos((prev) => (prev.length === 0 ? data : prev)); // bg refresh: only replace if empty
      initLikes(data);
      await saveCache(data);
      return data;
    } catch (err: any) {
      if (!silent) throw err;
      return null;
    }
  }, []);

  // ── Main load ─────────────────────────────────────────────────────────────
  const fetchFeed = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        // Skip cache on manual pull-to-refresh
        if (!isRefresh) {
          const cached = await loadCache();
          if (
            cached &&
            cached.videos.length >= 10 &&
            Date.now() - cached.savedAt < CACHE_TTL_MS
          ) {
            setVideos(cached.videos);
            initLikes(cached.videos);
            setLoading(false);

            // Background refresh if cache is getting stale
            if (Date.now() - cached.savedAt > BG_REFRESH_AFTER_MS) {
              fetchFromNetwork(true); // fire and forget
            }
            return;
          }
        }

        await fetchFromNetwork(false);
      } catch (err: any) {
        // Network failed — try stale cache as fallback
        const cached = await loadCache();
        if (cached && cached.videos.length > 0) {
          setVideos(cached.videos);
          initLikes(cached.videos);
          // Don't show error — stale data is fine
        } else {
          setError(err.message ?? "Failed to load videos.");
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetchFromNetwork],
  );

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  // ── Watched tracking ──────────────────────────────────────────────────────
  const markWatched = useCallback(async (videoId: string) => {
    if (watchedRef.current.has(videoId)) return;
    watchedRef.current.add(videoId);
    try {
      const uid = auth.currentUser?.uid ?? "anonymous";
      await fetch(`${API_URL}/api/videos/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-uid": uid },
        body: JSON.stringify({ videoId }),
      });
    } catch {
      /* non-critical */
    }
  }, []);

  // ── Viewability ───────────────────────────────────────────────────────────
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (!viewableItems.length) return;
      const idx = viewableItems[0].index ?? 0;
      setActiveIndex((prev) => {
        if (prev !== idx && videos[prev]) markWatched(videos[prev].videoId);
        return idx;
      });
    },
    [videos, markWatched],
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 75 }).current;

  // ── Like toggle ───────────────────────────────────────────────────────────
  const toggleLike = useCallback((videoId: string) => {
    setLikes((prev) => {
      const cur = prev[videoId] ?? { liked: false, count: 0 };
      return {
        ...prev,
        [videoId]: {
          liked: !cur.liked,
          count: cur.liked ? cur.count - 1 : cur.count + 1,
        },
      };
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <SkeletonCard />
        <ActivityIndicator
          size="large"
          color="#fff"
          style={StyleSheet.absoluteFillObject}
        />
      </View>
    );
  }

  if (error && videos.length === 0) {
    return (
      <View style={styles.centered}>
        <Ionicons name="wifi-outline" size={52} color="#444" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={() => fetchFeed(true)}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      ref={flatListRef}
      data={videos}
      keyExtractor={(item) => item.videoId}
      renderItem={({ item, index }) => {
        const ls = likes[item.videoId] ?? { liked: false, count: 0 };
        return (
          <VideoCard
            item={item}
            isActive={index === activeIndex}
            liked={ls.liked}
            likeCount={ls.count}
            onLike={() => toggleLike(item.videoId)}
          />
        );
      }}
      pagingEnabled
      snapToInterval={SCREEN_H}
      snapToAlignment="start"
      decelerationRate="fast"
      showsVerticalScrollIndicator={false}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
      refreshing={refreshing}
      onRefresh={() => fetchFeed(true)}
      getItemLayout={(_d, index) => ({
        length: SCREEN_H,
        offset: SCREEN_H * index,
        index,
      })}
      initialNumToRender={3}
      maxToRenderPerBatch={4}
      windowSize={7}
      removeClippedSubviews={false} // keep WebViews alive — prevents reload on scroll-back
    />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  card: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: "#000",
  },
  webview: {
    flex: 1,
    backgroundColor: "#000",
  },
  gradientOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: SCREEN_H * 0.55,
    justifyContent: "flex-end",
  },
  actions: {
    position: "absolute",
    right: 14,
    bottom: 110,
    alignItems: "center",
    gap: 28,
  },
  actionBtn: {
    alignItems: "center",
    gap: 5,
  },
  actionLabel: {
    color: "#FFF",
    fontSize: 12,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  meta: {
    position: "absolute",
    bottom: 90,
    left: 16,
    right: 80,
  },
  channelName: {
    color: "#1DB954",
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 5,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  videoTitle: {
    color: "#FFF",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  skeletonLine: {
    height: 13,
    backgroundColor: "#2a2a2a",
    borderRadius: 6,
  },
  centered: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    gap: 18,
  },
  errorText: {
    color: "#777",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  retryBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: "#1DB954",
  },
  retryLabel: {
    color: "#1DB954",
    fontSize: 14,
    fontWeight: "700",
  },
});
