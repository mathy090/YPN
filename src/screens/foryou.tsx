// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { Audio, AVPlaybackStatus } from "expo-av";
import { Directory, File } from "expo-file-system/next";
import { Video } from "expo-video";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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
import { MMKV } from "react-native-mmkv";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const PREFETCH_COUNT = 3;
const L1_TTL_MS = 60 * 60 * 1000; // 1 hour
const { width: W, height: H } = Dimensions.get("window");
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

// Tab bar base height (matches tabs/_layout.tsx: 56 + insets.bottom)
const TAB_BAR_BASE = 56;

// ── MMKV store ────────────────────────────────────────────────────────────────
let _store: MMKV | null = null;
const store = () => {
  if (!_store) _store = new MMKV({ id: "ypn-drive-feed-v3" });
  return _store;
};
const MK_DATA = "manifest_v3";
const MK_TS = "manifest_ts_v3";
const MK_LP = (id: string) => `lp_${id}`;

// ── Types ─────────────────────────────────────────────────────────────────────
type DriveVideo = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
};

// ── MMKV helpers ──────────────────────────────────────────────────────────────
function l1Read(): DriveVideo[] | null {
  try {
    const ts = store().getNumber(MK_TS);
    if (!ts || Date.now() - ts > L1_TTL_MS) return null;
    const raw = store().getString(MK_DATA);
    return raw ? (JSON.parse(raw) as DriveVideo[]) : null;
  } catch {
    return null;
  }
}

function l1Write(data: DriveVideo[]) {
  try {
    store().set(MK_DATA, JSON.stringify(data));
    store().set(MK_TS, Date.now());
  } catch {}
}

// ── Local file cache (new expo-file-system API) ───────────────────────────────
const LOCAL_DIR_NAME = "ypn_drive_v3";

function getLocalDir(): Directory {
  return new Directory(
    `${require("expo-file-system/next").Paths.cache}/${LOCAL_DIR_NAME}/`,
  );
}

function getFilePath(id: string): File {
  return new File(
    `${require("expo-file-system/next").Paths.cache}/${LOCAL_DIR_NAME}/${id}.mp4`,
  );
}

async function ensureDir() {
  const dir = getLocalDir();
  if (!dir.exists) dir.create();
}

function readLP(id: string): string | null {
  return store().getString(MK_LP(id)) ?? null;
}

function saveLP(id: string, path: string) {
  store().set(MK_LP(id), path);
}

async function isFileCached(id: string): Promise<boolean> {
  const p = readLP(id);
  if (!p) return false;
  return new File(p).exists;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
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

// ── Prefetch first N videos to local cache ────────────────────────────────────
async function prefetch(videos: DriveVideo[]) {
  await ensureDir();
  for (const v of videos.slice(0, PREFETCH_COUNT)) {
    try {
      if (await isFileCached(v.fileId)) continue;
      const destFile = getFilePath(v.fileId);
      const headers = await getAuthHeaders();
      const response = await fetch(streamUrl(v.fileId), { headers });
      if (response.ok) {
        const blob = await response.blob();
        const reader = new FileReader();
        await new Promise<void>((resolve, reject) => {
          reader.onloadend = () => {
            try {
              const base64 = (reader.result as string).split(",")[1];
              destFile.write(base64);
              saveLP(v.fileId, destFile.uri);
              resolve();
            } catch (e) {
              reject(e);
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch {}
  }
}

// ── Time formatter ────────────────────────────────────────────────────────────
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

// ── VideoCard ─────────────────────────────────────────────────────────────────
const VideoCard = React.memo(
  ({
    item,
    isActive,
    isFocused,
    authHeaders,
    bottomOffset,
  }: {
    item: DriveVideo;
    isActive: boolean;
    isFocused: boolean;
    authHeaders: Record<string, string>;
    bottomOffset: number;
  }) => {
    const ref = useRef<Video>(null);
    const [paused, setPaused] = useState(false);
    const [loading, setLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [pos, setPos] = useState(0);
    const [dur, setDur] = useState(0);
    const [localPath, setLocalPath] = useState<string | null>(null);

    // Animated opacity for the play/pause icon — fades out after tap
    const iconOpacity = useRef(new Animated.Value(0)).current;
    const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Check local cache once on mount
    useEffect(() => {
      isFileCached(item.fileId).then((ok) => {
        if (ok) setLocalPath(readLP(item.fileId));
      });
    }, [item.fileId]);

    // Pause instantly when tab loses focus (navigating away)
    // Resume when tab regains focus and card is active
    useEffect(() => {
      if (!ref.current) return;
      if (!isFocused) {
        // navigated away — pause immediately, no reset
        ref.current.pauseAsync?.().catch(() => {});
        setPaused(true);
        return;
      }
      // tab is focused again
      if (isActive) {
        ref.current.playAsync?.().catch(() => {});
        setPaused(false);
      }
    }, [isFocused]);

    // Handle card becoming active/inactive within the feed
    useEffect(() => {
      if (!ref.current) return;
      if (!isFocused) return; // don't fight with the focus effect above
      if (isActive) {
        setPaused(false);
        ref.current.playAsync?.().catch(() => {});
      } else {
        setPaused(true);
        ref.current.pauseAsync?.().catch(() => {});
        ref.current.setPositionAsync?.(0).catch(() => {});
        setPos(0);
        setLoading(true);
        setHasError(false);
      }
    }, [isActive]);

    // Show icon briefly then fade out
    const flashIcon = useCallback(() => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      iconOpacity.setValue(1);
      fadeTimer.current = setTimeout(() => {
        Animated.timing(iconOpacity, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }).start();
      }, 600);
    }, [iconOpacity]);

    const togglePlay = useCallback(() => {
      if (!ref.current) return;
      if (paused) {
        ref.current.playAsync?.().catch(() => {});
        setPaused(false);
      } else {
        ref.current.pauseAsync?.().catch(() => {});
        setPaused(true);
      }
      flashIcon();
    }, [paused, flashIcon]);

    const onStatus = useCallback((status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;
      setLoading(false);
      setPos(status.positionMillis ?? 0);
      setDur(status.durationMillis ?? 0);
    }, []);

    const onSeek = useCallback((ms: number) => {
      ref.current?.setPositionAsync?.(ms).catch(() => {});
      setPos(ms);
    }, []);

    const source = localPath
      ? { uri: localPath }
      : { uri: streamUrl(item.fileId), headers: authHeaders };

    const displayName = item.name.replace(/\.[^.]+$/, "");

    // Which icon to show — pause when playing, play when paused
    const overlayIcon = paused ? "play" : "pause";

    return (
      <View style={s.card}>
        <Video
          ref={ref}
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          shouldPlay={isActive && isFocused && !paused}
          isLooping
          isMuted={false}
          onPlaybackStatusUpdate={onStatus}
          onError={() => {
            setLoading(false);
            setHasError(true);
          }}
        />

        {/* Full-screen tap to pause/play */}
        <Pressable style={s.tapZone} onPress={togglePlay} />

        {/* Buffering */}
        {loading && !hasError && (
          <View style={s.centre} pointerEvents="none">
            <ActivityIndicator size="large" color="#1DB954" />
          </View>
        )}

        {/* Error state */}
        {hasError && (
          <View style={s.centre} pointerEvents="none">
            <Ionicons name="alert-circle-outline" size={52} color="#FF453A" />
            <Text style={s.errorLabel}>Could not load video</Text>
          </View>
        )}

        {/* Play/Pause flash icon — fades in on tap, then fades out */}
        <Animated.View
          style={[s.iconWrap, { opacity: iconOpacity }]}
          pointerEvents="none"
        >
          <View style={s.iconCircle}>
            <Ionicons name={overlayIcon} size={26} color="#fff" />
          </View>
        </Animated.View>

        {/* Scrim — tall enough to cover the whole HUD area */}
        <View
          style={[s.scrim, { height: 160 + bottomOffset }]}
          pointerEvents="none"
        />

        {/* HUD — progress bar sits just above the tab bar */}
        <View
          style={[s.hud, { bottom: bottomOffset + 12 }]}
          pointerEvents="box-none"
        >
          <Text style={s.title} numberOfLines={2}>
            {displayName}
          </Text>
          <View style={s.timeRow} pointerEvents="none">
            <Text style={s.timeText}>{fmt(pos)}</Text>
            {dur > 0 && <Text style={s.timeText}>{fmt(dur)}</Text>}
          </View>
          <ProgressBar pos={pos} dur={dur} onSeek={onSeek} />
        </View>

        {/* Offline badge */}
        {localPath != null && (
          <View style={s.badge} pointerEvents="none">
            <Ionicons name="cloud-done-outline" size={12} color="#1DB954" />
          </View>
        )}
      </View>
    );
  },
);

// ── Main screen ───────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const insets = useSafeAreaInsets();
  const [videos, setVideos] = useState<DriveVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchErr, setFetchErr] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});
  const [isFocused, setIsFocused] = useState(true);
  const flatRef = useRef<FlatList>(null);

  // How far above the screen bottom the HUD sits:
  // tab bar (56) + safe area bottom inset + 8px breathing room
  const bottomOffset = TAB_BAR_BASE + insets.bottom + 8;

  // Instantly pause all videos when navigating away, resume on return
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => {
        setIsFocused(false);
      };
    }, []),
  );

  // Init audio + get auth headers once
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
      const headers = await getAuthHeaders();
      setAuthHeaders(headers);

      const res = await fetch(`${API_URL}/api/videos/drive/feed`, { headers });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: DriveVideo[] = await res.json();
      if (!data.length) throw new Error("Empty manifest from server");

      l1Write(data);
      setVideos(data);
      prefetch(data);
    } catch (e) {
      console.warn("[ForYou] fetch error:", e);
      const stale = l1Read();
      if (stale && stale.length > 0) {
        setVideos(stale);
      } else {
        setFetchErr(true);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: any[] }) => {
      if (viewableItems.length > 0) {
        setActiveIdx(viewableItems[0].index ?? 0);
      }
    },
    [],
  );

  const viewCfg = useRef({
    itemVisiblePercentThreshold: 70,
    minimumViewTime: 80,
  });

  const renderItem = useCallback(
    ({ item, index }: { item: DriveVideo; index: number }) => (
      <VideoCard
        item={item}
        isActive={index === activeIdx}
        isFocused={isFocused}
        authHeaders={authHeaders}
        bottomOffset={bottomOffset}
      />
    ),
    [activeIdx, isFocused, authHeaders, bottomOffset],
  );

  if (loading) {
    return (
      <View style={s.fullCentre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading videos…</Text>
      </View>
    );
  }

  if (fetchErr && !videos.length) {
    return (
      <View style={s.fullCentre}>
        <Ionicons name="wifi-outline" size={52} color="#333" />
        <Text style={s.noVideoText}>Could not load videos</Text>
        <Pressable style={s.retryBtn} onPress={() => refreshManifest(false)}>
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
        onRefresh={() => refreshManifest(true)}
        refreshing={refreshing}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewCfg.current}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        removeClippedSubviews
        getItemLayout={(_, i) => ({ length: H, offset: H * i, index: i })}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },

  card: {
    width: W,
    height: H,
    backgroundColor: "#0a0a0a",
    overflow: "hidden",
  },

  tapZone: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 88,
  },

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

  // Small centred icon that flashes on tap then fades
  iconWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(0,0,0,0.50)",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.25)",
    justifyContent: "center",
    alignItems: "center",
  },

  // height is set inline per-card via bottomOffset
  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },

  // bottom is set inline per-card via bottomOffset
  hud: {
    position: "absolute",
    left: 0,
    right: 0,
    paddingHorizontal: 16,
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
