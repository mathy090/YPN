// src/screens/news.tsx
//
// Zimbabwe News Feed — pulls RSS from 5 sources in parallel.
// Parses XML client-side (no backend needed).
// MMKV L1 cache with 30-min TTL.
// Tap article → expo-web-browser in-app browser.

import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
  RefreshControl,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { MMKV } from "react-native-mmkv";

// ─── MMKV lazy singleton ───────────────────────────────────────────────────────
let _store: MMKV | null = null;
const store = () => {
  if (!_store) _store = new MMKV({ id: "news-cache" });
  return _store;
};
const NEWS_KEY = "zw_news_v1";
const NEWS_TS = "zw_news_ts_v1";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = [
  {
    key: "herald",
    name: "Herald",
    color: "#C0392B",
    url: "https://www.herald.co.zw/feed/",
  },
  {
    key: "newsday",
    name: "NewsDay",
    color: "#2980B9",
    url: "https://www.newsday.co.zw/feed/",
  },
  {
    key: "263chat",
    name: "263Chat",
    color: "#27AE60",
    url: "https://263chat.com/feed/",
  },
  {
    key: "zimlive",
    name: "ZimLive",
    color: "#8E44AD",
    url: "https://www.zimlive.com/feed/",
  },
  {
    key: "chronicle",
    name: "Chronicle",
    color: "#E67E22",
    url: "https://www.chronicle.co.zw/feed/",
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type NewsItem = {
  id: string;
  title: string;
  link: string;
  pubDate: number; // timestamp ms
  source: string;
  sourceColor: string;
  thumbnail: string | null;
  description: string;
};

// ─── XML parser ───────────────────────────────────────────────────────────────
// Lightweight regex-based RSS parser — no external deps needed.

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["']`, "i"));
  return m ? m[1] : "";
}

function extractThumbnail(itemXml: string): string | null {
  // 1. media:content url
  let url = extractAttr(itemXml, "media:content", "url");
  if (url) return url;
  // 2. media:thumbnail url
  url = extractAttr(itemXml, "media:thumbnail", "url");
  if (url) return url;
  // 3. enclosure url (type image/*)
  const enc = itemXml.match(
    /<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i,
  );
  if (enc) return enc[1];
  // 4. first <img src in description
  const img = itemXml.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) return img[1];
  return null;
}

function parseRSS(xml: string, source: (typeof SOURCES)[0]): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRx = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRx.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link =
      extractTag(block, "link") || extractAttr(block, "link", "href");
    const pub = extractTag(block, "pubDate");
    const desc = extractTag(block, "description").slice(0, 160);

    if (!title || !link) continue;

    const ts = pub ? new Date(pub).getTime() : Date.now();

    items.push({
      id: `${source.key}-${link}`,
      title,
      link,
      pubDate: isNaN(ts) ? Date.now() : ts,
      source: source.name,
      sourceColor: source.color,
      thumbnail: extractThumbnail(block),
      description: desc,
    });
  }

  return items;
}

// ─── Fetch one RSS source ─────────────────────────────────────────────────────
async function fetchSource(source: (typeof SOURCES)[0]): Promise<NewsItem[]> {
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": "YPN-App/1.0 (RSS Reader)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSS(xml, source);
  } catch (err) {
    console.warn(`[News] ${source.name} failed:`, err);
    return [];
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
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

// ─── News card ────────────────────────────────────────────────────────────────
const NewsCard = React.memo(({ item }: { item: NewsItem }) => {
  const openArticle = useCallback(async () => {
    await WebBrowser.openBrowserAsync(item.link, {
      toolbarColor: "#111111",
      controlsColor: "#FFFFFF",
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
    });
  }, [item.link]);

  return (
    <TouchableOpacity style={s.card} onPress={openArticle} activeOpacity={0.85}>
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
        {/* Source badge + time */}
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
          <Text style={s.readMore}>Read more</Text>
          <Ionicons name="arrow-forward" size={13} color="#8E8E93" />
        </View>
      </View>
    </TouchableOpacity>
  );
});

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
    data={[{ key: "all", name: "All", color: "#FFFFFF" }, ...SOURCES]}
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
// Leave room for community floating tab bar
const TOP_OFFSET = STATUS_H + 48;

export default function NewsScreen() {
  const [articles, setArticles] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(false);

  useEffect(() => {
    boot();
  }, []);

  const boot = async () => {
    const cached = readCache();
    if (cached && cached.length > 0) {
      setArticles(cached);
      setLoading(false);
      // Background refresh if older than 10 min
      const ts = store().getNumber(NEWS_TS) ?? 0;
      if (Date.now() - ts > 10 * 60 * 1000) fetchAll(false);
    } else {
      await fetchAll(false);
    }
  };

  const fetchAll = async (manual = true) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError(false);

    try {
      const results = await Promise.all(SOURCES.map(fetchSource));
      const merged = results
        .flat()
        .filter(Boolean)
        // Deduplicate by id
        .filter(
          (item, idx, arr) => arr.findIndex((a) => a.id === item.id) === idx,
        )
        // Newest first
        .sort((a, b) => b.pubDate - a.pubDate);

      if (merged.length > 0) {
        writeCache(merged);
        setArticles(merged);
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
          (a) => a.source === SOURCES.find((s) => s.key === filter)?.name,
        );

  if (loading) {
    return (
      <View style={s.centre}>
        <ActivityIndicator size="large" color="#1DB954" />
        <Text style={s.loadingText}>Fetching Zimbabwe news…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {/* Push content below floating community tab bar */}
      <View style={{ height: TOP_OFFSET }} />

      <FilterBar active={filter} onSelect={setFilter} />

      {error && articles.length === 0 ? (
        <View style={s.centre}>
          <Ionicons name="wifi-outline" size={48} color="#444" />
          <Text style={s.errorText}>Could not load news</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => fetchAll(true)}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <NewsCard item={item} />}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchAll(true)}
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

  // Filter bar
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

  // Card
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
  readMore: { color: "#8E8E93", fontSize: 12 },
});
