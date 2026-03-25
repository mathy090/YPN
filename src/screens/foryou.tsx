// src/screens/foryou.tsx
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Platform,
  Share,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MMKV } from 'react-native-mmkv';
import VideoPlayer from '../components/VideoPlayer';
import { auth } from '../firebase/auth';

// MMKV instance — stored on device, survives app kills
const mmkv = new MMKV({ id: 'foryou-cache' });
const MMKV_KEY = 'foryou_feed_v1';
const MMKV_TS_KEY = 'foryou_feed_ts_v1';
const MMKV_TTL = 60 * 60 * 1000; // 1 hour — matches backend TTL

const { width: W, height: H } = Dimensions.get('window');
const BOTTOM_TAB_HEIGHT = 86;
const STATUS_BAR_H = Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 24) : 0;
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ── MMKV helpers ──────────────────────────────────────────────────────────────
function readCache(): VideoItem[] | null {
  try {
    const ts = mmkv.getNumber(MMKV_TS_KEY);
    if (!ts || Date.now() - ts > MMKV_TTL) return null;
    const raw = mmkv.getString(MMKV_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as VideoItem[];
  } catch {
    return null;
  }
}

function writeCache(videos: VideoItem[]) {
  try {
    mmkv.set(MMKV_KEY, JSON.stringify(videos));
    mmkv.set(MMKV_TS_KEY, Date.now());
  } catch { }
}

function clearCache() {
  mmkv.delete(MMKV_KEY);
  mmkv.delete(MMKV_TS_KEY);
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

// ── Hardcoded fallback — shown only if both MMKV and backend fail ─────────────
const FALLBACK: VideoItem[] = [
  {
    videoId: 'X6-jQFdQHUY',
    title: 'Youth Empowerment — Find Your Purpose',
    channelTitle: 'YPN Zimbabwe',
    thumbnail: 'https://img.youtube.com/vi/X6-jQFdQHUY/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=X6-jQFdQHUY',
    viewCount: null, likeCount: null, commentCount: null,
  },
  {
    videoId: 'ugcSDR_Z0sA',
    title: 'Mental Health Tips for Young People',
    channelTitle: 'Mental Health Africa',
    thumbnail: 'https://img.youtube.com/vi/ugcSDR_Z0sA/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=ugcSDR_Z0sA',
    viewCount: null, likeCount: null, commentCount: null,
  },
  {
    videoId: 'ZmWBrN7QV6Y',
    title: 'How to Build Skills for the Future',
    channelTitle: 'Education Hub',
    thumbnail: 'https://img.youtube.com/vi/ZmWBrN7QV6Y/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=ZmWBrN7QV6Y',
    viewCount: null, likeCount: null, commentCount: null,
  },
];

// ── Number formatter ──────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

// ── Retry on 503 (Render cold start) ─────────────────────────────────────────
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

// ── Stat pill ─────────────────────────────────────────────────────────────────
const Stat = ({ icon, value, color = '#fff' }: { icon: string; value: string; color?: string }) => (
  <View style={s.statPill}>
    <Ionicons name={icon as any} size={14} color={color} />
    <Text style={[s.statText, { color }]}>{value}</Text>
  </View>
);

// ── Single video card ─────────────────────────────────────────────────────────
const VideoCard = React.memo(({
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
    try { await Share.share({ message: `${item.title}\n${item.url}` }); } catch { }
  }, [item]);

  return (
    <View style={s.card}>
      {playing ? (
        <VideoPlayer videoId={item.videoId} onClose={() => setPlaying(false)} />
      ) : (
        <>
          <TouchableOpacity activeOpacity={0.92} onPress={handlePlay} style={StyleSheet.absoluteFill}>
            <Image source={{ uri: item.thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            <View style={s.scrimTop} />
            <View style={s.scrimBottom} />
            <View style={s.playWrap} pointerEvents="none">
              <View style={s.playCircle}>
                <Ionicons name="play" size={30} color="#fff" />
              </View>
            </View>
          </TouchableOpacity>

          {/* LEFT actions */}
          <View style={s.actions}>
            <TouchableOpacity onPress={() => setLiked((p) => !p)} style={s.actionBtn}>
              <Ionicons
                name={liked ? 'heart' : 'heart-outline'}
                size={30}
                color={liked ? '#FF3B57' : '#fff'}
              />
              <Text style={s.actionLabel}>
                {fmt(liked ? (item.likeCount ?? 0) + 1 : item.likeCount)}
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

          {/* Info above bottom tab bar */}
          <View style={s.info}>
            <View style={s.channelRow}>
              <View style={s.channelDot} />
              <Text style={s.channelText} numberOfLines={1}>{item.channelTitle}</Text>
            </View>
            <Text style={s.titleText} numberOfLines={2}>{item.title}</Text>
            <View style={s.statsRow}>
              <Stat icon="eye-outline" value={fmt(item.viewCount)} />
              <Stat icon="heart-outline" value={fmt(item.likeCount)} color="#FF3B57" />
              <Stat icon="chatbubble-outline" value={fmt(item.commentCount)} />
            </View>
          </View>
        </>
      )}
    </View>
  );
});

// ── Main screen ───────────────────────────────────────────────────────────────
// Cache strategy:
//   1. Read MMKV immediately → show feed with zero loading spinner
//   2. If MMKV is fresh (< 1h), skip network call entirely
//   3. If stale / missing, fetch from backend in background,
//      update MMKV + state when done
//   4. If backend fails, keep showing MMKV data (or FALLBACK as last resort)

export default function ForYouScreen() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);       // true only on first ever load
  const [refreshing, setRefreshing] = useState(false); // pull-to-refresh spinner
  const [cacheSource, setCacheSource] = useState<'live' | 'device' | 'saved' | null>(null);
  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    bootFeed();
  }, []);

  /** Called once on mount. Shows MMKV instantly, refreshes if stale. */
  const bootFeed = async () => {
    const cached = readCache();
    if (cached && cached.length > 0) {
      setVideos(cached);
      setCacheSource('device');
      setLoading(false);
      // Still refresh in the background if > 30 min old
      const ts = mmkv.getNumber(MMKV_TS_KEY) ?? 0;
      if (Date.now() - ts > 30 * 60 * 1000) {
        backgroundRefresh();
      }
    } else {
      // No device cache at all — must fetch
      await fetchFeed(false);
    }
  };

  /** Silent background refresh — does NOT show a spinner */
  const backgroundRefresh = async () => {
    try {
      const data = await fetchFromBackend();
      if (data.length > 0) {
        writeCache(data);
        setVideos(data);
        setCacheSource('live');
      }
    } catch {
      // Already showing device cache — just leave it
    }
  };

  /** Full refresh (pull-to-refresh or manual retry) */
  const fetchFeed = async (isManual = true) => {
    if (isManual) setRefreshing(true);
    else setLoading(true);

    try {
      const data = await fetchFromBackend();
      if (data.length > 0) {
        writeCache(data);
        setVideos(data);
        setCacheSource('live');
      } else {
        fallback();
      }
    } catch {
      // Try device cache first
      const cached = readCache();
      if (cached && cached.length > 0) {
        setVideos(cached);
        setCacheSource('device');
      } else {
        fallback();
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const fallback = () => {
    setVideos(FALLBACK);
    setCacheSource('saved');
  };

  /** Raw network call to backend */
  const fetchFromBackend = async (): Promise<VideoItem[]> => {
    const uid = auth?.currentUser?.uid ?? 'anonymous';
    const res = await fetchWithRetry(
      `${API_URL}/api/videos/foryou`,
      { headers: { 'x-user-uid': uid } },
      3,
      3000,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  };

  const markWatched = useCallback(async (videoId: string) => {
    try {
      const uid = auth?.currentUser?.uid;
      if (!uid) return;
      await fetch(`${API_URL}/api/videos/watched`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': uid },
        body: JSON.stringify({ videoId }),
      });
    } catch { }
  }, []);

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading your feed…</Text>
      </View>
    );
  }

  const bannerConfig = {
    live: null,
    device: { icon: 'flash-outline', color: '#1DB954', text: 'Feed loaded from device' },
    saved: { icon: 'bookmark-outline', color: '#FFD60A', text: 'Showing saved videos — pull to refresh' },
  };
  const banner = cacheSource ? bannerConfig[cacheSource] : null;

  return (
    <View style={s.root}>
      {banner && (
        <View style={[s.banner, { backgroundColor: `${banner.color}18`, borderBottomColor: `${banner.color}33` }]}>
          <Ionicons name={banner.icon as any} size={13} color={banner.color} />
          <Text style={[s.bannerText, { color: banner.color }]}>{banner.text}</Text>
        </View>
      )}

      <FlatList
        ref={flatRef}
        data={videos}
        keyExtractor={(v) => v.videoId}
        renderItem={({ item }) => <VideoCard item={item} onWatched={markWatched} />}
        pagingEnabled
        snapToInterval={H}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onRefresh={() => fetchFeed(true)}
        refreshing={refreshing}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centre: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000', gap: 12 },
  loadingText: { color: '#8E8E93', fontSize: 14 },

  card: { width: W, height: H, backgroundColor: '#111', overflow: 'hidden' },

  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: H * 0.22, backgroundColor: 'rgba(0,0,0,0.32)' },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: H * 0.55, backgroundColor: 'rgba(0,0,0,0.58)' },

  playWrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  playCircle: {
    width: 70, height: 70, borderRadius: 35,
    backgroundColor: 'rgba(0,0,0,0.48)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.65)',
    justifyContent: 'center', alignItems: 'center', paddingLeft: 4,
  },

  actions: { position: 'absolute', left: 14, bottom: BOTTOM_TAB_HEIGHT + 110, alignItems: 'center', gap: 20 },
  actionBtn: { alignItems: 'center', gap: 3 },
  actionLabel: {
    color: '#fff', fontSize: 11, fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },

  info: { position: 'absolute', left: 62, right: 14, bottom: BOTTOM_TAB_HEIGHT + 14, gap: 5 },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  channelDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#1DB954', flexShrink: 0 },
  channelText: {
    color: '#1DB954', fontSize: 13, fontWeight: '700', flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  titleText: {
    color: '#fff', fontSize: 15, fontWeight: '700', lineHeight: 21,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6,
  },

  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  statPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: {
    color: '#fff', fontSize: 12, fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },

  banner: {
    position: 'absolute', top: STATUS_BAR_H, left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 7,
  },
  bannerText: { fontSize: 12 },
});