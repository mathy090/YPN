// src/screens/discord.tsx
import { Ionicons } from "@expo/vector-icons";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { MMKV } from "react-native-mmkv";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";

// ─── Config ───────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL;
const CHANNELS_KEY = "discord_channels_v1";
const CHANNELS_TS = "discord_channels_ts_v1";
const CHANNELS_TTL = 24 * 60 * 60 * 1000; // 24h — channels rarely change

// ─── MMKV singleton ───────────────────────────────────────────────────────────
let _store: MMKV | null = null;
const store = () => {
  if (!_store) _store = new MMKV({ id: "discord-cache" });
  return _store;
};

// ─── Types ────────────────────────────────────────────────────────────────────
type Channel = {
  id: string;
  name: string;
  description: string;
  color: string;
  bgColor: string;
  emoji: string;
  order: number;
};

type Message = {
  id: string;
  text: string;
  uid: string;
  displayName: string;
  createdAt: number;
};

// ─── Channel cache helpers ────────────────────────────────────────────────────
function readChannelCache(): Channel[] | null {
  try {
    const ts = store().getNumber(CHANNELS_TS);
    if (!ts || Date.now() - ts > CHANNELS_TTL) return null;
    const raw = store().getString(CHANNELS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeChannelCache(channels: Channel[]) {
  try {
    store().set(CHANNELS_KEY, JSON.stringify(channels));
    store().set(CHANNELS_TS, Date.now());
  } catch {}
}

// ─── Fetch channels from backend ──────────────────────────────────────────────
async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch(`${API_URL}/api/discord/channels`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Time helpers ─────────────────────────────────────────────────────────────
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateHeader(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

// ─── Channel Avatar ───────────────────────────────────────────────────────────
// Rendered from backend-provided color + emoji — no hardcoded values on frontend
function ChannelAvatar({
  channel,
  size = 48,
}: {
  channel: Channel;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: channel.bgColor,
        borderWidth: 2,
        borderColor: channel.color + "55",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text style={{ fontSize: size * 0.45 }}>{channel.emoji}</Text>
    </View>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────
const Bubble = React.memo(
  ({
    msg,
    isMe,
    showName,
    channelColor,
  }: {
    msg: Message;
    isMe: boolean;
    showName: boolean;
    channelColor: string;
  }) => {
    const initials = (msg.displayName?.[0] ?? "?").toUpperCase();
    return (
      <View style={[bub.row, isMe && bub.rowMe]}>
        {!isMe && (
          <View
            style={[
              bub.avatar,
              {
                backgroundColor: channelColor + "33",
                borderColor: channelColor + "55",
              },
            ]}
          >
            <Text style={[bub.avatarText, { color: channelColor }]}>
              {initials}
            </Text>
          </View>
        )}
        <View
          style={[
            bub.bubble,
            isMe
              ? [bub.bubbleMe, { backgroundColor: channelColor }]
              : bub.bubbleThem,
          ]}
        >
          {showName && !isMe && (
            <Text style={[bub.name, { color: channelColor }]}>
              {msg.displayName}
            </Text>
          )}
          <Text style={bub.text}>{msg.text}</Text>
          <Text style={bub.time}>{formatTime(msg.createdAt)}</Text>
        </View>
      </View>
    );
  },
);

const bub = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 2,
    paddingHorizontal: 12,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 6,
    marginBottom: 2,
  },
  avatarText: { fontWeight: "700", fontSize: 13 },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#2B2D31", borderBottomLeftRadius: 4 },
  name: { fontSize: 11, fontWeight: "700", marginBottom: 2 },
  text: { color: "#DBDEE1", fontSize: 15, lineHeight: 21 },
  time: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 10,
    marginTop: 3,
    textAlign: "right",
  },
});

// ─── Channel Sidebar ──────────────────────────────────────────────────────────
function Sidebar({
  channels,
  active,
  onSelect,
  onClose,
}: {
  channels: Channel[];
  active: Channel;
  onSelect: (c: Channel) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[side.root, { paddingTop: insets.top + 8 }]}>
      <View style={side.header}>
        <Text style={side.heading}>YPN Community</Text>
        <Text style={side.sub}>Youth Positive Network</Text>
      </View>

      <Text style={side.sectionLabel}>TEXT CHANNELS</Text>

      {channels.map((ch) => {
        const isActive = ch.id === active.id;
        return (
          <TouchableOpacity
            key={ch.id}
            style={[
              side.item,
              isActive && { backgroundColor: ch.color + "22" },
            ]}
            onPress={() => {
              onSelect(ch);
              onClose();
            }}
            activeOpacity={0.7}
          >
            <ChannelAvatar channel={ch} size={36} />
            <View style={side.itemText}>
              <Text
                style={[
                  side.chName,
                  isActive && { color: ch.color, fontWeight: "700" },
                ]}
              >
                #{ch.name}
              </Text>
              <Text style={side.chDesc} numberOfLines={1}>
                {ch.description}
              </Text>
            </View>
            {isActive && (
              <View style={[side.activeDot, { backgroundColor: ch.color }]} />
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const side = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1E1F22", paddingHorizontal: 8 },
  header: {
    paddingHorizontal: 8,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#2B2D31",
    marginBottom: 12,
  },
  heading: { color: "#FFFFFF", fontSize: 17, fontWeight: "800" },
  sub: { color: "#8D9096", fontSize: 11, marginTop: 2 },
  sectionLabel: {
    color: "#8D9096",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    paddingHorizontal: 8,
    marginBottom: 6,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 4,
    gap: 10,
  },
  itemText: { flex: 1 },
  chName: { color: "#8D9096", fontSize: 14, fontWeight: "500" },
  chDesc: { color: "#555", fontSize: 11, marginTop: 1 },
  activeDot: { width: 8, height: 8, borderRadius: 4 },
});

// ─── Chat View ────────────────────────────────────────────────────────────────
function ChatView({ channel }: { channel: Channel }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);
  const me = auth?.currentUser;

  // Real-time Firestore listener
  useEffect(() => {
    setLoading(true);
    setMessages([]);

    const q = query(
      collection(db, "channels", channel.id, "messages"),
      orderBy("createdAt", "asc"),
      limit(100),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const msgs: Message[] = snap.docs.map((doc) => {
          const d = doc.data();
          return {
            id: doc.id,
            text: d.text ?? "",
            uid: d.uid ?? "",
            displayName: d.displayName ?? "Member",
            createdAt: d.createdAt?.toMillis?.() ?? Date.now(),
          };
        });
        setMessages(msgs);
        setLoading(false);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      },
      (err) => {
        console.error("[Discord] Firestore error:", err);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [channel.id]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !me) return;
    setInput("");
    setSending(true);
    try {
      await addDoc(collection(db, "channels", channel.id, "messages"), {
        text,
        uid: me.uid,
        displayName: me.displayName || me.email?.split("@")[0] || "YPN Member",
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("[Discord] Send failed:", e);
      setInput(text); // restore on failure
    } finally {
      setSending(false);
    }
  }, [input, sending, me, channel.id]);

  // Group messages with date headers
  const grouped = React.useMemo(() => {
    type Row =
      | { type: "header"; date: string }
      | { type: "msg"; msg: Message; showName: boolean };

    const result: Row[] = [];
    let lastDate = "";
    let lastUid = "";

    messages.forEach((msg) => {
      const dateStr = formatDateHeader(msg.createdAt);
      if (dateStr !== lastDate) {
        result.push({ type: "header", date: dateStr });
        lastDate = dateStr;
        lastUid = "";
      }
      result.push({ type: "msg", msg, showName: msg.uid !== lastUid });
      lastUid = msg.uid;
    });

    return result;
  }, [messages]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* Channel header */}
      <View
        style={[
          chat.channelHeader,
          { borderBottomColor: channel.color + "33" },
        ]}
      >
        <ChannelAvatar channel={channel} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={chat.channelName}>#{channel.name}</Text>
          <Text style={chat.channelDesc}>{channel.description}</Text>
        </View>
      </View>

      {/* Messages list */}
      {loading ? (
        <View style={chat.centre}>
          <ActivityIndicator color={channel.color} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={grouped}
          keyExtractor={(item, i) =>
            item.type === "header" ? `h-${i}` : item.msg.id
          }
          renderItem={({ item }) => {
            if (item.type === "header") {
              return (
                <View style={chat.dateRow}>
                  <View style={chat.dateLine} />
                  <Text style={chat.dateText}>{item.date}</Text>
                  <View style={chat.dateLine} />
                </View>
              );
            }
            return (
              <Bubble
                msg={item.msg}
                isMe={item.msg.uid === me?.uid}
                showName={item.showName}
                channelColor={channel.color}
              />
            );
          }}
          contentContainerStyle={{ paddingVertical: 12, paddingBottom: 8 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: false })
          }
          ListEmptyComponent={
            <View style={chat.centre}>
              <Text style={{ fontSize: 36 }}>{channel.emoji}</Text>
              <Text style={chat.emptyTitle}>Welcome to #{channel.name}</Text>
              <Text style={chat.emptyDesc}>{channel.description}</Text>
            </View>
          }
        />
      )}

      {/* Input bar */}
      <View style={chat.inputBar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={me ? `Message #${channel.name}` : "Sign in to chat"}
          placeholderTextColor="#6D6F78"
          style={chat.input}
          multiline
          maxLength={500}
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
          editable={!!me}
        />
        <Pressable
          onPress={sendMessage}
          disabled={!input.trim() || sending || !me}
          style={({ pressed }) => [
            chat.sendBtn,
            { backgroundColor: channel.color },
            (!input.trim() || !me) && chat.sendBtnOff,
            pressed && { opacity: 0.75 },
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="send" size={18} color="#fff" />
          )}
        </Pressable>
      </View>

      {!me && (
        <View style={chat.authBanner}>
          <Ionicons name="lock-closed-outline" size={14} color="#FFA500" />
          <Text style={chat.authText}>Sign in to send messages</Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const chat = StyleSheet.create({
  channelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    backgroundColor: "#232428",
  },
  channelName: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  channelDesc: { color: "#8D9096", fontSize: 11, marginTop: 1 },
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: 24,
  },
  emptyTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 8,
  },
  emptyDesc: { color: "#8D9096", fontSize: 14, textAlign: "center" },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginVertical: 12,
    gap: 8,
  },
  dateLine: { flex: 1, height: 1, backgroundColor: "#3F4147" },
  dateText: { color: "#8D9096", fontSize: 11, fontWeight: "600" },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    margin: 10,
    backgroundColor: "#383A40",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
    color: "#DBDEE1",
    fontSize: 15,
    maxHeight: 100,
    paddingVertical: 4,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnOff: { backgroundColor: "#404249" },
  authBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    backgroundColor: "#FFA50018",
  },
  authText: { color: "#FFA500", fontSize: 12 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;
const TOP_OFFSET = STATUS_H + 48;

export default function DiscordScreen() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [channelError, setChannelError] = useState(false);

  useEffect(() => {
    bootChannels();
  }, []);

  const bootChannels = async () => {
    // Show cached channels instantly
    const cached = readChannelCache();
    if (cached && cached.length > 0) {
      setChannels(cached);
      setActiveChannel(cached[0]);
      setLoadingChannels(false);
      // Background refresh
      refreshChannels(cached);
    } else {
      await refreshChannels(null);
    }
  };

  const refreshChannels = async (existing: Channel[] | null) => {
    try {
      const data = await fetchChannels();
      if (data.length > 0) {
        writeChannelCache(data);
        setChannels(data);
        // Only set active if we don't have one yet
        if (!existing) setActiveChannel(data[0]);
      }
    } catch (e) {
      console.error("[Discord] Failed to fetch channels:", e);
      if (!existing) setChannelError(true);
    } finally {
      setLoadingChannels(false);
    }
  };

  if (loadingChannels) {
    return (
      <View style={main.loadingRoot}>
        <ActivityIndicator size="large" color="#5865F2" />
        <Text style={main.loadingText}>Loading channels…</Text>
      </View>
    );
  }

  if (channelError || !activeChannel) {
    return (
      <View style={main.loadingRoot}>
        <Ionicons name="wifi-outline" size={48} color="#444" />
        <Text style={main.loadingText}>Could not load channels</Text>
        <TouchableOpacity
          style={main.retryBtn}
          onPress={() => {
            setChannelError(false);
            setLoadingChannels(true);
            bootChannels();
          }}
        >
          <Text style={main.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={main.root}>
      <View style={{ height: TOP_OFFSET }} />

      <View style={main.body}>
        {/* Sidebar */}
        {sidebarOpen && (
          <View style={main.sidebar}>
            <Sidebar
              channels={channels}
              active={activeChannel}
              onSelect={(ch) => {
                setActiveChannel(ch);
                setSidebarOpen(false);
              }}
              onClose={() => setSidebarOpen(false)}
            />
          </View>
        )}

        {/* Main chat */}
        <View style={main.chat}>
          {/* Top bar */}
          <View style={main.topBar}>
            <TouchableOpacity
              onPress={() => setSidebarOpen((p) => !p)}
              style={main.hamburger}
              activeOpacity={0.7}
            >
              <Ionicons
                name={sidebarOpen ? "close" : "menu"}
                size={22}
                color="#DBDEE1"
              />
            </TouchableOpacity>

            <View style={main.topBarCenter}>
              <Text style={{ fontSize: 18 }}>{activeChannel.emoji}</Text>
              <Text style={main.topBarTitle}>#{activeChannel.name}</Text>
            </View>

            <View style={main.onlineIndicator}>
              <View style={main.onlineDot} />
              <Text style={main.onlineText}>Live</Text>
            </View>
          </View>

          <ChatView channel={activeChannel} />
        </View>
      </View>
    </View>
  );
}

const main = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#313338" },
  body: { flex: 1, flexDirection: "row" },

  loadingRoot: {
    flex: 1,
    backgroundColor: "#313338",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  loadingText: { color: "#8D9096", fontSize: 15 },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: "#5865F2",
    borderRadius: 20,
  },
  retryText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  sidebar: { width: 230, borderRightWidth: 1, borderRightColor: "#1E1F22" },
  chat: { flex: 1 },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#2B2D31",
    borderBottomWidth: 1,
    borderBottomColor: "#1E1F22",
  },
  hamburger: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  topBarCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  topBarTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },

  onlineIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    width: 50,
    justifyContent: "flex-end",
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#57F287",
  },
  onlineText: { color: "#57F287", fontSize: 11, fontWeight: "600" },
});
