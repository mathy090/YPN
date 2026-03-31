// src/screens/news.tsx
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  RefreshControl,
  StatusBar as RNStatusBar,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── Config ─────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const CACHE_KEY = "ypn_news_v1";
const CACHE_TS_KEY = "ypn_news_ts_v1";
const CACHE_TTL = 20 * 60 * 1000; // 20 minutes
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

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

// ── Cache helpers ──────────────────────────────────────────────────────────────
async function readCache(): Promise<NewsItem[] | null> {
  try {
    const ts = await AsyncStorage.getItem(CACHE_TS_KEY);
    if (!ts || Date.now() - Number(ts) > CACHE_TTL) return null;
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeCache(items: NewsItem[]) {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(items));
    await AsyncStorage.setItem(CACHE_TS_KEY, String(Date.now()));
  } catch {}
}

// ── Relative time ──────────────────────────────────────────────────────────────
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

// ── Open article in external browser ──────────────────────────────────────────
async function openLink(url: string) {
  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
    }
  } catch (e) {
    console.warn("Could not open URL:", url, e);
  }
}

// ── NewsCard ───────────────────────────────────────────────────────────────────
const NewsCard = React.memo(({ item }: { item: NewsItem }) => (
  <TouchableOpacity
    style={s.card}
    onPress={() => openLink(item.link)}
    activeOpacity={0.75}
  >
    {/* Thumbnail */}
    {item.thumbnail ? (
      <Image
        source={{ uri: item.thumbnail }}
        style={s.thumb}
        resizeMode="cover"
      />
    ) : (
      <View style={[s.thumb, s.thumbPlaceholder]}>
        <Ionicons name="newspaper-outline" size={22} color="#2a2a2a" />
      </View>
    )}

    {/* Body */}
    <View style={s.body}>
      {/* Source + time row */}
      <View style={s.metaRow}>
        <View
          style={[s.sourceBadge, { backgroundColor: item.sourceColor + "18" }]}
        >
          <View style={[s.sourceDot, { backgroundColor: item.sourceColor }]} />
          <Text
            style={[s.sourceText, { color: item.sourceColor }]}
            numberOfLines={1}
          >
            {item.source}
          </Text>
        </View>
        <Text style={s.time}>{relativeTime(item.pubDate)}</Text>
      </View>

      {/* Title */}
      <Text style={s.title} numberOfLines={3}>
        {item.title}
      </Text>

      {/* Description */}
      {item.description ? (
        <Text style={s.desc} numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}

      {/* Read more */}
      <View style={s.readRow}>
        <Text style={s.readMore}>Read more</Text>
        <Ionicons name="open-outline" size={12} color="#1DB954" />
      </View>
    </View>
  </TouchableOpacity>
));

// ── Main screen ────────────────────────────────────────────────────────────────
export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    boot();
  }, []);

  const boot = async () => {
    const cached = await readCache();
    if (cached && cached.length > 0) {
      setArticles(cached);
      setLoading(false);
      // Background refresh
      fetchArticles(false);
    } else {
      await fetchArticles(false);
    }
  };

  const fetchArticles = async (manual: boolean) => {
    if (manual) setRefreshing(true);
    else if (!articles.length) setLoading(true);
    setError(false);

    try {
      const res = await fetch(`${API_URL}/api/news`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: NewsItem[] = await res.json();
      if (!data.length) throw new Error("Empty response");
      await writeCache(data);
      setArticles(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => fetchArticles(true), []);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading news…</Text>
      </View>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (error && !articles.length) {
    return (
      <View style={s.centre}>
        <Ionicons name="wifi-outline" size={48} color="#333" />
        <Text style={s.errorText}>Could not load news</Text>
        <TouchableOpacity
          style={s.retryBtn}
          onPress={() => fetchArticles(false)}
        >
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>News</Text>
        <Text style={s.headerSub}>{articles.length} articles</Text>
      </View>

      {/* Article list */}
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
        {articles.map((item) => (
          <NewsCard key={item.id} item={item} />
        ))}

        <Text style={s.footer}>Pull down to refresh</Text>
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },

  // Header
  header: {
    paddingTop: STATUS_H + 16,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1a1a1a",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  headerSub: {
    color: "#444",
    fontSize: 12,
    marginTop: 2,
  },

  // List
  list: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 120,
  },

  // Card
  card: {
    flexDirection: "row",
    backgroundColor: "#111",
    borderRadius: 12,
    marginBottom: 10,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#1e1e1e",
  },
  thumb: {
    width: 100,
    height: 110,
  },
  thumbPlaceholder: {
    backgroundColor: "#161616",
    justifyContent: "center",
    alignItems: "center",
  },
  body: {
    flex: 1,
    padding: 10,
    justifyContent: "space-between",
  },

  // Meta row
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  sourceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    maxWidth: 130,
  },
  sourceDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    flexShrink: 0,
  },
  sourceText: {
    fontSize: 10,
    fontWeight: "700",
    flexShrink: 1,
  },
  time: {
    color: "#3a3a3a",
    fontSize: 10,
  },

  // Text
  title: {
    color: "#e8e8e8",
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

  // Read more
  readRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
  },
  readMore: {
    color: "#1DB954",
    fontSize: 11,
    fontWeight: "600",
  },

  // States
  centre: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    padding: 24,
  },
  loadingText: { color: "#555", fontSize: 14 },
  errorText: { color: "#555", fontSize: 16, textAlign: "center" },
  retryBtn: {
    backgroundColor: "#1DB954",
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 20,
    marginTop: 4,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },

  footer: {
    color: "#2a2a2a",
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 16,
  },
});
