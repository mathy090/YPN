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

// ─── MMKV device cache ────────────────────────────────────────────────────────
let _store: MMKV | null = null;
const store = () => {
  if (!_store) _store = new MMKV({ id: "news-cache" });
  return _store;
};
const NEWS_KEY = "zw_news_v3";
const NEWS_TS = "zw_news_ts_v3";
const CACHE_TTL = 20 * 60 * 1000; // 20 minutes

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ─── Source filter chips ──────────────────────────────────────────────────────
// "All" + source names that map to article.source field
const SOURCE_FILTERS = [
  { key: "all", name: "All", color: "#FFFFFF" },
  { key: "Zimbabwe News", name: "Zim News", color: "#1DB954" },
  { key: "Empowerment", name: "Empowerment", color: "#57F287" },
  { key: "Mental Health", name: "Mental Health", color: "#5865F2" },
  { key: "Jobs & Economy", name: "Jobs", color: "#FEE75C" },
  { key: "Education", name: "Education", color: "#EB459E" },
  { key: "Herald", name: "Herald", color: "#C0392B" },
  { key: "NewsDay", name: "NewsDay", color: "#2980B9" },
  { key: "263Chat", name: "263Chat", color: "#27AE60" },
  { key: "ZimLive", name: "ZimLive", color: "#8E44AD" },
  { key: "Africa Youth", name: "Africa", color: "#FF7043" },
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

// ─── Relative time — handles old articles too ────────────────────────────────
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
  const y = Math.floor(d / 365);
  return `${y}y ago`;
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
  root: {
    flex: 1,
    backgroundColor: "#000",
    paddingTop: TOP_OFFSET,
  },
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
    data={SOURCE_FILTERS}
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
              backgroundColor: item.color + "22",
              borderColor: item.color,
            },
          ]}
          activeOpacity={0.7}
        >
          <Text
            style={[
              s.filterText,
              isActive && { color: item.color, fontWeight: "700" },
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
export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(false);
  const [reading, setReading] = useState<NewsItem | null>(null);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const cached = readCache();
    if (cached && cached.length > 0) {
      setArticles(cached);
      setLoading(false);
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

  // Filter by source name — "all" shows everything including historical
  const filtered =
    filter === "all" ? articles : articles.filter((a) => a.source === filter);

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

      <FilterBar active={filter} onSelect={setFilter} />

      {/* Article count indicator */}
      {articles.length > 0 && (
        <View style={s.countRow}>
          <Text style={s.countText}>
            {filtered.length} article{filtered.length !== 1 ? "s" : ""}
            {filter !== "all" ? ` · ${filter}` : ""}
          </Text>
        </View>
      )}

      {error && articles.length === 0 ? (
        <View style={s.centre}>
          <Ionicons name="wifi-outline" size={48} color="#333" />
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

  filterRow: { paddingHorizontal: 12, paddingVertical: 8, gap: 7 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2A2A2A",
    backgroundColor: "#111",
  },
  filterText: { color: "#555", fontSize: 12, fontWeight: "500" },

  countRow: {
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
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
  cardBody: {
    flex: 1,
    padding: 10,
    justifyContent: "space-between",
  },
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
  desc: {
    color: "#555",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
  },
  readRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 6,
  },
  readMore: { color: "#1DB954", fontSize: 11, fontWeight: "600" },
});
