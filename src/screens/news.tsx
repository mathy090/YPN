// src/screens/news.tsx
import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  RefreshControl,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { MMKV } from "react-native-mmkv";
import { WebView } from "react-native-webview";

// ─── MMKV device cache (L1) ───────────────────────────────────────────────────
let _store: MMKV | null = null;
const store = () => {
  if (!_store) _store = new MMKV({ id: "news-cache" });
  return _store;
};
const NEWS_KEY = "zw_news_v2";
const NEWS_TS = "zw_news_ts_v2";
const CACHE_TTL = 20 * 60 * 1000; // 20 minutes — matches backend

const API_URL = process.env.EXPO_PUBLIC_API_URL;

const SOURCES = [
  { key: "all", name: "All", color: "#FFFFFF" },
  { key: "herald", name: "Herald", color: "#C0392B" },
  { key: "newsday", name: "NewsDay", color: "#2980B9" },
  { key: "263chat", name: "263Chat", color: "#27AE60" },
  { key: "zimlive", name: "ZimLive", color: "#8E44AD" },
  { key: "chronicle", name: "Chronicle", color: "#E67E22" },
];

// ─── Types ────────────────────────────────────────────────────────────────────
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

// ─── Device cache helpers ─────────────────────────────────────────────────────
function readCache(): NewsItem[] | null {
  try {
    const ts = store().getNumber(NEWS_TS);
    if (!ts || Date.now() - ts > CACHE_TTL) return null;
    const raw = store().getString(NEWS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(items: NewsItem[]) {
  try {
    store().set(NEWS_KEY, JSON.stringify(items));
    store().set(NEWS_TS, Date.now());
  } catch {}
}

// ─── Relative time ────────────────────────────────────────────────────────────
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── In-app article reader ────────────────────────────────────────────────────
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
        {/* Header */}
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

        {/* WebView — loads article URL fully in-app */}
        <WebView
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: "#111" }}
          onLoadStart={() => setWebLoading(true)}
          onLoadEnd={() => setWebLoading(false)}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState={false}
          // Block popups / redirects to other apps
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

const r = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
    paddingTop:
      Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 44,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
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
  headerTitle: {
    flex: 1,
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
});

// ─── News card ────────────────────────────────────────────────────────────────
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
      activeOpacity={0.85}
    >
      {item.thumbnail ? (
        <Image
          source={{ uri: item.thumbnail }}
          style={s.thumb}
          resizeMode="cover"
        />
      ) : (
        <View style={[s.thumb, s.thumbPlaceholder]}>
          <Ionicons name="newspaper-outline" size={28} color="#444" />
        </View>
      )}
      <View style={s.cardBody}>
        <View style={s.meta}>
          <View style={[s.badge, { backgroundColor: item.sourceColor + "22" }]}>
            <View style={[s.badgeDot, { backgroundColor: item.sourceColor }]} />
            <Text style={[s.badgeText, { color: item.sourceColor }]}>
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
          <Text style={s.readMore}>Read article</Text>
          <Ionicons name="arrow-forward" size={13} color="#1DB954" />
        </View>
      </View>
    </TouchableOpacity>
  ),
);

// ─── Filter bar ───────────────────────────────────────────────────────────────
const FilterBar = ({
  active,
  onSelect,
}: {
  active: string;
  onSelect: (key: string) => void;
}) => (
  <FlatList
    horizontal
    data={SOURCES}
    keyExtractor={(i) => i.key}
    showsHorizontalScrollIndicator={false}
    contentContainerStyle={s.filterRow}
    renderItem={({ item }) => {
      const isActive = active === item.key;
      return (
        <TouchableOpacity
          onPress={() => onSelect(item.key)}
          style={[
            s.filterChip,
            isActive && {
              backgroundColor: item.color,
              borderColor: item.color,
            },
          ]}
          activeOpacity={0.7}
        >
          <Text
            style={[
              s.filterText,
              isActive && {
                color: item.key === "all" ? "#000" : "#fff",
                fontWeight: "700",
              },
            ]}
          >
            {item.name}
          </Text>
        </TouchableOpacity>
      );
    }}
  />
);

// ─── Main screen ──────────────────────────────────────────────────────────────
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;
const TOP_OFFSET = STATUS_H + 48;

export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(false);
  const [reading, setReading] = useState<NewsItem | null>(null);

  // Background refresh timer
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    boot();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  // Schedule next background refresh in 20 min
  const scheduleRefresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => fetchFromBackend(false), CACHE_TTL);
  };

  const boot = async () => {
    // Instant load from device cache
    const cached = readCache();
    if (cached && cached.length > 0) {
      setArticles(cached);
      setLoading(false);
      // Background refresh if cache is older than 20 min
      const ts = store().getNumber(NEWS_TS) ?? 0;
      if (Date.now() - ts > CACHE_TTL) {
        fetchFromBackend(false);
      } else {
        scheduleRefresh();
      }
    } else {
      await fetchFromBackend(false);
    }
  };

  const fetchFromBackend = async (manual = true) => {
    if (manual) setRefreshing(true);
    else if (!articles.length) setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${API_URL}/api/news`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: NewsItem[] = await res.json();
      if (data.length > 0) {
        writeCache(data);
        setArticles(data);
        scheduleRefresh();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filtered =
    filter === "all"
      ? articles
      : articles.filter(
          (a) => a.source === SOURCES.find((src) => src.key === filter)?.name,
        );

  const openArticle = useCallback((item: NewsItem) => setReading(item), []);

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading Zimbabwe news…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {/* Spacer for floating community tab bar */}
      <View style={{ height: TOP_OFFSET }} />

      <FilterBar active={filter} onSelect={setFilter} />

      {error && articles.length === 0 ? (
        <View style={s.centre}>
          <Ionicons name="wifi-outline" size={48} color="#444" />
          <Text style={s.errorText}>Could not load news</Text>
          <TouchableOpacity
            style={s.retryBtn}
            onPress={() => fetchFromBackend(true)}
          >
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <NewsCard item={item} onPress={openArticle} />
          )}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchFromBackend(true)}
              tintColor="#1DB954"
              colors={["#1DB954"]}
            />
          }
          ListEmptyComponent={
            <View style={s.centre}>
              <Text style={s.errorText}>No articles for this source</Text>
            </View>
          }
        />
      )}

      {/* In-app article reader */}
      {reading && (
        <ArticleReader
          url={reading.link}
          title={reading.title}
          onClose={() => setReading(null)}
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    padding: 24,
  },
  loadingText: { color: "#8E8E93", fontSize: 14, marginTop: 8 },
  errorText: { color: "#8E8E93", fontSize: 16, textAlign: "center" },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: "#1DB954",
    borderRadius: 20,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },

  filterRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#333",
    backgroundColor: "#111",
  },
  filterText: { color: "#8E8E93", fontSize: 13, fontWeight: "500" },

  list: { paddingHorizontal: 12, paddingBottom: 120 },

  card: {
    flexDirection: "row",
    backgroundColor: "#111",
    borderRadius: 14,
    marginBottom: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#1E1E1E",
  },
  thumb: { width: 100, height: 110 },
  thumbPlaceholder: {
    backgroundColor: "#1A1A1A",
    justifyContent: "center",
    alignItems: "center",
  },
  cardBody: { flex: 1, padding: 10, justifyContent: "space-between" },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  time: { color: "#555", fontSize: 11 },
  title: { color: "#FFFFFF", fontSize: 14, fontWeight: "600", lineHeight: 20 },
  desc: { color: "#8E8E93", fontSize: 12, lineHeight: 17, marginTop: 4 },
  readRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 6 },
  readMore: { color: "#1DB954", fontSize: 12, fontWeight: "600" },
});
