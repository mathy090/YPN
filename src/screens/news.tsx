// src/screens/news.tsx
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  RefreshControl,
  StatusBar as RNStatusBar,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL;
const NEWS_KEY = "zw_news_v3";
const NEWS_TS = "zw_news_ts_v3";
const CACHE_TTL = 20 * 60 * 1000; // 20 minutes

// ✅ REMOVED: SOURCE_FILTERS array (no longer needed)

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

// ── AsyncStorage cache helpers ─────────────────────────────────────────────────
async function readCache(): Promise<NewsItem[] | null> {
  try {
    const tsRaw = await AsyncStorage.getItem(NEWS_TS);
    const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
    if (!ts || Date.now() - ts > CACHE_TTL) return null;
    const raw = await AsyncStorage.getItem(NEWS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeCache(items: NewsItem[]) {
  try {
    await AsyncStorage.setItem(NEWS_KEY, JSON.stringify(items));
    await AsyncStorage.setItem(MK_TS, Date.now().toString());
  } catch {}
}

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

// ── In-app reader ───────────────────────────────────────────────────────────────
function ArticleReader({
  url,
  title,
  onClose,
}: {
  url: string;
  title: string;
  onClose: () => void;
}) {
  const [webLoading, setWebLoading] = useState(true);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={r.root}>
        <View style={r.header}>
          <TouchableOpacity
            onPress={onClose}
            style={r.closeBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={r.headerTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <WebView
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: "#111" }}
          onLoadStart={() => setWebLoading(true)}
          onLoadEnd={() => setWebLoading(false)}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
        />
        {webLoading && (
          <View style={r.loadingOverlay}>
            <ActivityIndicator size="large" color="#1DB954" />
          </View>
        )}
      </View>
    </Modal>
  );
}

const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;
const TOP_OFFSET = STATUS_H + 48;

const r = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", paddingTop: TOP_OFFSET },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
    backgroundColor: "#111",
    gap: 10,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#222",
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: { flex: 1, color: "#fff", fontSize: 15, fontWeight: "600" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
});

// ── News card ───────────────────────────────────────────────────────────────────
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

// ✅ REMOVED: FilterBar component entirely

// ── Main screen ─────────────────────────────────────────────────────────────────
export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // ✅ REMOVED: filter state and logic
  const [error, setError] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [reading, setReading] = useState<NewsItem | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Network listener
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOffline(!state.isConnected);
      if (state.isConnected && error) fetchFromBackend(false);
    });
    return () => unsub();
  }, [error]);

  useEffect(() => {
    boot();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const scheduleRefresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => fetchFromBackend(false), CACHE_TTL);
  };

  const boot = async () => {
    if (isOffline) {
      const cached = await readCache();
      if (cached?.length) {
        setArticles(cached);
        setLoading(false);
        return;
      }
      setError(true);
      setLoading(false);
      return;
    }
    const cached = await readCache();
    if (cached?.length) {
      setArticles(cached);
      setLoading(false);
      const tsRaw = await AsyncStorage.getItem(NEWS_TS);
      const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
      if (Date.now() - ts > CACHE_TTL) fetchFromBackend(false);
      else scheduleRefresh();
    } else {
      await fetchFromBackend(false);
    }
  };

  const fetchFromBackend = async (manual = true) => {
    if (isOffline) {
      setError(true);
      return;
    }
    if (manual) setRefreshing(true);
    else if (!articles.length) setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${API_URL}/api/news`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: NewsItem[] = await res.json();
      if (data.length > 0) {
        await writeCache(data);
        setArticles(data);
        scheduleRefresh();
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // ✅ Show all articles directly (no filtering)
  const openArticle = useCallback((item: NewsItem) => setReading(item), []);

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
      <View style={{ height: TOP_OFFSET }} />

      {/* ✅ REMOVED: <FilterBar active={filter} onSelect={setFilter} /> */}

      {/* ✅ Article count badge (now at very top of content) */}
      {articles.length > 0 && (
        <View style={s.countRow}>
          <Text style={s.countText}>
            {articles.length} article{articles.length !== 1 ? "s" : ""}{" "}
            available
          </Text>
        </View>
      )}

      {(error || isOffline) && articles.length === 0 ? (
        <View style={s.centre}>
          <Ionicons
            name={isOffline ? "wifi-off-outline" : "wifi-outline"}
            size={48}
            color="#333"
          />
          <Text style={s.errorText}>
            {isOffline ? "No internet connection" : "Could not load news"}
          </Text>
          {!isOffline && (
            <TouchableOpacity
              style={s.retryBtn}
              onPress={() => fetchFromBackend(true)}
            >
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        // ✅ ScrollView with all articles
        <ScrollView
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => !isOffline && fetchFromBackend(true)}
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

      {reading && (
        <ArticleReader
          url={reading.link}
          title={reading.title}
          onClose={() => setReading(null)}
        />
      )}

      {isOffline && articles.length > 0 && (
        <View style={s.offlineBanner}>
          <Ionicons name="wifi-off-outline" size={16} color="#fff" />
          <Text style={s.offlineText}>Offline • Showing cached news</Text>
        </View>
      )}
    </View>
  );
}

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
  // ✅ REMOVED: filterRow, filterChip, filterText styles
  countRow: { paddingHorizontal: 16, paddingBottom: 6 },
  countText: { color: "#3A3A3A", fontSize: 11 },
  list: { paddingHorizontal: 12, paddingBottom: 120 },
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
