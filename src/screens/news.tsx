// src/screens/news.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  RefreshControl,
  StatusBar as RNStatusBar,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  getSecureCache,
  initializeSecureCache,
  setSecureCache,
} from "../utils/cache";

WebBrowser.maybeCompleteAuthSession();

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// L1 client-side in-memory cache (matches server refresh interval)
const CLIENT_L1_TTL_MS = 60 * 60 * 1000; // 1 hour

// L2 client-side SQLite/SecureStore cache (keeps articles between app restarts)
const CLIENT_L2_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours — matches server archive TTL
const NEWS_CACHE_KEY = "news_manifest_v2";

// ── Types ──────────────────────────────────────────────────────────────────────
type NewsItem = {
  id: string;
  title: string;
  link: string;
  pubDate: number;
  source: string;
  sourceColor: string;
  thumbnail: string | null;
  description: string;
};

// ── L1: Module-level in-memory cache (survives re-renders, cleared on app restart) ──
let _memCache: NewsItem[] | null = null;
let _memCachedAt = 0;

function memRead(): NewsItem[] | null {
  if (!_memCache || Date.now() - _memCachedAt > CLIENT_L1_TTL_MS) return null;
  return _memCache;
}

function memWrite(items: NewsItem[]) {
  _memCache = items;
  _memCachedAt = Date.now();
}

// ── L2: SQLite/SecureStore persistent cache ───────────────────────────────────
async function diskRead(): Promise<NewsItem[] | null> {
  try {
    const data = await getSecureCache(NEWS_CACHE_KEY);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function diskWrite(items: NewsItem[]) {
  try {
    await setSecureCache(NEWS_CACHE_KEY, items, CLIENT_L2_TTL_MS);
  } catch (e) {
    console.warn("[News] Disk cache write failed:", e);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 52) return `${w}w ago`;
  return `${Math.floor(d / 365)}y ago`;
}

async function openArticle(item: NewsItem) {
  try {
    await WebBrowser.openBrowserAsync(item.link, {
      toolbarColor: "#111111",
      controlsColor: "#1DB954",
      showTitle: true,
      enableBarCollapsing: false,
    });
  } catch {
    Alert.alert("Error", "Could not open the article.");
  }
}

// ── NewsCard ───────────────────────────────────────────────────────────────────
const NewsCard = React.memo(
  ({
    item,
    onPress,
  }: {
    item: NewsItem;
    onPress: (item: NewsItem) => void;
  }) => (
    <TouchableOpacity
      style={s.card}
      onPress={() => onPress(item)}
      activeOpacity={0.82}
    >
      {item.thumbnail ? (
        <Image
          source={{ uri: item.thumbnail }}
          style={s.thumb}
          resizeMode="cover"
        />
      ) : (
        <View style={[s.thumb, s.thumbPlaceholder]}>
          <Ionicons name="newspaper-outline" size={24} color="#333" />
        </View>
      )}
      <View style={s.cardBody}>
        <View style={s.meta}>
          <View style={[s.badge, { backgroundColor: item.sourceColor + "1A" }]}>
            <View style={[s.badgeDot, { backgroundColor: item.sourceColor }]} />
            <Text
              style={[s.badgeText, { color: item.sourceColor }]}
              numberOfLines={1}
            >
              {item.source}
            </Text>
          </View>
          <Text style={s.time}>{relativeTime(item.pubDate)}</Text>
        </View>
        <Text style={s.title} numberOfLines={3}>
          {item.title}
        </Text>
        {item.description ? (
          <Text style={s.desc} numberOfLines={2}>
            {item.description}
          </Text>
        ) : null}
        <View style={s.readRow}>
          <Text style={s.readMore}>Read more</Text>
          <Ionicons name="arrow-forward" size={12} color="#1DB954" />
        </View>
      </View>
    </TouchableOpacity>
  ),
);

// ── Main Screen ────────────────────────────────────────────────────────────────
export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  // Track when we last fetched from server to avoid hammering
  const lastFetchRef = useRef(0);

  // ── Initialise ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      await initializeSecureCache();
      await boot();
    };
    init();
  }, []);

  // ── Network listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const connected = !!state.isConnected;
      setIsOffline(!connected);
      // Auto-fetch when coming back online
      if (connected && error) {
        fetchFromServer(false);
      }
    });
    return () => unsub();
  }, [error]);

  // ── Boot: L1 → L2 → network ──────────────────────────────────────────────────
  const boot = async () => {
    // L1: in-memory (instant)
    const mem = memRead();
    if (mem && mem.length > 0) {
      setArticles(mem);
      setLoading(false);
      // Background refresh if stale
      if (Date.now() - lastFetchRef.current > CLIENT_L1_TTL_MS) {
        fetchFromServer(false);
      }
      return;
    }

    // L2: disk cache (fast, survives restarts)
    const disk = await diskRead();
    if (disk && disk.length > 0) {
      memWrite(disk); // hydrate L1
      setArticles(disk);
      setLoading(false);
      // Background refresh — don't block UI
      fetchFromServer(false);
      return;
    }

    // Cold start: no cache — must hit network
    setLoading(true);
    await fetchFromServer(false);
  };

  // ── Fetch from server ─────────────────────────────────────────────────────────
  const fetchFromServer = useCallback(
    async (manual: boolean) => {
      if (isOffline) {
        if (manual) setError(true);
        return;
      }

      if (manual) {
        setRefreshing(true);
      }

      setError(false);

      try {
        const res = await fetch(`${API_URL}/api/news`, {
          // 10s timeout via AbortController
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data: NewsItem[] = await res.json();

        if (data.length > 0) {
          lastFetchRef.current = Date.now();
          // Write to both cache layers
          memWrite(data);
          diskWrite(data); // non-blocking
          setArticles(data);
          setError(false);
        } else if (manual) {
          setError(true);
        }
      } catch (e: any) {
        console.warn("[News] Fetch failed:", e.message);
        if (manual) setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isOffline],
  );

  // ── Pull-to-refresh ───────────────────────────────────────────────────────────
  const onRefresh = useCallback(() => {
    if (!isOffline) fetchFromServer(true);
  }, [isOffline, fetchFromServer]);

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading news…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {/* Status bar spacer */}
      <View
        style={{
          height:
            Platform.OS === "android"
              ? (RNStatusBar.currentHeight || 24) + 48
              : 48,
        }}
      />

      {articles.length > 0 && (
        <View style={s.countRow}>
          <Text style={s.countText}>
            {articles.length} article{articles.length !== 1 ? "s" : ""}{" "}
            available
          </Text>
        </View>
      )}

      {error && articles.length === 0 ? (
        <View style={s.centre}>
          <Ionicons
            name={isOffline ? "wifi-off-outline" : "alert-circle-outline"}
            size={48}
            color="#333"
          />
          <Text style={s.errorText}>
            {isOffline ? "No internet connection" : "Could not load news"}
          </Text>
          {!isOffline && (
            <TouchableOpacity
              style={s.retryBtn}
              onPress={() => fetchFromServer(true)}
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
              onRefresh={onRefresh}
              tintColor="#1DB954"
              colors={["#1DB954"]}
            />
          }
        >
          {articles.length === 0 ? (
            <View style={s.centre}>
              <Text style={s.errorText}>No articles available</Text>
            </View>
          ) : (
            articles.map((item) => (
              <NewsCard key={item.id} item={item} onPress={openArticle} />
            ))
          )}
        </ScrollView>
      )}

      {/* Offline banner when showing cached data */}
      {isOffline && articles.length > 0 && (
        <View style={s.offlineBanner}>
          <Ionicons name="wifi-off-outline" size={16} color="#fff" />
          <Text style={s.offlineText}>Offline — Showing cached news</Text>
        </View>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
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
    flexDirection: "row",
    backgroundColor: "#111",
    borderRadius: 12,
    marginBottom: 10,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#1E1E1E",
  },
  thumb: { width: 96, height: 106 },
  thumbPlaceholder: {
    backgroundColor: "#161616",
    justifyContent: "center",
    alignItems: "center",
  },
  cardBody: { flex: 1, padding: 10, justifyContent: "space-between" },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 5,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    maxWidth: 120,
  },
  badgeDot: { width: 5, height: 5, borderRadius: 3, flexShrink: 0 },
  badgeText: { fontSize: 10, fontWeight: "700", flexShrink: 1 },
  time: { color: "#3A3A3A", fontSize: 10 },
  title: {
    color: "#E8E8E8",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
    flex: 1,
  },
  desc: { color: "#555", fontSize: 11, lineHeight: 16, marginTop: 4 },
  readRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 6 },
  readMore: { color: "#1DB954", fontSize: 11, fontWeight: "600" },
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
