// src/screens/foryou.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import { VideoView, useVideoPlayer } from "expo-video";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const L1_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 45000;
const VIDEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE_MB = 500;
const { width: W, height: H } = Dimensions.get("window");
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

// ── Cache Directory Setup ─────────────────────────────────────────────────────
const CACHE_DIR = `${FileSystem.cacheDirectory}video_cache/`;

const ensureCacheDir = async (): Promise<void> => {
  try {
    const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  } catch (e) {
    console.warn("[CacheDir] creation warning:", e);
  }
};

// ── SQLite Setup ──────────────────────────────────────────────────────────────
const db = SQLite.openDatabaseSync("videoCache.db");

db.execSync(`
  CREATE TABLE IF NOT EXISTS video_cache (
    fileId TEXT PRIMARY KEY,
    streamUrl TEXT,
    name TEXT,
    mimeType TEXT,
    size INTEGER,
    thumbnail TEXT,
    localPath TEXT,
    downloadedAt INTEGER,
    expiresAt INTEGER,
    fileSize INTEGER,
    etag TEXT
  );
`);

db.execSync(`
  CREATE TABLE IF NOT EXISTS playback_state (
    fileId TEXT PRIMARY KEY,
    position REAL DEFAULT 0,
    lastWatched INTEGER,
    duration REAL DEFAULT 0
  );
`);

db.execSync(`
  CREATE INDEX IF NOT EXISTS idx_expires ON video_cache(expiresAt);
  CREATE INDEX IF NOT EXISTS idx_downloaded ON video_cache(downloadedAt);
`);

// ── Types ─────────────────────────────────────────────────────────────────────
type DriveVideo = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnail: string | null;
  streamUrl: string;
  localPath?: string;
};

// ── In-Memory Manifest Cache ──────────────────────────────────────────────────
let _manifestCache: DriveVideo[] | null = null;
let _manifestTs = 0;

function l1Read(): DriveVideo[] | null {
  if (!_manifestCache || Date.now() - _manifestTs > L1_TTL_MS) return null;
  return _manifestCache;
}

// ✅ FIX: Added missing 'data' parameter name
function l1Write(data: DriveVideo[]): void {
  _manifestCache = data;
  _manifestTs = Date.now();
}

// ── SQLite + FileSystem Cache Helpers ─────────────────────────────────────────

async function savePlaybackPosition(
  fileId: string,
  position: number,
  duration: number,
): Promise<void> {
  try {
    await db.runAsync(
      `INSERT OR REPLACE INTO playback_state (fileId, position, lastWatched, duration)
       VALUES (?, ?, ?, ?)`,
      [fileId, position, Date.now(), duration],
    );
  } catch (e) {
    console.warn("[SQLite] save playback error:", e);
  }
}

async function getPlaybackPosition(
  fileId: string,
): Promise<{ position: number; duration: number } | null> {
  try {
    const result = (await db.getFirstAsync(
      "SELECT position, duration FROM playback_state WHERE fileId = ?",
      [fileId],
    )) as { position: number; duration: number } | null;

    if (result) {
      return {
        position: result.position ?? 0,
        duration: result.duration ?? 0,
      };
    }
  } catch (e) {
    console.warn("[SQLite] load playback error:", e);
  }
  return null;
}

async function getCachedVideo(fileId: string): Promise<DriveVideo | null> {
  try {
    const result = (await db.getFirstAsync(
      "SELECT * FROM video_cache WHERE fileId = ? AND expiresAt > ?",
      [fileId, Date.now()],
    )) as any;

    if (result?.localPath) {
      const fileInfo = await FileSystem.getInfoAsync(result.localPath);
      if (fileInfo.exists) {
        return {
          fileId: result.fileId,
          name: result.name,
          mimeType: result.mimeType,
          size: result.size,
          thumbnail: result.thumbnail,
          streamUrl: result.localPath,
          localPath: result.localPath,
        };
      }
    }
  } catch (e) {
    console.warn("[SQLite] read error:", e);
  }
  return null;
}

async function cacheVideoMetadata(
  video: DriveVideo,
  localPath?: string,
  ttlMs: number = VIDEO_CACHE_TTL_MS,
): Promise<void> {
  try {
    let fileSize = 0;
    if (localPath) {
      const info = await FileSystem.getInfoAsync(localPath);
      fileSize = info.size ?? 0;
    }

    await db.runAsync(
      `INSERT OR REPLACE INTO video_cache 
       (fileId, streamUrl, name, mimeType, size, thumbnail, localPath, downloadedAt, expiresAt, fileSize)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        video.fileId,
        video.streamUrl,
        video.name,
        video.mimeType,
        video.size,
        video.thumbnail,
        localPath ?? null,
        Date.now(),
        Date.now() + ttlMs,
        fileSize,
      ],
    );
  } catch (e) {
    console.warn("[SQLite] write error:", e);
  }
}

async function downloadVideo(video: DriveVideo): Promise<string | null> {
  try {
    await ensureCacheDir();
    const fileName = `${video.fileId}.mp4`;
    const localPath = `${CACHE_DIR}${fileName}`;

    const cached = await getCachedVideo(video.fileId);
    if (cached?.localPath) return cached.localPath;

    await cleanupCacheIfNeeded();

    const downloadResumable = FileSystem.createDownloadResumable(
      video.streamUrl,
      localPath,
      {
        cache: true,
        headers: { "Cache-Control": "public, max-age=604800" },
      },
    );

    const result = await downloadResumable.downloadAsync();
    return result?.uri ?? null;
  } catch (e: any) {
    console.warn(`[Download] failed for ${video.fileId}:`, e?.message);
    const partialPath = `${CACHE_DIR}${video.fileId}.mp4`;
    try {
      const info = await FileSystem.getInfoAsync(partialPath);
      if (info.exists) {
        await FileSystem.deleteAsync(partialPath, { idempotent: true });
      }
    } catch {}
    return null;
  }
}

async function cleanupCacheIfNeeded(): Promise<void> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!dirInfo.exists) return;

    const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
    let totalSize = 0;

    for (const file of files) {
      const info = await FileSystem.getInfoAsync(`${CACHE_DIR}${file}`);
      if (info.exists && info.size) totalSize += info.size;
    }

    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

    if (totalSize > maxSizeBytes) {
      const oldEntries = (await db.getAllAsync(
        "SELECT fileId, localPath FROM video_cache ORDER BY downloadedAt ASC LIMIT 10",
      )) as Array<{ fileId: string; localPath: string }>;

      for (const entry of oldEntries) {
        if (entry.localPath) {
          await FileSystem.deleteAsync(entry.localPath, { idempotent: true });
        }
        await db.runAsync("DELETE FROM video_cache WHERE fileId = ?", [
          entry.fileId,
        ]);
      }
    }

    await db.runAsync("DELETE FROM video_cache WHERE expiresAt < ?", [
      Date.now(),
    ]);
  } catch (e) {
    console.warn("[Cache cleanup] error:", e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (secs: number): string => {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── ProgressBar ───────────────────────────────────────────────────────────────
const ProgressBar = memo(
  ({
    pos,
    dur,
    onSeek,
  }: {
    pos: number;
    dur: number;
    onSeek: (ratio: number) => void;
  }) => {
    const barRef = useRef<View>(null);
    const ratio = dur > 0 ? Math.min(pos / dur, 1) : 0;

    return (
      <Pressable
        ref={barRef}
        onPress={(e) => {
          if (!barRef.current) return;
          barRef.current.measure((_x, _y, width: number) => {
            const r = Math.min(Math.max(e.nativeEvent.locationX / width, 0), 1);
            onSeek(r);
          });
        }}
        hitSlop={{ top: 18, bottom: 18 }}
        style={pb.track}
      >
        <View style={[pb.fill, { width: `${ratio * 100}%` }]} />
        <View style={[pb.thumb, { left: `${ratio * 100}%` }]} />
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
type VideoCardProps = {
  item: DriveVideo;
  isActive: boolean;
  isScreenFocused: boolean;
  savedPosition?: number;
  onReportPosition?: (
    fileId: string,
    position: number,
    duration: number,
  ) => void;
  onPlayerReady?: (fileId: string, player: any) => void;
  onPlayerCleanup?: (fileId: string) => void;
};

const VideoCard = memo(
  ({
    item,
    isActive,
    isScreenFocused,
    savedPosition,
    onReportPosition,
    onPlayerReady,
    onPlayerCleanup,
  }: VideoCardProps) => {
    const [paused, setPaused] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string>("");
    const [pos, setPos] = useState(savedPosition ?? 0);
    const [dur, setDur] = useState(0);
    const pollRef = useRef<NodeJS.Timeout | null>(null);
    const isLocal = !!item.localPath;
    const hasRestoredRef = useRef(false);
    const playerIdRef = useRef(item.fileId);

    const player = useVideoPlayer(item.streamUrl, (p) => {
      p.loop = true;
      p.muted = false;
    });

    // Report player ready to parent
    useEffect(() => {
      if (onPlayerReady) {
        onPlayerReady(playerIdRef.current, player);
      }
      return () => {
        if (onPlayerCleanup) {
          onPlayerCleanup(playerIdRef.current);
        }
      };
    }, [onPlayerReady, onPlayerCleanup, player]);

    // Restore position when player is ready (only once)
    useEffect(() => {
      if (
        savedPosition != null &&
        savedPosition > 0 &&
        !hasRestoredRef.current &&
        isActive
      ) {
        const sub = player.addListener("statusChange", ({ status }) => {
          if (status === "readyToPlay") {
            hasRestoredRef.current = true;
            player.currentTime = savedPosition;
            setPos(savedPosition);
            player.play();
            setPaused(false);
            setLoading(false);
          }
        });
        return () => sub.remove();
      }
    }, [savedPosition, isActive, player]);

    // Status listener
    useEffect(() => {
      const sub = player.addListener(
        "statusChange",
        ({ status, error: err }) => {
          if (status === "readyToPlay" && loading) {
            if (!hasRestoredRef.current) {
              setLoading(false);
              const d = player.duration;
              if (d && d > 0) setDur(d);
            }
          }
          if (status === "error") {
            if (!error) {
              setError(true);
              setErrorMsg(err?.message ?? "Playback error");
              setLoading(false);
              console.warn("[VideoCard] player error:", err?.message);
            }
          }
        },
      );
      return () => sub.remove();
    }, [player, loading, error]);

    // Poll position + auto-save every 5 seconds while active
    useEffect(() => {
      if (!isActive || !isScreenFocused) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        return;
      }

      pollRef.current = setInterval(() => {
        try {
          const ct = player.currentTime ?? 0;
          const d = player.duration ?? 0;
          setPos(ct);
          if (d > 0) setDur(d);
          if (ct > 0 && onReportPosition && Math.abs(ct - pos) >= 1) {
            onReportPosition(playerIdRef.current, ct, d);
          }
        } catch {
          // player may not be initialised yet
        }
      }, 5000);

      return () => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      };
    }, [isActive, isScreenFocused, player, onReportPosition, pos]);

    // Pause/resume based on screen focus AND card visibility
    useEffect(() => {
      try {
        if (isActive && isScreenFocused) {
          if (
            !hasRestoredRef.current ||
            savedPosition == null ||
            savedPosition <= 0
          ) {
            player.play();
            setPaused(false);
          }
        } else {
          const ct = player.currentTime ?? 0;
          const d = player.duration ?? 0;
          if (ct > 0 && onReportPosition) {
            onReportPosition(playerIdRef.current, ct, d);
          }
          player.pause();
          setPaused(true);
          hasRestoredRef.current = false;
        }
      } catch {
        // player not ready yet
      }
    }, [isActive, isScreenFocused, player, onReportPosition, savedPosition]);

    const togglePlay = () => {
      try {
        if (paused) {
          player.play();
          setPaused(false);
        } else {
          player.pause();
          setPaused(true);
        }
      } catch {}
    };

    const onSeek = (ratio: number) => {
      try {
        const target = ratio * dur;
        player.currentTime = target;
        setPos(target);
        if (onReportPosition)
          onReportPosition(playerIdRef.current, target, dur);
      } catch {}
    };

    const displayName = item.name.replace(/\.[^.]+$/, "");

    return (
      <View style={s.card}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
        />

        <Pressable style={s.tapZone} onPress={togglePlay} />

        {loading && !error && (
          <View style={s.centre} pointerEvents="none">
            <ActivityIndicator size="large" color="#1DB954" />
            {isLocal && <Text style={s.loadingText}>Playing from cache</Text>}
            {savedPosition != null && savedPosition > 0 && (
              <Text style={s.loadingText}>
                Resuming from {fmt(savedPosition)}
              </Text>
            )}
          </View>
        )}

        {error && (
          <View style={s.centre} pointerEvents="none">
            <Ionicons name="alert-circle-outline" size={52} color="#FF453A" />
            <Text style={s.errorLabel}>
              {errorMsg.toLowerCase().includes("timeout") ||
              errorMsg.toLowerCase().includes("socket") ||
              errorMsg.toLowerCase().includes("network")
                ? "Poor internet connection"
                : "Could not load video"}
            </Text>
            <Text style={s.errorSubLabel}>
              Move to area with better connection
            </Text>
            {isLocal && (
              <Text style={s.errorSubLabel}>Cached version unavailable</Text>
            )}
          </View>
        )}

        {paused && !loading && !error && (
          <View style={s.pauseWrap} pointerEvents="none">
            <View style={s.pauseCircle}>
              <Ionicons name="pause" size={38} color="#fff" />
            </View>
          </View>
        )}

        <View style={s.scrim} pointerEvents="none" />
        <View style={s.hud} pointerEvents="box-none">
          <Text style={s.title} numberOfLines={2}>
            {displayName}{" "}
            {isLocal && <Text style={s.cacheBadge}>• Cached</Text>}
          </Text>
          <View style={s.timeRow} pointerEvents="none">
            <Text style={s.timeText}>{fmt(pos)}</Text>
            {dur > 0 && <Text style={s.timeText}>{fmt(dur)}</Text>}
          </View>
          <View style={s.progressWrap}>
            <ProgressBar pos={pos} dur={dur} onSeek={onSeek} />
          </View>
        </View>
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
  const [poorConnection, setPoorConnection] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const flatRef = useRef<FlatList<DriveVideo>>(null);
  const preloadQueue = useRef<Set<string>>(new Set());
  const isFocused = useIsFocused();

  const playerRefs = useRef<Map<string, any>>(new Map());
  const positionCache = useRef<
    Map<string, { position: number; duration: number }>
  >(new Map());

  // 🌐 Network status listener
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isPoor =
        (state.type === "cellular" &&
          (state.details?.cellularGeneration === "2g" ||
            state.details?.cellularGeneration === "3g")) ||
        state.type === "unknown" ||
        state.type === "none" ||
        state.isConnected === false;
      setPoorConnection(isPoor);
    });
    return () => unsubscribe();
  }, []);

  // Initialize cache directory on mount
  useEffect(() => {
    ensureCacheDir().catch(() => {});
    cleanupCacheIfNeeded().catch(() => {});
  }, []);

  useEffect(() => {
    boot();
  }, []);

  async function boot(): Promise<void> {
    const cached = l1Read();
    if (cached && cached.length > 0) {
      setVideos(cached);
      setLoading(false);
      refreshManifest(false).catch(() => {});
      return;
    }
    await refreshManifest(false);
  }

  async function refreshManifest(manual: boolean): Promise<void> {
    if (manual) setRefreshing(true);
    setFetchErr(false);

    try {
      const res = await fetchWithTimeout(
        `${API_URL}/api/videos/drive/feed`,
        FETCH_TIMEOUT_MS,
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const rawData = await res.json();
      if (!Array.isArray(rawData) || rawData.length === 0) {
        throw new Error("Empty or invalid manifest");
      }

      const data: DriveVideo[] = await Promise.all(
        rawData.map(async (v: any) => {
          const streamUrl = `${API_URL}/api/videos/drive/stream/${v.fileId}`;
          const cached = await getCachedVideo(v.fileId);
          return {
            fileId: v.fileId,
            name: v.name ?? "Video",
            mimeType: v.mimeType ?? "video/mp4",
            size: v.size ?? null,
            thumbnail: v.thumbnail ?? null,
            streamUrl: cached?.localPath ?? streamUrl,
            localPath: cached?.localPath,
          };
        }),
      );

      l1Write(data);
      setVideos(data);

      for (const video of data) {
        await cacheVideoMetadata(video, video.localPath);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        console.warn("[ForYou] fetch timed out");
      } else {
        console.warn("[ForYou] fetch failed:", e?.message);
      }
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

  // Pause ALL videos when screen loses focus
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (activeIdx >= 0 && activeIdx < videos.length) {
          const video = videos[activeIdx];
          const cached = positionCache.current.get(video.fileId);
          if (cached) {
            savePlaybackPosition(
              video.fileId,
              cached.position,
              cached.duration,
            );
          }
        }
        playerRefs.current.forEach((player) => {
          try {
            player.pause();
          } catch {}
        });
      };
    }, [activeIdx, videos]),
  );

  // Resume active video when screen regains focus
  useEffect(() => {
    if (isFocused && activeIdx >= 0 && activeIdx < videos.length) {
      const video = videos[activeIdx];
      const player = playerRefs.current.get(video.fileId);
      if (player) {
        try {
          player.play();
        } catch {}
      }
    }
  }, [isFocused, activeIdx, videos]);

  // 🎬 Preload next 2 videos
  useEffect(() => {
    const preloadNext = async () => {
      for (let offset = 1; offset <= 2; offset++) {
        const idx = activeIdx + offset;
        if (idx < videos.length) {
          const video = videos[idx];
          if (preloadQueue.current.has(video.fileId)) continue;
          if (video.localPath) continue;

          preloadQueue.current.add(video.fileId);

          try {
            const localPath = await downloadVideo(video);
            if (localPath) {
              await cacheVideoMetadata(video, localPath);
              setVideos((prev) =>
                prev.map((v) =>
                  v.fileId === video.fileId
                    ? { ...v, streamUrl: localPath, localPath }
                    : v,
                ),
              );
            }
          } catch (e) {
            console.warn(`[Preload] failed for ${video.fileId}:`, e);
          } finally {
            preloadQueue.current.delete(video.fileId);
          }
        }
      }
    };
    preloadNext();
  }, [activeIdx, videos]);

  // Load saved positions for all videos on mount
  useEffect(() => {
    let mounted = true;
    const loadPositions = async () => {
      for (const video of videos) {
        const saved = await getPlaybackPosition(video.fileId);
        if (saved?.position != null && saved.position > 0 && mounted) {
          positionCache.current.set(video.fileId, saved);
        }
      }
    };
    if (videos.length > 0) {
      loadPositions();
    }
    return () => {
      mounted = false;
    };
  }, [videos]);

  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ index?: number }> }) => {
      if (viewableItems.length > 0) {
        const idx = viewableItems[0].index ?? 0;
        if (idx !== activeIdx) {
          setActiveIdx(idx);
        }
      }
    },
    [activeIdx],
  );

  const viewCfg = useRef({
    itemVisiblePercentThreshold: 60,
    minimumViewTime: 100,
  });

  const handleReportPosition = useCallback(
    (fileId: string, position: number, duration: number) => {
      positionCache.current.set(fileId, { position, duration });
      savePlaybackPosition(fileId, position, duration).catch(() => {});
    },
    [],
  );

  const handlePlayerReady = useCallback((fileId: string, player: any) => {
    playerRefs.current.set(fileId, player);
  }, []);

  const handlePlayerCleanup = useCallback((fileId: string) => {
    playerRefs.current.delete(fileId);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: DriveVideo; index: number }) => {
      const cachedPos = positionCache.current.get(item.fileId);
      return (
        <VideoCard
          item={item}
          isActive={index === activeIdx}
          isScreenFocused={isFocused}
          savedPosition={cachedPos?.position}
          onReportPosition={handleReportPosition}
          onPlayerReady={handlePlayerReady}
          onPlayerCleanup={handlePlayerCleanup}
        />
      );
    },
    [
      activeIdx,
      isFocused,
      handleReportPosition,
      handlePlayerReady,
      handlePlayerCleanup,
    ],
  );

  if (loading) {
    return (
      <View style={s.fullCentre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading videos…</Text>
      </View>
    );
  }

  if (fetchErr && videos.length === 0) {
    return (
      <View style={s.fullCentre}>
        <Ionicons name="wifi-outline" size={52} color="#333" />
        <Text style={s.noVideoText}>
          {poorConnection
            ? "Poor internet connection"
            : "Could not load videos"}
        </Text>
        <Text style={s.errorSubLabel}>Move to area with better connection</Text>
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
        windowSize={6}
        maxToRenderPerBatch={3}
        initialNumToRender={1}
        removeClippedSubviews={Platform.OS === "android"}
        getItemLayout={(_, i) => ({ length: H, offset: H * i, index: i })}
      />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
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
  errorSubLabel: {
    color: "#aaa",
    fontSize: 12,
    marginTop: 4,
    textAlign: "center",
  },
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
  progressWrap: {
    marginBottom: 60,
  },
  cacheBadge: {
    color: "#1DB954",
    fontSize: 13,
    fontWeight: "600",
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
    marginBottom: 20,
  },
  timeText: { color: "#fff", fontSize: 11, fontWeight: "600" },
});
