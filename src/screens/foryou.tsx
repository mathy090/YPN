// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import { Audio, AVPlaybackStatus } from "expo-av";
import * as FileSystem from "expo-file-system";
import { Video } from "expo-video";
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

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const PREFETCH_COUNT = 3;
const L1_TTL_MS = 60 * 60 * 1000;
const { width: W, height: H } = Dimensions.get("window");
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

// ── Types ─────────────────────────────────────────────────────────────────────
type DriveVideo = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
  streamUrl: string;
};

// ── Cache Helpers ─────────────────────────────────────────────────────────────
let _manifestCache: DriveVideo[] | null = null;
let _manifestTs: number = 0;

function l1Read(): DriveVideo[] | null {
  if (!_manifestCache || Date.now() - _manifestTs > L1_TTL_MS) return null;
  return _manifestCache;
}

// ✅ FIX: Added 'data' variable name
function l1Write(data: DriveVideo[]) {
  _manifestCache = data;
  _manifestTs = Date.now();
}

const LOCAL_DIR = FileSystem.cacheDirectory + "ypn_drive_v3/";

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(LOCAL_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(LOCAL_DIR, { intermediates: true });
  }
}

const filePath = (id: string) => LOCAL_DIR + id + ".mp4";
const _cachedPaths = new Map<string, string>();

async function isFileCached(id: string): Promise<boolean> {
  if (_cachedPaths.has(id)) return true;
  const p = filePath(id);
  const info = await FileSystem.getInfoAsync(p);
  if (info.exists) {
    _cachedPaths.set(id, p);
    return true;
  }
  return false;
}

function getCachedPath(id: string): string | null {
  return _cachedPaths.get(id) || null;
}

function saveCachedPath(id: string, path: string) {
  _cachedPaths.set(id, path);
}

// ── Prefetch Logic ────────────────────────────────────────────────────────────
async function prefetch(videos: DriveVideo[]) {
  try {
    await ensureDir();
    for (const v of videos.slice(0, PREFETCH_COUNT)) {
      try {
        if (await isFileCached(v.fileId)) continue;
        const dest = filePath(v.fileId);
        const dl = await FileSystem.downloadAsync(v.streamUrl, dest);
        if (dl.status === 200) {
          saveCachedPath(v.fileId, dest);
        }
      } catch (e) {
        /* Silent fail */
      }
    }
  } catch (e) {
    console.warn("Prefetch error:", e);
  }
}

// ── Time Formatter ────────────────────────────────────────────────────────────
const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

// ── ProgressBar ───────────────────────────────────────────────────────────────
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
    const barRef = useRef<View>(null);
    const ratio = dur > 0 ? Math.min(pos / dur, 1) : 0;
    function handlePress(e: GestureResponderEvent) {
      if (!barRef.current) return;
      (barRef.current as any).measure((_x, _y, width: number) => {
        const r = Math.min(Math.max(e.nativeEvent.locationX / width, 0), 1);
        onSeek(r * dur);
      });
    }
    return (
      <Pressable
        ref={barRef as any}
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

// ── Video Card ────────────────────────────────────────────────────────────────
const VideoCard = React.memo(
  ({ item, isActive }: { item: DriveVideo; isActive: boolean }) => {
    const ref = useRef<Video>(null);
    const [paused, setPaused] = useState(false);
    const [loading, setLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [pos, setPos] = useState(0);
    const [dur, setDur] = useState(0);
    const [localPath, setLocalPath] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      isFileCached(item.fileId)
        .then((ok) => {
          if (!cancelled && ok) {
            const p = getCachedPath(item.fileId);
            if (p) setLocalPath(p);
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [item.fileId]);

    useEffect(() => {
      if (!ref.current) return;
      const timer = setTimeout(() => {
        if (isActive) {
          setPaused(false);
          ref.current?.playAsync().catch(() => {});
        } else {
          setPaused(true);
          ref.current?.pauseAsync().catch(() => {});
          ref.current?.setPositionAsync(0).catch(() => {});
          setPos(0);
          setLoading(true);
          setHasError(false);
        }
      }, 100);
      return () => clearTimeout(timer);
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

    const source = localPath ? { uri: localPath } : { uri: item.streamUrl };
    const displayName = item.name.replace(/\.[^.]+$/, "");

    return (
      <View style={s.card}>
        <Video
          ref={ref}
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          shouldPlay={isActive && !paused}
          isLooping
          isMuted={false}
          onPlaybackStatusUpdate={onStatus}
          onError={() => {
            setLoading(false);
            setHasError(true);
          }}
        />
        <Pressable style={s.tapZone} onPress={togglePlay} />
        {loading && !hasError && (
          <View style={s.centre} pointerEvents="none">
            <ActivityIndicator size="large" color="#1DB954" />
          </View>
        )}
        {hasError && (
          <View style={s.centre} pointerEvents="none">
            <Ionicons name="alert-circle-outline" size={52} color="#FF453A" />
            <Text style={s.errorLabel}>Could not load video</Text>
          </View>
        )}
        {paused && !loading && !hasError && (
          <View style={s.pauseWrap} pointerEvents="none">
            <View style={s.pauseCircle}>
              <Ionicons name="pause" size={38} color="#fff" />
            </View>
          </View>
        )}
        <View style={s.scrim} pointerEvents="none" />
        <View style={s.hud} pointerEvents="box-none">
          <Text style={s.title} numberOfLines={2}>
            {displayName}
          </Text>
          <View style={s.timeRow} pointerEvents="none">
            <Text style={s.timeText}>{fmt(pos)}</Text>
            {dur > 0 && <Text style={s.timeText}>{fmt(dur)}</Text>}
          </View>
          <ProgressBar pos={pos} dur={dur} onSeek={onSeek} />
        </View>
        {localPath != null && (
          <View style={s.badge} pointerEvents="none">
            <Ionicons name="cloud-done-outline" size={12} color="#1DB954" />
          </View>
        )}
      </View>
    );
  },
);

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<DriveVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchErr, setFetchErr] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    }).catch(() => {});
    boot();
  }, []);

  async function boot() {
    const cached = l1Read();
    if (cached && cached.length > 0) {
      setVideos(cached);
      setLoading(false);
      prefetch(cached);
      refreshManifest(false);
      return;
    }
    await refreshManifest(false);
  }

  async function refreshManifest(manual: boolean) {
    if (manual) setRefreshing(true);
    else if (!videos.length) setLoading(true);
    setFetchErr(false);

    try {
      const res = await fetch(`${API_URL}/api/videos/drive/feed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: DriveVideo[] = await res.json();
      if (!data.length) throw new Error("Empty manifest");

      l1Write(data);
      setVideos(data);
      prefetch(data);
    } catch (e: any) {
      console.warn("[ForYou] fetch error:", e.message);
      const stale = l1Read();
      if (stale && stale.length > 0) setVideos(stale);
      else setFetchErr(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: any[] }) => {
      if (viewableItems.length > 0) setActiveIdx(viewableItems[0].index ?? 0);
    },
    [],
  );

  const viewCfg = useRef({
    itemVisiblePercentThreshold: 60,
    minimumViewTime: 100,
  });

  const renderItem = useCallback(
    ({ item, index }: { item: DriveVideo; index: number }) => (
      <VideoCard item={item} isActive={index === activeIdx} />
    ),
    [activeIdx],
  );

  if (loading)
    return (
      <View style={s.fullCentre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading videos…</Text>
      </View>
    );

  if (fetchErr && !videos.length)
    return (
      <View style={s.fullCentre}>
        <Ionicons name="wifi-outline" size={52} color="#333" />
        <Text style={s.noVideoText}>Could not load videos</Text>
        <Pressable style={s.retryBtn} onPress={() => refreshManifest(false)}>
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );

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
        onRefresh={() => refreshManifest(true)}
        refreshing={refreshing}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewCfg.current}
        windowSize={4}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        removeClippedSubviews={Platform.OS === "android"}
        getItemLayout={(_, i) => ({ length: H, offset: H * i, index: i })}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  card: { width: W, height: H, backgroundColor: "#0a0a0a", overflow: "hidden" },
  tapZone: { position: "absolute", top: 0, left: 0, right: 0, bottom: 88 },
  centre: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  fullCentre: {
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
  title: {
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
  timeText: { color: "#fff", fontSize: 11, fontWeight: "600" },
  badge: {
    position: "absolute",
    top: 12 + STATUS_H,
    right: 12,
    padding: 6,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
});
