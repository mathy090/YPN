// src/screens/discord.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { MMKV } from "react-native-mmkv";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const ADMIN_EMAIL = "tafadzwarunowanda@gmail.com";
const API_URL = process.env.EXPO_PUBLIC_API_URL;
const CACHE_KEY = "discord_channels_v1";
const CACHE_TS_KEY = "discord_channels_ts_v1";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let _store: MMKV | null = null;
const getStore = () => {
  if (!_store) _store = new MMKV({ id: "discord-channels" });
  return _store;
};

type Channel = {
  id: string;
  name: string;
  description: string;
  color: string;
  bgColor: string;
  emoji: string;
  order: number;
};

const FALLBACK_CHANNELS: Channel[] = [
  {
    id: "general",
    name: "general",
    description: "General YPN community chat",
    color: "#5865F2",
    bgColor: "#5865F222",
    emoji: "💬",
    order: 1,
  },
  {
    id: "mental-health",
    name: "mental-health",
    description: "Safe space to talk",
    color: "#57F287",
    bgColor: "#57F28722",
    emoji: "💚",
    order: 2,
  },
  {
    id: "jobs",
    name: "jobs",
    description: "Opportunities & careers",
    color: "#FEE75C",
    bgColor: "#FEE75C22",
    emoji: "💼",
    order: 3,
  },
  {
    id: "education",
    name: "education",
    description: "Learning & resources",
    color: "#EB459E",
    bgColor: "#EB459E22",
    emoji: "📚",
    order: 4,
  },
  {
    id: "prayer",
    name: "prayer",
    description: "Prayer & community support",
    color: "#FF7043",
    bgColor: "#FF704322",
    emoji: "🙏",
    order: 5,
  },
  {
    id: "announcements",
    name: "announcements",
    description: "YPN news & updates",
    color: "#ED4245",
    bgColor: "#ED424522",
    emoji: "📢",
    order: 6,
  },
];

function readCache(): Channel[] | null {
  try {
    const ts = getStore().getNumber(CACHE_TS_KEY);
    if (!ts || Date.now() - ts > CACHE_TTL) return null;
    const raw = getStore().getString(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(channels: Channel[]) {
  try {
    getStore().set(CACHE_KEY, JSON.stringify(channels));
    getStore().set(CACHE_TS_KEY, Date.now());
  } catch {}
}

const emailAdmin = (subject: string) => {
  Linking.openURL(
    `mailto:${ADMIN_EMAIL}?subject=${encodeURIComponent(subject)}`,
  ).catch(() => {});
};

export default function DiscordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    boot();
  }, []);

  const boot = async () => {
    const cached = readCache();
    if (cached && cached.length > 0) {
      setChannels(cached);
      setLoading(false);
      // background refresh
      fetchChannels(false);
    } else {
      await fetchChannels(false);
    }
  };

  const fetchChannels = async (manual = true) => {
    if (manual) setRefreshing(true);
    try {
      const res = await fetch(`${API_URL}/api/discord/channels`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Channel[] = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        writeCache(data);
        setChannels(data);
      }
    } catch {
      if (channels.length === 0) setChannels(FALLBACK_CHANNELS);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const openChannel = (channel: Channel) => {
    router.push({
      pathname: "/discordChannel",
      params: {
        channelId: channel.id,
        channelName: channel.name,
        channelEmoji: channel.emoji,
        channelColor: channel.color,
        channelDescription: channel.description,
      },
    });
  };

  const renderBanners = () => (
    <View style={s.bannersWrap}>
      <TouchableOpacity
        style={s.banner}
        onPress={() => emailAdmin("Upload Video to For You Page - YPN")}
        activeOpacity={0.8}
      >
        <View style={[s.bannerIcon, { backgroundColor: "#1DB95420" }]}>
          <Ionicons name="videocam" size={18} color="#1DB954" />
        </View>
        <View style={s.bannerContent}>
          <Text style={s.bannerTitle}>Want your content on For You?</Text>
          <Text style={s.bannerSub}>Contact admin →</Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color="#1DB954" />
      </TouchableOpacity>

      <TouchableOpacity
        style={[s.banner, { borderColor: "#5865F230", marginTop: 8 }]}
        onPress={() => emailAdmin("Channel Suggestion - YPN Community")}
        activeOpacity={0.8}
      >
        <View style={[s.bannerIcon, { backgroundColor: "#5865F220" }]}>
          <Ionicons name="add-circle-outline" size={18} color="#5865F2" />
        </View>
        <View style={s.bannerContent}>
          <Text style={s.bannerTitle}>Suggest a new channel</Text>
          <Text style={[s.bannerSub, { color: "#5865F2" }]}>
            Contact admin →
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color="#5865F2" />
      </TouchableOpacity>
    </View>
  );

  const renderAIItem = () => (
    <TouchableOpacity
      style={s.row}
      onPress={() => router.push("/chat?roomId=team-ypn")}
      activeOpacity={0.8}
    >
      <View style={s.avatarWrap}>
        <Image
          source={require("../../assets/images/YPN.png")}
          style={s.avatar}
        />
        <View style={s.onlineDot} />
      </View>
      <View style={s.rowText}>
        <View style={s.rowTitleRow}>
          <Text style={s.rowName}>Team YPN</Text>
          <View style={s.aiBadge}>
            <Text style={s.aiBadgeText}>AI</Text>
          </View>
        </View>
        <Text style={s.rowDesc} numberOfLines={1}>
          Your personal AI assistant — always online
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color="#333" />
    </TouchableOpacity>
  );

  const renderChannel = ({ item }: { item: Channel }) => (
    <TouchableOpacity
      style={s.row}
      onPress={() => openChannel(item)}
      activeOpacity={0.8}
    >
      <View
        style={[
          s.emojiCircle,
          { backgroundColor: item.bgColor, borderColor: item.color + "55" },
        ]}
      >
        <Text style={s.emoji}>{item.emoji}</Text>
      </View>
      <View style={s.rowText}>
        <Text style={s.rowName}>#{item.name}</Text>
        <Text style={s.rowDesc} numberOfLines={1}>
          {item.description}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color="#333" />
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Community</Text>
        </View>
        <View style={s.centre}>
          <ActivityIndicator color="#5865F2" />
        </View>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Community</Text>
      </View>

      <FlatList
        data={channels}
        keyExtractor={(item) => item.id}
        renderItem={renderChannel}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchChannels(true)}
            tintColor="#5865F2"
            colors={["#5865F2"]}
          />
        }
        ListHeaderComponent={
          <>
            {renderBanners()}
            <View style={s.sectionLabel}>
              <Text style={s.sectionLabelText}>AI ASSISTANT</Text>
            </View>
            {renderAIItem()}
            <View style={s.divider} />
            <View style={s.sectionLabel}>
              <Text style={s.sectionLabelText}>CHANNELS</Text>
            </View>
          </>
        }
        ItemSeparatorComponent={() => <View style={s.separator} />}
        ListFooterComponent={<View style={{ height: 120 }} />}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#111",
  },
  headerTitle: { color: "#fff", fontSize: 28, fontWeight: "800" },
  centre: { flex: 1, justifyContent: "center", alignItems: "center" },

  bannersWrap: { padding: 12, paddingBottom: 0 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0D0D0D",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1DB95430",
    gap: 12,
  },
  bannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  bannerContent: { flex: 1 },
  bannerTitle: { color: "#fff", fontSize: 14, fontWeight: "600" },
  bannerSub: { color: "#1DB954", fontSize: 12, marginTop: 2 },

  sectionLabel: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 },
  sectionLabelText: {
    color: "#444",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  divider: {
    height: 1,
    backgroundColor: "#111",
    marginHorizontal: 16,
    marginTop: 4,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 13,
  },
  avatarWrap: { position: "relative", flexShrink: 0 },
  avatar: { width: 50, height: 50, borderRadius: 25 },
  onlineDot: {
    position: "absolute",
    bottom: 1,
    right: 1,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: "#25D366",
    borderWidth: 2,
    borderColor: "#000",
  },
  aiBadge: {
    backgroundColor: "#5865F2",
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 6,
  },
  aiBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },

  emojiCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1.5,
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  emoji: { fontSize: 22 },
  rowText: { flex: 1 },
  rowTitleRow: { flexDirection: "row", alignItems: "center" },
  rowName: { color: "#fff", fontSize: 16, fontWeight: "600" },
  rowDesc: { color: "#555", fontSize: 13, marginTop: 2 },
  separator: { height: 1, backgroundColor: "#0D0D0D", marginLeft: 79 },
});
