// src/screens/news.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useRouter } from "expo-router";
import React, { memo, useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const { width: W } = Dimensions.get("window");

// ── Types ─────────────────────────────────────────────────────────────────────
type NewsArticle = {
  id: string;
  title: string;
  link: string;
  pubDate: number;
  source: string;
  sourceColor: string;
  sourceKey: string;
  thumbnail: string | null;
  description: string;
  fetchedAt?: number;
};

// ✅ FIX: Added 'data:' property name below
type NewsResponse = {
  success: boolean;
  count: number;
  cached: boolean;
  data: NewsArticle[];
};

type Source = { key: string; name: string; color: string };
type RouteParams = {
  id: string;
  url: string;
  title?: string;
  source?: string;
  sourceColor?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtDate = (ts: number): string => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString("en-ZW", {
    month: "short",
    day: "numeric",
  });
};

const truncate = (str: string, len: number) =>
  str && str.length > len ? str.slice(0, len - 1) + "…" : str || "";

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchNews(
  selectedSource: string | null,
): Promise<NewsArticle[]> {
  const url = selectedSource
    ? `${API_URL}/api/news/source/${selectedSource}`
    : `${API_URL}/api/news`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as NewsResponse | NewsArticle[];

  if ("data" in json && Array.isArray(json.data)) return json.data;
  if (Array.isArray(json)) return json;
  return [];
}

async function fetchSources(): Promise<Source[]> {
  const res = await fetch(`${API_URL}/api/news/sources`);
  if (!res.ok) return [];
  const json = await res.json();
  return json.success && Array.isArray(json.sources) ? json.sources : [];
}

// ── Components ────────────────────────────────────────────────────────────────
const NewsCard = memo(({ item }: { item: NewsArticle }) => {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={s.card}
      onPress={() =>
        router.push({
          pathname: "/article/[id]",
          params: {
            id: item.id,
            url: encodeURIComponent(item.link),
            title: encodeURIComponent(item.title),
            source: encodeURIComponent(item.source),
            sourceColor: encodeURIComponent(item.sourceColor),
          } as RouteParams,
        })
      }
      activeOpacity={0.7}
    >
      <View style={s.sourceRow}>
        <View style={[s.sourceBadge, { backgroundColor: item.sourceColor }]}>
          <Text style={s.sourceText}>{item.source}</Text>
        </View>
        <Text style={s.dateText}>{fmtDate(item.pubDate)}</Text>
      </View>
      <View style={s.contentRow}>
        {item.thumbnail ? (
          <Image
            source={{ uri: item.thumbnail }}
            style={s.thumbnail}
            resizeMode="cover"
          />
        ) : (
          <View style={[s.thumbnail, s.thumbnailPlaceholder]}>
            <Ionicons name="newspaper-outline" size={32} color="#666" />
          </View>
        )}
        <View style={s.textWrap}>
          <Text style={s.title} numberOfLines={2}>
            {item.title}
          </Text>
          {item.description ? (
            <Text style={s.desc} numberOfLines={3}>
              {truncate(item.description, 150)}
            </Text>
          ) : null}
          <Text style={s.readMore}>Tap to read full article</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
});

const SourceChip = memo(
  ({
    source,
    selected,
    onPress,
  }: {
    source: Source;
    selected: boolean;
    onPress: () => void;
  }) => (
    <Pressable
      style={[
        s.chip,
        selected && {
          backgroundColor: source.color + "20",
          borderColor: source.color,
        },
      ]}
      onPress={onPress}
    >
      <View style={[s.chipDot, { backgroundColor: source.color }]} />
      <Text style={[s.chipText, selected && { color: source.color }]}>
        {source.name}
      </Text>
    </Pressable>
  ),
);

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poorConnection, setPoorConnection] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<{
    cached: boolean;
    count: number;
  } | null>(null);

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      setPoorConnection(
        (state.type === "cellular" &&
          ["2g", "3g"].includes(state.details?.cellularGeneration || "")) ||
          !state.isConnected,
      );
    });
    return () => sub();
  }, []);

  useEffect(() => {
    fetchSources().then(setSources).catch(console.warn);
  }, []);

  const loadNews = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await fetchNews(selectedSource);
        setArticles(data);
        setCacheInfo({ cached: false, count: data.length });
      } catch (e: any) {
        setError(poorConnection ? "Poor connection" : "Failed to load");
        if (!isRefresh) setArticles([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [selectedSource, poorConnection],
  );

  useEffect(() => {
    loadNews();
  }, [loadNews]);

  if (loading && articles.length === 0) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Loading news…</Text>
      </View>
    );
  }

  if (error && articles.length === 0) {
    return (
      <View style={s.center}>
        <Ionicons name="wifi-outline" size={48} color="#666" />
        <Text style={s.errorText}>{error}</Text>
        <Pressable style={s.retryBtn} onPress={() => loadNews()}>
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.headerTitle}>News</Text>
          {cacheInfo && (
            <View style={s.cacheBadge}>
              <Text style={s.cacheText}>{cacheInfo.count} articles</Text>
            </View>
          )}
        </View>
        <Pressable onPress={() => loadNews(true)} hitSlop={10}>
          <Ionicons name="refresh-outline" size={20} color="#1DB954" />
        </Pressable>
      </View>

      {sources.length > 0 && (
        <View style={s.filterWrap}>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.filterList}
            data={sources}
            keyExtractor={(s) => s.key}
            renderItem={({ item }) => (
              <SourceChip
                source={item}
                selected={selectedSource === item.key}
                onPress={() =>
                  setSelectedSource((prev) =>
                    prev === item.key ? null : item.key,
                  )
                }
              />
            )}
          />
        </View>
      )}

      <FlatList
        data={articles}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <NewsCard item={item} />}
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadNews(true)}
            tintColor="#1DB954"
            colors={["#1DB954"]}
          />
        }
        ListEmptyComponent={
          !loading && (
            <View style={s.empty}>
              <Text style={s.emptyText}>No articles found</Text>
            </View>
          )
        }
        removeClippedSubviews={Platform.OS === "android"}
        windowSize={10}
        maxToRenderPerBatch={5}
        updateCellsBatchingPeriod={100}
      />

      {poorConnection && (
        <View style={s.banner}>
          <Ionicons name="warning-outline" size={16} color="#FF9800" />
          <Text style={s.bannerText}>Poor connection</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    gap: 16,
  },
  loadingText: { color: "#888", fontSize: 14 },
  errorText: { color: "#FF453A", fontSize: 16, fontWeight: "600" },
  retryBtn: {
    backgroundColor: "#1DB954",
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: { color: "#000", fontWeight: "700", fontSize: 14 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#0a0a0a",
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  cacheBadge: {
    backgroundColor: "#1a1a1a",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  cacheText: { color: "#1DB954", fontSize: 11, fontWeight: "600" },
  filterWrap: {
    backgroundColor: "#0a0a0a",
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  filterList: { paddingHorizontal: 12, paddingVertical: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "transparent",
    marginRight: 8,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: "#aaa", fontSize: 12, fontWeight: "500" },
  list: { padding: 12 },
  card: {
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#222",
  },
  sourceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  sourceBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  sourceText: { color: "#000", fontSize: 11, fontWeight: "700" },
  dateText: { color: "#666", fontSize: 11 },
  contentRow: { flexDirection: "row", gap: 12 },
  thumbnail: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: "#222",
  },
  thumbnailPlaceholder: { justifyContent: "center", alignItems: "center" },
  textWrap: { flex: 1, gap: 6 },
  title: { color: "#fff", fontSize: 14, fontWeight: "700", lineHeight: 20 },
  desc: { color: "#aaa", fontSize: 12, lineHeight: 18 },
  readMore: { color: "#1DB954", fontSize: 12, fontWeight: "600", marginTop: 4 },
  empty: { alignItems: "center", padding: 40 },
  emptyText: { color: "#666", fontSize: 14 },
  banner: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,152,0,0.15)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,152,0,0.3)",
  },
  bannerText: { color: "#FF9800", fontSize: 12, flex: 1 },
});
