// src/screens/foryou.tsx
//
// TikTok-style full-screen vertical feed.
//
// Key changes vs previous version:
//  • Card height = full device height (edge-to-edge, no gaps)
//  • Actions moved to RIGHT side (TikTok style), vertically stacked
//  • Info text (channel + title + stats) sits at bottom-left, above the tab bar
//  • Error 143 fix: autoplay is NOT in the initial embed URL on Android.
//    Instead we use a JS injection after load to start playback, which bypasses
//    the Android WebView media-config restriction that causes Error 143.
//  • Two-layer cache: MMKV (L1, device) + backend (L2, network)

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
import { WebView } from 'react-native-webview';
import { auth } from '../firebase/auth';

// ─── Constants ────────────────────────────────────────────────────────────────
// Lazy singleton — MMKV requires the native bridge to be ready.
// Instantiating at module-level crashes on cold start before the bridge mounts.
let _mmkv: MMKV | null = null;
function getMMKV(): MMKV {
  if (!_mmkv) _mmkv = new MMKV({ id: 'foryou-cache' });
  return _mmkv;
}

const MMKV_KEY = 'foryou_feed_v1';
const MMKV_TS_KEY = 'foryou_feed_ts_v1';
const MMKV_TTL = 60 * 60 * 1000; // 1 hour

const { width: W, height: H } = Dimensions.get('window');

// Bottom tab bar height — keep in sync with tabs/_layout.tsx
const BOTTOM_TAB_H = 86 + 16; // height + bottom offset

// Height of the floating community tab bar
const TOP_NAV_H = 48 + (Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 24) : 44);

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ─── MMKV helpers ─────────────────────────────────────────────────────────────
function readCache(): VideoItem[] | null {
  try {
    const store = getMMKV();
    const ts = store.getNumber(MMKV_TS_KEY);
    if (!ts || Date.now() - ts > MMKV_TTL) return null;
    const raw = store.getString(MMKV_KEY);
    return raw ? (JSON.parse(raw) as VideoItem[]) : null;
  } catch {
    return null;
  }
}

function writeCache(videos: VideoItem[]) {
  try {
    const store = getMMKV();
    store.set(MMKV_KEY, JSON.stringify(videos));
    store.set(MMKV_TS_KEY, Date.now());
  } catch {}
}

// ─── Types ────────────────────────────────────────────────────────────────────
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

// ─── Fallback ─────────────────────────────────────────────────────────────────
const FALLBACK: VideoItem[] = [
  {
    videoId: 'X6-jQFdQHUY',
    title: 'Youth Empowerment — Find Your Purpose',
    channelTitle: 'YPN Zimbabwe',
    thumbnail: 'https://img.youtube.com/vi/X6-jQFdQHUY/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=X6-jQFdQHUY',
    viewCount: null,
    likeCount: null,
    commentCount: null,
  },
  {
    videoId: 'ugcSDR_Z0sA',
    title: 'Mental Health Tips for Young People',
    channelTitle: 'Mental Health Africa',
    thumbnail: 'https://img.youtube.com/vi/ugcSDR_Z0sA/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=ugcSDR_Z0sA',
    viewCount: null,
    likeCount: null,
    commentCount: null,
  },
  {
    videoId: 'ZmWBrN7QV6Y',
    title: 'How to Build Skills for the Future',
    channelTitle: 'Education Hub',
    thumbnail: 'https://img.youtube.com/vi/ZmWBrN7QV6Y/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=ZmWBrN7QV6Y',
    viewCount: null,
    likeCount: null,
    commentCount: null,
  },
];

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

// ─── Retry fetch ──────────────────────────────────────────────────────────────
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

// ─── Inline video player ──────────────────────────────────────────────────────
// Error 143 fix for Android:
//   • Initial embed URL does NOT include autoplay=1
//   • After the WebView finishes loading we inject JS to call playVideo()
//     This bypasses Android's restrictive media-config policy that rejects
//     autoplay requests made inside the iframe src (Error 143 / PlayerError)
//   • On iOS, autoplay in the URL still works fine so we keep it
const buildEmbedHtml = (videoId: string) => {
  const isAndroid = Platform.OS === 'android';
  const autoplayParam = isAndroid ? '0' : '1';

  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <style>
      *{margin:0;padding:0;background:#000;box-sizing:border-box}
      html,body{width:100%;height:100%;overflow:hidden}
      iframe{width:100%;height:100%;border:none;display:block}
    </style>
  </head>
  <body>
    <iframe
      id="player"
      src="https://www.youtube.com/embed/${videoId}?autoplay=${autoplayParam}&playsinline=1&rel=0&modestbranding=1&enablejsapi=1&origin=https://ypn.app"
      allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;fullscreen"
      allowfullscreen
    ></iframe>
    <script>
      var player = document.getElementById('player');
      var played = false;

      // ── Android autoplay workaround ──────────────────────────────────────
      function tryPlay() {
        if (played) return;
        played = true;
        player.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*'
        );
      }
      setTimeout(tryPlay, 800);
      document.addEventListener('touchend', tryPlay, { once: true });

      // ── Forward YouTube player errors to React Native ────────────────────
      // Error codes we care about:
      //   2   = invalid videoId
      //   5   = HTML5 player error
      //   100 = video not found / private
      //   101 = embedding disabled (same as 153 in some contexts)
      //   150 = embedding disabled (alternate code)
      //   153 = embedding disabled
      window.addEventListener('message', function(e) {
        try {
          var data = JSON.parse(e.data);
          // YouTube IFrame API sends {event:"infoDelivery", info:{playerState, ...}}
          if (data.event === 'infoDelivery' && data.info) {
            var err = data.info.error;
            if (err) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'YT_ERROR', code: err }));
            }
          }
          // Also catch onError event format
          if (data.event === 'onError') {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'YT_ERROR', code: data.info }));
          }
        } catch(_) {}
      });
    </script>
  </body>
</html>\`;
};

// ─── Video card ───────────────────────────────────────────────────────────────
const VideoCard = React.memo(
  ({
    item,
    isActive,
    onWatched,
    onSkip,
  }: {
    item: VideoItem;
    isActive: boolean;
    onWatched: (id: string) => void;
    onSkip: (videoId: string) => void;
  }) => {
    const [liked, setLiked] = useState(false);
    const [playing, setPlaying] = useState(false);
    const webViewRef = useRef<any>(null);

    // Auto-play when card scrolls into view; pause when it leaves
    useEffect(() => {
      if (isActive) {
        setPlaying(true);
        onWatched(item.videoId);
      } else {
        setPlaying(false);
      }
    }, [isActive]);

    const handleShare = useCallback(async () => {
      try {
        await Share.share({ message: `${item.title}\n${item.url}` });
      } catch {}
    }, [item]);

    return (
      <View style={s.card}>
        {/* ── Video / Thumbnail ── */}
        {playing ? (
          <WebView
            ref={webViewRef}
            source={{ html: buildEmbedHtml(item.videoId) }}
            style={StyleSheet.absoluteFill}
            allowsInlineMediaPlayback
            // Android: must be true to allow JS-triggered autoplay
            mediaPlaybackRequiresUserAction={false}
            allowsFullscreenVideo
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['*']}
            // Suppress the yellow box warning on Android about mixed content
            mixedContentMode="always"
            onMessage={(e) => {
              try {
                const msg = JSON.parse(e.nativeEvent.data);
                if (msg.type === 'YT_ERROR') {
                  // 101/150/153 = embedding disabled — skip silently
                  // 100 = private/deleted — skip silently
                  const skipCodes = [2, 5, 100, 101, 150, 153];
                  if (skipCodes.includes(msg.code)) {
                    console.warn(\`[Player] Error \${msg.code} on \${item.videoId} — skipping\`);
                    onSkip(item.videoId);
                  }
                }
              } catch (_) {}
            }}
          />
        ) : (
          <TouchableOpacity
            activeOpacity={0.95}
            style={StyleSheet.absoluteFill}
            onPress={() => {
              setPlaying(true);
              onWatched(item.videoId);
            }}
          >
            <Image
              source={{ uri: item.thumbnail }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
            />
            <View style={s.scrimTop} />
            <View style={s.scrimBottom} />
            {/* Play button */}
            <View style={s.playWrap} pointerEvents="none">
              <View style={s.playCircle}>
                <Ionicons name="play" size={32} color="#fff" />
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* ── Gradient scrims (always on top) ── */}
        {playing && (
          <>
            <View style={s.scrimTop} pointerEvents="none" />
            <View style={s.scrimBottom} pointerEvents="none" />
          </>
        )}

        {/* ── RIGHT side action buttons (TikTok style) ── */}
        <View style={s.actions} pointerEvents="box-none">
          {/* Like */}
          <TouchableOpacity
            onPress={() => setLiked((p) => !p)}
            style={s.actionBtn}
            activeOpacity={0.7}
          >
            <Ionicons
              name={liked ? 'heart' : 'heart-outline'}
              size={32}
              color={liked ? '#FF3B57' : '#fff'}
            />
            <Text style={s.actionLabel}>
              {fmt(liked ? (item.likeCount ?? 0) + 1 : item.likeCount)}
            </Text>
          </TouchableOpacity>

          {/* Share */}
          <TouchableOpacity
            onPress={handleShare}
            style={s.actionBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="share-social-outline" size={29} color="#fff" />
            <Text style={s.actionLabel}>Share</Text>
          </TouchableOpacity>

          {/* Comments placeholder */}
          <TouchableOpacity style={s.actionBtn} activeOpacity={0.7}>
            <Ionicons name="chatbubble-outline" size={29} color="#fff" />
            <Text style={s.actionLabel}>{fmt(item.commentCount)}</Text>
          </TouchableOpacity>
        </View>

        {/* ── Bottom info (channel + title + stats) ── */}
        <View style={s.info} pointerEvents="none">
          <View style={s.channelRow}>
            <View style={s.channelDot} />
            <Text style={s.channelText} numberOfLines={1}>
              {item.channelTitle}
            </Text>
          </View>
          <Text style={s.titleText} numberOfLines={2}>
            {item.title}
          </Text>
          <View style={s.statsRow}>
            <View style={s.statPill}>
              <Ionicons name="eye-outline" size={13} color="#fff" />
              <Text style={s.statText}>{fmt(item.viewCount)}</Text>
            </View>
            <View style={s.statPill}>
              <Ionicons name="heart-outline" size={13} color="#FF3B57" />
              <Text style={[s.statText, { color: '#FF3B57' }]}>
                {fmt(item.likeCount)}
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  },
);

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function ForYouScreen() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cacheSource, setCacheSource] = useState<'live' | 'device' | 'saved' | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    bootFeed();
  }, []);

  const bootFeed = async () => {
    const cached = readCache();
    if (cached && cached.length > 0) {
      setVideos(cached);
      setCacheSource('device');
      setLoading(false);
      const ts = getMMKV().getNumber(MMKV_TS_KEY) ?? 0;
      if (Date.now() - ts > 30 * 60 * 1000) backgroundRefresh();
    } else {
      await fetchFeed(false);
    }
  };

  const backgroundRefresh = async () => {
    try {
      const data = await fetchFromBackend();
      if (data.length > 0) {
        writeCache(data);
        setVideos(data);
        setCacheSource('live');
      }
    } catch {}
  };

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

  // Remove a video from the feed if the player reports an error (e.g. 153)
  const skipVideo = useCallback((videoId: string) => {
    setVideos((prev) => prev.filter((v) => v.videoId !== videoId));
  }, []);

  const markWatched = useCallback(async (videoId: string) => {
    try {
      const uid = auth?.currentUser?.uid;
      if (!uid) return;
      await fetch(`${API_URL}/api/videos/watched`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-uid': uid },
        body: JSON.stringify({ videoId }),
      });
    } catch {}
  }, []);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: any[] }) => {
      if (viewableItems.length > 0) {
        setActiveIndex(viewableItems[0].index ?? 0);
      }
    },
    [],
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 });

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
    saved: {
      icon: 'bookmark-outline',
      color: '#FFD60A',
      text: 'Showing saved videos — pull to refresh',
    },
  } as const;
  const banner = cacheSource && cacheSource !== 'live' ? bannerConfig[cacheSource] : null;

  return (
    <View style={s.root}>
      {/* Cache banner — shown briefly above the floating nav */}
      {banner && (
        <View
          style={[
            s.banner,
            {
              top: TOP_NAV_H + 4,
              backgroundColor: `${banner.color}18`,
              borderBottomColor: `${banner.color}33`,
            },
          ]}
          pointerEvents="none"
        >
          <Ionicons name={banner.icon as any} size={13} color={banner.color} />
          <Text style={[s.bannerText, { color: banner.color }]}>{banner.text}</Text>
        </View>
      )}

      <FlatList
        ref={flatRef}
        data={videos}
        keyExtractor={(v) => v.videoId}
        renderItem={({ item, index }) => (
          <VideoCard
            item={item}
            isActive={index === activeIndex}
            onWatched={markWatched}
            onSkip={skipVideo}
          />
        )}
        pagingEnabled
        // Snap each card to exactly the full screen height
        snapToInterval={H}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onRefresh={() => fetchFeed(true)}
        refreshing={refreshing}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig.current}
        // Render one extra card above and below for smoother swiping
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={2}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centre: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    gap: 12,
  },
  loadingText: { color: '#8E8E93', fontSize: 14 },

  // Full-screen card — covers the entire display including under nav bars
  card: {
    width: W,
    height: H,
    backgroundColor: '#111',
    overflow: 'hidden',
  },

  // Gradient overlays for legibility
  scrimTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: H * 0.25,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  scrimBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: H * 0.5,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },

  // Play button centred overlay
  playWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 4,
  },

  // ── RIGHT side actions (TikTok style) ──────────────────────────
  actions: {
    position: 'absolute',
    right: 12,
    // Sit above the bottom tab bar with comfortable padding
    bottom: BOTTOM_TAB_H + 80,
    alignItems: 'center',
    gap: 22,
  },
  actionBtn: { alignItems: 'center', gap: 3 },
  actionLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // ── Bottom info block ───────────────────────────────────────────
  // Left edge to just before the action buttons
  info: {
    position: 'absolute',
    left: 14,
    right: 70, // leave room for the right-side actions column
    bottom: BOTTOM_TAB_H + 20,
    gap: 5,
  },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  channelDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#1DB954',
    flexShrink: 0,
  },
  channelText: {
    color: '#1DB954',
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  titleText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  statPill: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Cache source banner
  banner: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  bannerText: { fontSize: 12 },
});