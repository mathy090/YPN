// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Platform,
  StatusBar as RNStatusBar,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
// VideoPlayer is in its own file to prevent Metro from registering
// RNCWebView twice during hot-reload (Invariant Violation fix).
import VideoPlayer from "../components/VideoPlayer";
import { auth } from "../firebase/auth";

const { width: W, height: H } = Dimensions.get("window");
const BOTTOM_TAB_HEIGHT = 86;
const STATUS_BAR_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ── Number formatter — 1200000 → "1.2M", 45000 → "45K" ──────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

// ── Types ─────────────────────────────────────────────────────────────────────
type VideoItem = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  url: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
};

// ── Fallback videos (shown if backend is cold / offline) ──────────────────────
const FALLBACK: VideoItem[] = [
  {
    videoId: "X6-jQFdQHUY",
    title: "Youth Empowerment — Find Your Purpose",
    channelTitle: "YPN Zimbabwe",
    thumbnail: "https://img.youtube.com/vi/X6-jQFdQHUY/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=X6-jQFdQHUY",
    viewCount: null,
    likeCount: null,
    commentCount: null,
  },
  {
    videoId: "ugcSDR_Z0sA",
    title: "Mental Health Tips for Young People",
    channelTitle: "Mental Health Africa",
    thumbnail: "https://img.youtube.com/vi/ugcSDR_Z0sA/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=ugcSDR_Z0sA",
    viewCount: null,
    likeCount: null,
    commentCount: null,
  },
  {
    videoId: "ZmWBrN7QV6Y",
    title: "How to Build Skills for the Future",
    channelTitle: "Education Hub",
    thumbnail: "https://img.youtube.com/vi/ZmWBrN7QV6Y/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=ZmWBrN7QV6Y",
    viewCount: null,
    likeCount: null,
    commentCount: null,
  },
];

// ── Single stat pill ──────────────────────────────────────────────────────────
const Stat = ({
  icon,
  value,
  color = "#fff",
}: {
  icon: string;
  value: string;
  color?: string;
}) => (
  <View style={s.statPill}>
    <Ionicons name={icon as any} size={15} color={color} />
    <Text style={[s.statText, { color }]}>{value}</Text>
  </View>
);

// ── Single video card ─────────────────────────────────────────────────────────
const VideoCard = React.memo(
  ({
    item,
    onWatched,
  }: {
    item: VideoItem;
    onWatched: (id: string) => void;
  }) => {
    const [liked, setLiked] = useState(false);
    const [playing, setPlaying] = useState(false);

    const handlePlay = useCallback(() => {
      onWatched(item.videoId);
      setPlaying(true);
    }, [item.videoId, onWatched]);

    const handleShare = useCallback(async () => {
      try {
        await Share.share({ message: `${item.title}\n${item.url}` });
      } catch {}
    }, [item]);

    return (
      <View style={s.card}>
        {playing ? (
          <VideoPlayer
            videoId={item.videoId}
            onClose={() => setPlaying(false)}
          />
        ) : (
          <>
            {/* ── Thumbnail ── */}
            <TouchableOpacity
              activeOpacity={0.92}
              onPress={handlePlay}
              style={StyleSheet.absoluteFill}
            >
              <Image
                source={{ uri: item.thumbnail }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
              />
              {/* Scrim: two overlapping semi-transparent views to fake gradient */}
              <View style={s.scrimTop} />
              <View style={s.scrimBottom} />

              {/* Play button */}
              <View style={s.playWrap} pointerEvents="none">
                <View style={s.playCircle}>
                  <Ionicons name="play" size={30} color="#fff" />
                </View>
              </View>
            </TouchableOpacity>

            {/* ── LEFT side: Like / Share / Play ── */}
            <View style={s.actions}>
              <TouchableOpacity
                onPress={() => setLiked((p) => !p)}
                style={s.actionBtn}
              >
                <Ionicons
                  name={liked ? "heart" : "heart-outline"}
                  size={30}
                  color={liked ? "#FF3B57" : "#fff"}
                />
                <Text style={s.actionLabel}>
                  {liked ? fmt((item.likeCount ?? 0) + 1) : fmt(item.likeCount)}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={handleShare} style={s.actionBtn}>
                <Ionicons name="share-social-outline" size={28} color="#fff" />
                <Text style={s.actionLabel}>Share</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={handlePlay} style={s.actionBtn}>
                <Ionicons name="play-circle-outline" size={30} color="#fff" />
                <Text style={s.actionLabel}>Play</Text>
              </TouchableOpacity>
            </View>

            {/* ── Info + stats just above bottom tab bar ── */}
            <View style={s.info}>
              {/* Channel name */}
              <View style={s.channelRow}>
                <View style={s.channelDot} />
                <Text style={s.channelText} numberOfLines={1}>
                  {item.channelTitle}
                </Text>
              </View>

              {/* Title */}
              <Text style={s.titleText} numberOfLines={2}>
                {item.title}
              </Text>

              {/* Real YouTube stats row */}
              <View style={s.statsRow}>
                <Stat icon="eye-outline" value={fmt(item.viewCount)} />
                <Stat
                  icon="heart-outline"
                  value={fmt(item.likeCount)}
                  color="#FF3B57"
                />
                <Stat
                  icon="chatbubble-outline"
                  value={fmt(item.commentCount)}
                />
              </View>
            </View>
          </>
        )}
      </View>
    );
  },
);

// ── Retry on 503 (Render free-tier cold starts) ───────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  delayMs = 3000,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 503 && i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [usedFallback, setUsedFallback] = useState(false);
  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    fetchFeed();
  }, []);

  const fetchFeed = async () => {
    setLoading(true);
    setUsedFallback(false);
    try {
      const uid = auth?.currentUser?.uid ?? "anonymous";
      const res = await fetchWithRetry(
        `${API_URL}/api/videos/foryou`,
        { headers: { "x-user-uid": uid } },
        3,
        3000,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: VideoItem[] = await res.json();
      setVideos(data.length > 0 ? data : FALLBACK);
      if (data.length === 0) setUsedFallback(true);
    } catch (e) {
      console.warn("ForYou fetch failed:", e);
      setVideos(FALLBACK);
      setUsedFallback(true);
    } finally {
      setLoading(false);
    }
  };

  const markWatched = useCallback(async (videoId: string) => {
    try {
      const uid = auth?.currentUser?.uid;
      if (!uid) return;
      await fetch(`${API_URL}/api/videos/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-uid": uid },
        body: JSON.stringify({ videoId }),
      });
    } catch {}
  }, []);

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading your feed…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {usedFallback && (
        <View style={s.banner}>
          <Ionicons name="bookmark-outline" size={13} color="#FFD60A" />
          <Text style={s.bannerText}>
            Showing saved videos — pull down to refresh
          </Text>
        </View>
      )}

      <FlatList
        ref={flatRef}
        data={videos}
        keyExtractor={(v) => v.videoId}
        renderItem={({ item }) => (
          <VideoCard item={item} onWatched={markWatched} />
        )}
        pagingEnabled
        snapToInterval={H}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onRefresh={fetchFeed}
        refreshing={loading}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },

  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    gap: 12,
  },
  loadingText: { color: "#8E8E93", fontSize: 14 },

  card: { width: W, height: H, backgroundColor: "#111", overflow: "hidden" },

  // Two-layer scrim to simulate a gradient without expo-linear-gradient
  scrimTop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: H * 0.25,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  scrimBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: H * 0.55,
    backgroundColor: "rgba(0,0,0,0.6)",
  },

  playWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  playCircle: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: "rgba(0,0,0,0.48)",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.65)",
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: 4,
  },

  // LEFT actions
  actions: {
    position: "absolute",
    left: 14,
    bottom: BOTTOM_TAB_HEIGHT + 110,
    alignItems: "center",
    gap: 20,
  },
  actionBtn: { alignItems: "center", gap: 3 },
  actionLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Info block — offset right so it doesn't overlap action buttons
  info: {
    position: "absolute",
    left: 62,
    right: 14,
    bottom: BOTTOM_TAB_HEIGHT + 14,
    gap: 5,
  },
  channelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  channelDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#1DB954",
    flexShrink: 0,
  },
  channelText: {
    color: "#1DB954",
    fontSize: 13,
    fontWeight: "700",
    flexShrink: 1,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  titleText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 21,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },

  // Stats row
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 2,
  },
  statPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  statText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Fallback banner
  banner: {
    position: "absolute",
    top: STATUS_BAR_H,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,214,10,0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,214,10,0.25)",
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  bannerText: { color: "#FFD60A", fontSize: 12 },
});
