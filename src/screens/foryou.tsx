// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useIsFocused } from "@react-navigation/native";
import { Audio, AVPlaybackStatus, Video } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
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
const PREFETCH_COUNT = 3;
const L1_TTL_MS = 60 * 60 * 1000;
const { width: W, height: H } = Dimensions.get("window");
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

// ── AsyncStorage keys ──────────────────────────────────────────────────────────
const MK_DATA = "ypn:manifest_v3";
const MK_TS = "ypn:manifest_ts_v3";
const MK_LP = (id: string) => `ypn:lp_${id}`;
const MK_POS = (id: string) => `ypn:pos_${id}`;

// ── Types ─────────────────────────────────────────────────────────────────────
type DriveVideo = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
};

// ── AsyncStorage helpers ───────────────────────────────────────────────────────
async function l1Read(): Promise<DriveVideo[] | null> {
  try {
    const tsRaw = await AsyncStorage.getItem(MK_TS);
    const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
    if (!ts || Date.now() - ts > L1_TTL_MS) return null;
    const raw = await AsyncStorage.getItem(MK_DATA);
    return raw ? (JSON.parse(raw) as DriveVideo[]) : null;
  } catch {
    return null;
  }
}

async function l1Write(data: DriveVideo[]): Promise<void> {
  try {
    await AsyncStorage.setItem(MK_DATA, JSON.stringify(data));
    await AsyncStorage.setItem(MK_TS, Date.now().toString());
  } catch {}
}

async function readLP(id: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(MK_LP(id));
  } catch {
    return null;
  }
}

async function saveLP(id: string, path: string): Promise<void> {
  try {
    await AsyncStorage.setItem(MK_LP(id), path);
  } catch {}
}

async function savePlaybackPosition(
  id: string,
  position: number,
): Promise<void> {
  try {
    await AsyncStorage.setItem(MK_POS(id), position.toString());
  } catch {}
}

async function loadPlaybackPosition(id: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(MK_POS(id));
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

async function isFileCached(id: string): Promise<boolean> {
  try {
    const p = await readLP(id);
    if (!p) return false;
    return (await FileSystem.getInfoAsync(p)).exists;
  } catch {
    return false;
  }
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const user = auth.currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

const streamUrl = (id: string) => `${API_URL}/api/videos/drive/stream/${id}`;
const LOCAL_DIR = FileSystem.cacheDirectory + "ypn_drive_v3/";
const filePath = (id: string) => LOCAL_DIR + id + ".mp4";

// ── Prefetch ───────────────────────────────────────────────────────────────────
async function prefetch(videos: DriveVideo[]): Promise<void> {
  try {
    await FileSystem.makeDirectoryAsync(LOCAL_DIR, {
      intermediates: true,
    }).catch(() => {});
    for (const v of videos.slice(0, PREFETCH_COUNT)) {
      try {
        if (await isFileCached(v.fileId)) continue;
        const dest = filePath(v.fileId);
        const headers = await getAuthHeaders();
        const dl = await FileSystem.downloadAsync(streamUrl(v.fileId), dest, {
          headers,
        });
        if (dl.status === 200) await saveLP(v.fileId, dest);
      } catch {}
    }
  } catch {}
}

// ── Time formatter ─────────────────────────────────────────────────────────────
const fmt = (ms: number): string => {
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
      (barRef.current as any).measure(
        (_x: number, _y: number, width: number) => {
          const r = Math.min(Math.max(e.nativeEvent.locationX / width, 0), 1);
          onSeek(r * dur);
        },
      );
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

// ── VideoCard ──────────────────────────────────────────────────────────────────
const VideoCard = React.memo(
  ({
    item,
    isActive,
    authHeaders,
    onActiveChange,
    isScreenFocused,
  }: {
    item: DriveVideo;
    isActive: boolean;
    authHeaders: Record<string, string>;
    onActiveChange: (id: string) => void;
    isScreenFocused: boolean;
  }) => {
    const ref = useRef<Video>(null);
    const [paused, setPaused] = useState(false);
    const [loading, setLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [pos, setPos] = useState(0);
    const [dur, setDur] = useState(0);
    const [localPath, setLocalPath] = useState<string | null>(null);
    const [showPlayPauseIndicator, setShowPlayPauseIndicator] = useState(false);
    const indicatorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    // ✅ FIX: Track last play state to avoid redundant calls
    const lastPlayState = useRef<{ playing: boolean; position: number }>({
      playing: false,
      position: 0,
    });

    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const cached = await isFileCached(item.fileId);
          if (!cancelled && cached) {
            const path = await readLP(item.fileId);
            if (path) setLocalPath(path);
          }
          const savedPos = await loadPlaybackPosition(item.fileId);
          if (savedPos > 0) {
            setPos(savedPos);
            lastPlayState.current.position = savedPos;
          }
        } catch {}
      })();
      return () => {
        cancelled = true;
      };
    }, [item.fileId]);

    useEffect(() => {
      return () => {
        if (indicatorTimeout.current) clearTimeout(indicatorTimeout.current);
      };
    }, []);

    // ✅ Auto-pause/resume based on screen focus (navigation)
    useEffect(() => {
      if (!ref.current) return;
      if (!isScreenFocused) {
        ref.current.pauseAsync?.().catch(() => {});
        setPaused(true);
        savePlaybackPosition(item.fileId, pos);
        lastPlayState.current.playing = false;
      } else if (isActive && !paused && !lastPlayState.current.playing) {
        ref.current.playAsync?.().catch(() => {});
        lastPlayState.current.playing = true;
      }
    }, [isScreenFocused, isActive, paused, item.fileId, pos]);

    // ✅ Save playback position on unmount or when video becomes inactive
    useEffect(() => {
      return () => {
        savePlaybackPosition(item.fileId, pos);
      };
    }, [item.fileId, pos]);

    // ✅ MAIN FIX: Only trigger play/pause when isActive/isScreenFocused changes, NOT when pos/dur updates
    useEffect(() => {
      if (!ref.current) return;

      const shouldPlay = isActive && isScreenFocused && !paused;
      const lastPlayed = lastPlayState.current.playing;

      if (shouldPlay && !lastPlayed) {
        // Start playing
        onActiveChange(item.fileId);
        // Resume from saved position if > 0 and < duration
        if (pos > 0 && dur > 0 && pos < dur) {
          ref.current.setPositionAsync(pos).catch(() => {});
        }
        ref.current.playAsync?.().catch(() => {});
        lastPlayState.current.playing = true;
        lastPlayState.current.position = pos;
      } else if (!shouldPlay && lastPlayed) {
        // Pause
        ref.current.pauseAsync?.().catch(() => {});
        lastPlayState.current.playing = false;
        // Don't reset position — keep saved position
        setLoading(true);
        setHasError(false);
      }
    }, [isActive, isScreenFocused, paused, item.fileId]); // ✅ Removed pos/dur from deps

    // ✅ TikTok-style toggle: show indicator + fade INSTANTLY (0ms) for BOTH play & pause
    const togglePlay = useCallback(() => {
      if (!ref.current) return;
      if (paused) {
        ref.current.playAsync?.().catch(() => {});
        setPaused(false);
        lastPlayState.current.playing = true;
      } else {
        ref.current.pauseAsync?.().catch(() => {});
        setPaused(true);
        savePlaybackPosition(item.fileId, pos);
        lastPlayState.current.playing = false;
      }
      // Show play/pause indicator (instant fade for both actions)
      setShowPlayPauseIndicator(true);
      if (indicatorTimeout.current) clearTimeout(indicatorTimeout.current);
      indicatorTimeout.current = setTimeout(() => {
        setShowPlayPauseIndicator(false);
      }, 0); // ✅ Instant fade: 0ms timeout
    }, [paused, item.fileId, pos]);

    const onStatus = useCallback(
      (status: AVPlaybackStatus) => {
        if (!status.isLoaded) return;
        if (loading) setLoading(false);
        setPos(status.positionMillis ?? 0);
        setDur(status.durationMillis ?? 0);
      },
      [loading],
    );

    const onSeek = useCallback(
      (ms: number) => {
        ref.current?.setPositionAsync?.(ms).catch(() => {});
        setPos(ms);
        savePlaybackPosition(item.fileId, ms);
        lastPlayState.current.position = ms;
      },
      [item.fileId],
    );

    const source = localPath
      ? { uri: localPath }
      : { uri: streamUrl(item.fileId), headers: authHeaders };
    const displayName = item.name.replace(/\.[^.]+$/, "");

    return (
      <View style={s.card}>
        <Video
          ref={ref}
          source={source}
          style={s.video}
          resizeMode="cover"
          shouldPlay={isActive && !paused && isScreenFocused}
          isLooping
          isMuted={false}
          onPlaybackStatusUpdate={onStatus}
          onError={(e) => {
            console.warn("[VideoCard] Error:", e);
            setLoading(false);
            setHasError(true);
          }}
          onReadyForDisplay={() => setLoading(false)}
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

        {/* ✅ TikTok iOS-style play/pause indicator (center, fades instantly for BOTH actions) */}
        {showPlayPauseIndicator && (
          <View style={s.playPauseIndicator} pointerEvents="none">
            <View style={s.playPauseCircle}>
              <Ionicons
                name={paused ? "pause" : "play"}
                size={24}
                color="#fff"
              />
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

// ── Main Screen ────────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<DriveVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchErr, setFetchErr] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});
  const [isOffline, setIsOffline] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const isScreenFocused = useIsFocused();
  const flatRef = useRef<FlatList>(null);
  const fetchMoreTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === "active"
      ) {
        Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
        }).catch(() => {});
      } else if (nextAppState.match(/inactive|background/)) {
        Audio.setAudioModeAsync({
          playsInSilentModeIOS: false,
          staysActiveInBackground: false,
        }).catch(() => {});
      }
      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    }).catch(() => {});
    getAuthHeaders().then(setAuthHeaders);
  }, []);

  useEffect(() => {
    boot();
  }, []);

  useEffect(() => {
    return () => {
      if (fetchMoreTimeout.current) clearTimeout(fetchMoreTimeout.current);
    };
  }, []);

  async function boot(): Promise<void> {
    const cached = await l1Read();
    if (cached && cached.length > 0) {
      setVideos(cached);
      setLoading(false);
      prefetch(cached);
      const tsRaw = await AsyncStorage.getItem(MK_TS);
      const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
      if (Date.now() - ts > L1_TTL_MS) refreshManifest(false);
      return;
    }
    await refreshManifest(false);
  }

  async function refreshManifest(manual: boolean): Promise<void> {
    if (manual) setRefreshing(true);
    else if (!videos.length) setLoading(true);
    setFetchErr(false);
    try {
      const headers = await getAuthHeaders();
      setAuthHeaders(headers);
      const res = await fetch(`${API_URL}/api/videos/drive/feed`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: DriveVideo[] = await res.json();
      if (!data.length) throw new Error("Empty manifest from server");
      await l1Write(data);
      setVideos(data);
      prefetch(data);
      setIsOffline(false);
    } catch (e: any) {
      const isNetworkError =
        e.message?.includes("Network request failed") ||
        e.message?.includes("Failed to fetch") ||
        e.message?.includes("timeout") ||
        e.message?.includes("ENOTFOUND");
      if (isNetworkError) {
        setIsOffline(true);
        setFetchErr(true);
      } else {
        setFetchErr(true);
      }
      console.warn("[ForYou] fetch error:", e);
      const stale = await l1Read();
      if (stale && stale.length > 0) setVideos(stale);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setFetchingMore(false);
    }
  }

  const fetchMoreVideos = useCallback(async () => {
    if (fetchingMore || refreshing || isOffline) return;
    setFetchingMore(true);

    fetchMoreTimeout.current = setTimeout(async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_URL}/api/videos/drive/feed`, {
          headers,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: DriveVideo[] = await res.json();

        if (data.length > 0) {
          setVideos((prev) => {
            const existingIds = new Set(prev.map((v) => v.fileId));
            const newVideos = data.filter((v) => !existingIds.has(v.fileId));
            return [...prev, ...newVideos];
          });
          prefetch(data);
        }
      } catch (e) {
        console.warn("[ForYou] fetch more error:", e);
      } finally {
        setFetchingMore(false);
      }
    }, 500);
  }, [fetchingMore, refreshing, isOffline]);

  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: any[] }) => {
      if (viewableItems.length > 0) setActiveIdx(viewableItems[0].index ?? 0);
    },
    [],
  );

  const handleActiveVideoChange = useCallback((id: string) => {
    setActiveVideoId(id);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: DriveVideo; index: number }) => (
      <VideoCard
        item={item}
        isActive={index === activeIdx}
        authHeaders={authHeaders}
        onActiveChange={handleActiveVideoChange}
        isScreenFocused={isScreenFocused}
      />
    ),
    [activeIdx, authHeaders, handleActiveVideoChange, isScreenFocused],
  );

  const renderFooter = () => {
    if (!fetchingMore) return null;
    return (
      <View style={s.footer}>
        <ActivityIndicator size="small" color="#1DB954" />
        <Text style={s.footerText}>Loading more…</Text>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={s.fullCentre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading videos…</Text>
      </View>
    );
  }

  if ((fetchErr || isOffline) && !videos.length) {
    return (
      <View style={s.fullCentre}>
        <Ionicons
          name={isOffline ? "wifi-off-outline" : "wifi-outline"}
          size={52}
          color="#333"
        />
        <Text style={s.noVideoText}>
          {isOffline ? "No internet connection" : "Could not load videos"}
        </Text>
        {!isOffline && (
          <Pressable style={s.retryBtn} onPress={() => refreshManifest(false)}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        )}
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
        onRefresh={() => !isOffline && refreshManifest(true)}
        refreshing={refreshing}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{
          itemVisiblePercentThreshold: 70,
          minimumViewTime: 80,
        }}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        removeClippedSubviews
        getItemLayout={(_, i) => ({ length: H, offset: H * i, index: i })}
        onEndReached={fetchMoreVideos}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
      />
      {isOffline && videos.length > 0 && (
        <View style={s.offlineBanner}>
          <Ionicons name="wifi-off-outline" size={16} color="#fff" />
          <Text style={s.offlineText}>Offline • Showing cached videos</Text>
        </View>
      )}
    </View>
  );
}

// ── Styles: Full-screen video + HUD pushed above bottom tab navigation ────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", paddingTop: 0, paddingBottom: 0 },
  card: {
    width: W,
    height: H,
    backgroundColor: "#0a0a0a",
    overflow: "hidden",
    margin: 0,
    padding: 0,
  },
  video: { position: "absolute", top: 0, left: 0, width: W, height: H },
  tapZone: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 88,
    zIndex: 1,
  },
  centre: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 2,
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
  errorLabel: {
    color: "#FF453A",
    fontSize: 14,
    marginTop: 8,
    fontWeight: "500",
  },
  retryBtn: {
    backgroundColor: "#1DB954",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 4,
    zIndex: 3,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },
  pauseWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 2,
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
    height: 180,
    backgroundColor: "rgba(0,0,0,0.55)",
    zIndex: 3,
  },
  hud: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingBottom: 72,
    zIndex: 4,
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
    zIndex: 5,
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
    zIndex: 10,
  },
  offlineText: { color: "#fff", fontSize: 12, fontWeight: "500" },

  footer: {
    paddingVertical: 20,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.8)",
  },
  footerText: {
    color: "#1DB954",
    fontSize: 12,
    fontWeight: "600",
  },

  playPauseIndicator: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  playPauseCircle: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.4)",
  },
});
