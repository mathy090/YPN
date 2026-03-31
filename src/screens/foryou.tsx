// src/screens/foryou.tsx
//
// TikTok-style full-screen video feed from Google Drive.
//
// CACHE:
//   L1 — AsyncStorage manifest JSON (1-hour TTL, persists across restarts)
//   L2 — expo-file-system local video files (first 5 videos for offline)
//
// PLAYER:
//   expo-av Video — tap to pause/play, scrubable progress bar, auto-play on scroll

import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio, AVPlaybackStatus, ResizeMode, Video } from "expo-av";
import * as FileSystem from "expo-file-system";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  GestureResponderEvent,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { auth } from "../firebase/auth";

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const PREFETCH = 5;
const CACHE_KEY = "ypn_drive_manifest_v1";
const CACHE_TS_KEY = "ypn_drive_manifest_ts_v1";
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const { width: W, height: H } = Dimensions.get("window");
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

// ── Types ──────────────────────────────────────────────────────────────────────
type DriveVideo = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
};

// ── AsyncStorage manifest cache ────────────────────────────────────────────────
async function readCache(): Promise<DriveVideo[] | null> {
  try {
    const ts = await AsyncStorage.getItem(CACHE_TS_KEY);
    if (!ts || Date.now() - Number(ts) > CACHE_TTL) return null;
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as DriveVideo[]) : null;
  } catch {
    return null;
  }
}

async function writeCache(data: DriveVideo[]) {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data));
    await AsyncStorage.setItem(CACHE_TS_KEY, String(Date.now()));
  } catch {}
}

// ── Local file cache (offline) ─────────────────────────────────────────────────
const LOCAL_DIR = FileSystem.cacheDirectory + "ypn_videos_v1/";
const LP_KEY = (id: string) => "ypn_lp_" + id;

const localPath = (id: string) => LOCAL_DIR + id + ".mp4";

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(LOCAL_DIR);
  if (!info.exists)
    await FileSystem.makeDirectoryAsync(LOCAL_DIR, { intermediates: true });
}

async function readLP(id: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LP_KEY(id));
  } catch {
    return null;
  }
}

async function writeLP(id: string, path: string) {
  try {
    await AsyncStorage.setItem(LP_KEY(id), path);
  } catch {}
}

async function isCached(id: string): Promise<boolean> {
  const p = await readLP(id);
  if (!p) return false;
  return (await FileSystem.getInfoAsync(p)).exists;
}

// ── Auth ───────────────────────────────────────────────────────────────────────
async function getHeaders(): Promise<Record<string, string>> {
  try {
    const t = await auth.currentUser?.getIdToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

const streamUrl = (id: string) => `${API_URL}/api/videos/drive/stream/${id}`;

// ── Prefetch first N videos to device storage ──────────────────────────────────
async function prefetchVideos(videos: DriveVideo[]) {
  await ensureDir();
  for (const v of videos.slice(0, PREFETCH)) {
    try {
      if (await isCached(v.fileId)) continue;
      const dest = localPath(v.fileId);
      const h = await getHeaders();
      const dl = await FileSystem.downloadAsync(streamUrl(v.fileId), dest, {
        headers: h,
      });
      if (dl.status === 200) await writeLP(v.fileId, dest);
    } catch {}
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

// ── ProgressBar ────────────────────────────────────────────────────────────────
const ProgressBar = React.memo(
  ({
    pos,
    dur,
    onSeek,
  }: {
    pos: number;
    dur: number;
    onSeek: (ms: number) => void;
  }) => {
    const ref = useRef<View>(null);
    const ratio = dur > 0 ? Math.min(pos / dur, 1) : 0;

    function handlePress(e: GestureResponderEvent) {
      if (!ref.current) return;
      (ref.current as any).measure((_x: number, _y: number, width: number) => {
        const r = Math.min(Math.max(e.nativeEvent.locationX / width, 0), 1);
        onSeek(r * dur);
      });
    }

    return (
      <Pressable
        ref={ref as any}
        onPress={handlePress}
        hitSlop={{ top: 18, bottom: 18 }}
        style={pb.track}
      >
        <View style={[pb.fill, { width: `${ratio * 100}%` }]} />
        <View style={[pb.thumb, { left: `${ratio * 100}%` as any }]} />
      </Pressable>
    );
  },
);

const pb = StyleSheet.create({
  track: {
    height: 3,
    backgroundColor: "rgba(255,255,255,0.22)",
    borderRadius: 2,
    justifyContent: "center",
  },
  fill: { height: 3, backgroundColor: "#1DB954", borderRadius: 2 },
  thumb: {
    position: "absolute",
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: "#fff",
    top: -5,
    marginLeft: -6.5,
  },
});

// ── VideoCard ─────────────────────────────────────────────────────────────────
const VideoCard = React.memo(
  ({
    item,
    isActive,
    headers,
  }: {
    item: DriveVideo;
    isActive: boolean;
    headers: Record<string, string>;
  }) => {
    const ref = useRef<Video>(null);
    const [paused, setPaused] = useState(false);
    const [loading, setLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [pos, setPos] = useState(0);
    const [dur, setDur] = useState(0);
    const [localUri, setLocalUri] = useState<string | null>(null);

    // Check local cache once on mount
    useEffect(() => {
      (async () => {
        if (await isCached(item.fileId)) {
          const p = await readLP(item.fileId);
          if (p) setLocalUri(p);
        }
      })();
    }, [item.fileId]);

    // Auto-play / pause when card enters or exits viewport
    useEffect(() => {
      if (!ref.current) return;
      if (isActive) {
        setPaused(false);
        ref.current.playAsync().catch(() => {});
      } else {
        setPaused(true);
        ref.current.pauseAsync().catch(() => {});
        ref.current.setPositionAsync(0).catch(() => {});
        setPos(0);
      }
    }, [isActive]);

    const togglePlay = useCallback(() => {
      if (!ref.current) return;
      if (paused) {
        ref.current.playAsync().catch(() => {});
        setPaused(false);
      } else {
        ref.current.pauseAsync().catch(() => {});
        setPaused(true);
      }
    }, [paused]);

    const onStatus = useCallback((status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;
      setLoading(false);
      setPos(status.positionMillis ?? 0);
      setDur(status.durationMillis ?? 0);
    }, []);

    const onSeek = useCallback((ms: number) => {
      ref.current?.setPositionAsync(ms).catch(() => {});
      setPos(ms);
    }, []);

    const source = localUri
      ? { uri: localUri }
      : { uri: streamUrl(item.fileId), headers };
    const displayName = item.name.replace(/\.[^.]+$/, "");

    return (
      <View style={s.card}>
        {/* expo-av Video */}
        <Video
          ref={ref}
          source={source}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.COVER}
          shouldPlay={isActive && !paused}
          isLooping
          isMuted={false}
          onPlaybackStatusUpdate={onStatus}
          onError={() => {
            setLoading(false);
            setHasError(true);
          }}
          useNativeControls={false}
        />

        {/* Tap zone (above video, below HUD) */}
        <Pressable style={s.tapZone} onPress={togglePlay} />

        {/* Buffering */}
        {loading && !hasError && (
          <View style={s.overlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#1DB954" />
          </View>
        )}

        {/* Error */}
        {hasError && (
          <View style={s.overlay} pointerEvents="none">
            <Ionicons name="alert-circle-outline" size={52} color="#FF453A" />
            <Text style={s.errorLabel}>Could not load video</Text>
          </View>
        )}

        {/* Pause icon */}
        {paused && !loading && !hasError && (
          <View style={s.pauseWrap} pointerEvents="none">
            <View style={s.pauseCircle}>
              <Ionicons name="pause" size={38} color="#fff" />
            </View>
          </View>
        )}

        {/* Scrim */}
        <View style={s.scrim} pointerEvents="none" />

        {/* HUD — title + time + progress bar */}
        <View style={s.hud} pointerEvents="box-none">
          <Text style={s.videoTitle} numberOfLines={2}>
            {displayName}
          </Text>
          <View style={s.timeRow} pointerEvents="none">
            <Text style={s.timeText}>{fmt(pos)}</Text>
            {dur > 0 && <Text style={s.timeText}>{fmt(dur)}</Text>}
          </View>
          <ProgressBar pos={pos} dur={dur} onSeek={onSeek} />
        </View>

        {/* Offline badge */}
        {localUri && (
          <View style={s.badge} pointerEvents="none">
            <Ionicons name="cloud-done-outline" size={12} color="#1DB954" />
          </View>
        )}
      </View>
    );
  },
);

// ── Main screen ────────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<DriveVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    // Allow audio even on silent switch (iOS)
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    }).catch(() => {});
    getHeaders().then(setHeaders);
    boot();
  }, []);

  async function boot() {
    const cached = await readCache();
    if (cached && cached.length > 0) {
      setVideos(cached);
      setLoading(false);
      fetchManifest(false, true); // silent background refresh
      prefetchVideos(cached);
      return;
    }
    await fetchManifest(false, false);
  }

  async function fetchManifest(manual: boolean, silent: boolean) {
    if (manual) setRefreshing(true);
    else if (!silent) setLoading(true);
    setFetchError(false);

    try {
      const h = await getHeaders();
      setHeaders(h);
      const res = await fetch(`${API_URL}/api/videos/drive/feed`, {
        headers: h,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: DriveVideo[] = await res.json();
      if (!data.length) throw new Error("Empty manifest");
      await writeCache(data);
      setVideos(data);
      prefetchVideos(data);
    } catch {
      const cached = await readCache();
      if (cached?.length) setVideos(cached);
      else setFetchError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: any[] }) => {
      if (viewableItems.length > 0) setActiveIdx(viewableItems[0].index ?? 0);
    },
    [],
  );

  const viewConfig = useRef({
    itemVisiblePercentThreshold: 70,
    minimumViewTime: 80,
  });

  const renderItem = useCallback(
    ({ item, index }: { item: DriveVideo; index: number }) => (
      <VideoCard item={item} isActive={index === activeIdx} headers={headers} />
    ),
    [activeIdx, headers],
  );

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading videos…</Text>
      </View>
    );
  }

  if (fetchError && !videos.length) {
    return (
      <View style={s.centre}>
        <Ionicons name="wifi-outline" size={52} color="#333" />
        <Text style={s.noVideoText}>No videos available</Text>
        <Pressable
          style={s.retryBtn}
          onPress={() => fetchManifest(false, false)}
        >
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <FlatList
        ref={flatRef}
        data={videos}
        keyExtractor={(v) => v.fileId}
        renderItem={renderItem}
        pagingEnabled
        snapToInterval={H}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onRefresh={() => fetchManifest(true, false)}
        refreshing={refreshing}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewConfig.current}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        removeClippedSubviews
        getItemLayout={(_, i) => ({ length: H, offset: H * i, index: i })}
      />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },

  card: { width: W, height: H, backgroundColor: "#0a0a0a", overflow: "hidden" },

  tapZone: { position: "absolute", top: 0, left: 0, right: 0, bottom: 88 },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },

  centre: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    gap: 14,
  },

  loadingText: { color: "#555", fontSize: 14 },
  noVideoText: { color: "#888", fontSize: 16, textAlign: "center" },
  errorLabel: { color: "#FF453A", fontSize: 14, marginTop: 8 },

  retryBtn: {
    backgroundColor: "#1DB954",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 4,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },

  pauseWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  pauseCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },

  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 160,
    backgroundColor: "rgba(0,0,0,0.55)",
  },

  hud: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingBottom: 22,
  },

  videoTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 22,
    marginBottom: 10,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },

  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  timeText: { color: "rgba(255,255,255,0.6)", fontSize: 11 },

  badge: {
    position: "absolute",
    top: STATUS_H + 14,
    right: 14,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.4)",
    justifyContent: "center",
    alignItems: "center",
  },
});
