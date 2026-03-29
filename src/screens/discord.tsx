// src/screens/discord.tsx
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
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

// ── Two-layer cache ────────────────────────────────────────────
let _mmkv: MMKV | null = null;
const mmkv = () => {
  if (!_mmkv) _mmkv = new MMKV({ id: "ypn-discord-v4" });
  return _mmkv;
};
const L1_KEY = (id: string) => `discord_l1_${id}`;
const L2_KEY = (id: string) => `discord_l2_${id}`;
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function readCache(channelId: string): Promise<Message[] | null> {
  // L1: MMKV (fast, in-memory)
  try {
    const raw = mmkv().getString(L1_KEY(channelId));
    if (raw) return JSON.parse(raw);
  } catch {}
  // L2: AsyncStorage (persistent)
  try {
    const raw = await AsyncStorage.getItem(L2_KEY(channelId));
    if (raw) {
      const parsed = JSON.parse(raw);
      mmkv().set(L1_KEY(channelId), raw); // promote to L1
      return parsed;
    }
  } catch {}
  return null;
}

async function writeCache(channelId: string, messages: Message[]) {
  const raw = JSON.stringify(messages.slice(-80));
  try {
    mmkv().set(L1_KEY(channelId), raw);
  } catch {}
  try {
    await AsyncStorage.setItem(L2_KEY(channelId), raw);
  } catch {}
}

// ── Constants ──────────────────────────────────────────────────
const AI_URL = process.env.EXPO_PUBLIC_AI_URL
  ? `${process.env.EXPO_PUBLIC_AI_URL}/chat`
  : "https://ypn-1.onrender.com/chat";

// ── Types ──────────────────────────────────────────────────────
type MessageType = "text";

type Message = {
  id: string;
  text: string;
  uid: string;
  displayName: string;
  createdAt: number;
  isAI?: boolean;
  pending?: boolean;
  failed?: boolean;
};

type Channel = {
  id: string;
  name: string;
  description: string;
  color: string;
  emoji: string;
  isAI?: boolean;
};

// ── Channel definitions ────────────────────────────────────────
const CHANNELS: Channel[] = [
  {
    id: "ai-private",
    name: "Private Chat",
    description: "Chat with YPN AI",
    color: "#1DB954",
    emoji: "🤖",
    isAI: true,
  },
  {
    id: "general",
    name: "general",
    description: "General YPN community",
    color: "#5865F2",
    emoji: "💬",
  },
  {
    id: "mental-health",
    name: "mental-health",
    description: "Safe space to talk",
    color: "#57F287",
    emoji: "💚",
  },
  {
    id: "jobs",
    name: "jobs",
    description: "Opportunities & careers",
    color: "#FEE75C",
    emoji: "💼",
  },
  {
    id: "education",
    name: "education",
    description: "Learning & resources",
    color: "#EB459E",
    emoji: "📚",
  },
  {
    id: "prayer",
    name: "prayer",
    description: "Prayer & support",
    color: "#FF7043",
    emoji: "🙏",
  },
  {
    id: "announcements",
    name: "announcements",
    description: "YPN news & updates",
    color: "#ED4245",
    emoji: "📢",
  },
];

// ══════════════════════════════════════════════════════════════
export default function DiscordScreen() {
  const insets = useSafeAreaInsets();
  const [activeChannel, setActiveChannel] = useState<Channel>(CHANNELS[0]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [aiTyping, setAiTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList>(null);
  const me = auth.currentUser;

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  // ── Load channel ────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setMessages([]);

    // Restore from cache instantly
    readCache(activeChannel.id).then((cached) => {
      if (cached?.length) {
        setMessages(cached);
        setLoading(false);
        scrollToBottom();
      }
    });

    if (activeChannel.isAI) {
      // AI channel: load from local cache only (no Firestore)
      setLoading(false);
      return;
    }

    // Firestore real-time listener for community channels
    const q = query(
      collection(db, "channels", activeChannel.id, "messages"),
      orderBy("createdAt", "asc"),
      limit(80),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const msgs: Message[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            text: (data.text as string) ?? "",
            uid: (data.uid as string) ?? "",
            displayName: (data.displayName as string) ?? "Member",
            createdAt:
              (data.createdAt as Timestamp)?.toMillis?.() ?? Date.now(),
          };
        });
        setMessages(msgs);
        setLoading(false);
        writeCache(activeChannel.id, msgs);
        scrollToBottom();
      },
      () => setLoading(false),
    );

    return () => unsub();
  }, [activeChannel.id]);

  // ── Send to AI ──────────────────────────────────────────────
  const sendToAI = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return;
      setSending(true);

      const userMsg: Message = {
        id: `local_${Date.now()}`,
        text,
        uid: me?.uid ?? "user",
        displayName: me?.displayName ?? "You",
        createdAt: Date.now(),
      };
      setMessages((prev) => {
        const next = [...prev, userMsg];
        writeCache(activeChannel.id, next);
        return next;
      });
      setInput("");
      setAiTyping(true);
      scrollToBottom();

      try {
        const res = await fetch(AI_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            session_id: me?.uid ?? "ypn-general",
          }),
        });
        const data = await res.json();
        const reply = data.reply ?? data.message ?? "I'm here to help!";

        const aiMsg: Message = {
          id: `ai_${Date.now()}`,
          text: reply,
          uid: "ypn-ai",
          displayName: "YPN AI",
          createdAt: Date.now(),
          isAI: true,
        };
        setMessages((prev) => {
          const next = [...prev, aiMsg];
          writeCache(activeChannel.id, next);
          return next;
        });
      } catch {
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          text: "Couldn't reach the AI. Please check your connection.",
          uid: "ypn-ai",
          displayName: "YPN AI",
          createdAt: Date.now(),
          isAI: true,
        };
        setMessages((prev) => [...prev, errMsg]);
      } finally {
        setAiTyping(false);
        setSending(false);
        scrollToBottom();
      }
    },
    [sending, me, activeChannel.id],
  );

  // ── Send to Firestore ───────────────────────────────────────
  const sendToFirestore = useCallback(
    async (text: string) => {
      if (!text.trim() || !me || sending) return;
      setSending(true);
      setInput("");

      const optimisticId = `local_${Date.now()}`;
      const optimistic: Message = {
        id: optimisticId,
        text,
        uid: me.uid,
        displayName: me.displayName ?? me.email?.split("@")[0] ?? "Member",
        createdAt: Date.now(),
        pending: true,
      };
      setMessages((prev) => [...prev, optimistic]);
      scrollToBottom();

      try {
        await addDoc(collection(db, "channels", activeChannel.id, "messages"), {
          text,
          uid: me.uid,
          displayName:
            me.displayName ?? me.email?.split("@")[0] ?? "YPN Member",
          createdAt: serverTimestamp(),
        });
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId ? { ...m, pending: false, failed: true } : m,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [sending, me, activeChannel.id],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (activeChannel.isAI) sendToAI(text);
    else sendToFirestore(text);
  }, [input, activeChannel.isAI, sendToAI, sendToFirestore]);

  // ── Render message ──────────────────────────────────────────
  const renderMessage = useCallback(
    ({ item }: { item: Message }) => {
      const isMe = item.uid === me?.uid;
      const isAI = item.isAI;
      const time = new Date(item.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      return (
        <Pressable style={[mS.row, isMe && !isAI && mS.rowMe]}>
          {!isMe && (
            <View
              style={[
                mS.avatar,
                {
                  backgroundColor: activeChannel.color + "33",
                  borderColor: activeChannel.color + "55",
                },
              ]}
            >
              <Text style={[mS.avatarText, { color: activeChannel.color }]}>
                {isAI ? "🤖" : (item.displayName?.[0] ?? "?").toUpperCase()}
              </Text>
            </View>
          )}
          <View
            style={[
              mS.bubble,
              isMe && !isAI
                ? [mS.bubbleMe, { backgroundColor: activeChannel.color }]
                : mS.bubbleThem,
              item.pending && mS.bubblePending,
              item.failed && mS.bubbleFailed,
            ]}
          >
            {!isMe && (
              <Text style={[mS.senderName, { color: activeChannel.color }]}>
                {isAI ? "YPN AI 🤖" : item.displayName}
              </Text>
            )}
            <Text
              style={[
                mS.msgText,
                isMe &&
                  !isAI && {
                    color: activeChannel.color === "#FEE75C" ? "#000" : "#fff",
                  },
              ]}
            >
              {item.text}
            </Text>
            <View style={mS.meta}>
              <Text
                style={[
                  mS.time,
                  isMe && !isAI && { color: "rgba(0,0,0,0.45)" },
                ]}
              >
                {time}
              </Text>
              {item.pending && (
                <Ionicons name="time-outline" size={11} color="#8E8E93" />
              )}
              {item.failed && (
                <Ionicons
                  name="alert-circle-outline"
                  size={11}
                  color="#FF453A"
                />
              )}
              {isMe && !item.pending && !item.failed && (
                <Ionicons
                  name="checkmark-done"
                  size={11}
                  color={isMe && !isAI ? "rgba(0,0,0,0.45)" : "#8E8E93"}
                />
              )}
            </View>
          </View>
        </Pressable>
      );
    },
    [me, activeChannel],
  );

  const topPad =
    insets.top +
    (Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 0) : 0);

  return (
    <View style={[dS.root, { paddingTop: topPad }]}>
      {/* Header */}
      <View style={dS.header}>
        <TouchableOpacity
          onPress={() => setSidebarOpen((p) => !p)}
          style={dS.headerBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons
            name={sidebarOpen ? "close" : "menu"}
            size={22}
            color="#fff"
          />
        </TouchableOpacity>
        <Text style={{ fontSize: 18 }}>{activeChannel.emoji}</Text>
        <Text style={dS.headerTitle}>
          {activeChannel.isAI ? activeChannel.name : `#${activeChannel.name}`}
        </Text>
        {activeChannel.isAI && (
          <View
            style={[
              dS.aiBadge,
              {
                backgroundColor: activeChannel.color + "22",
                borderColor: activeChannel.color + "44",
              },
            ]}
          >
            <Text style={[dS.aiBadgeText, { color: activeChannel.color }]}>
              AI
            </Text>
          </View>
        )}
      </View>

      <View style={dS.body}>
        {/* Sidebar */}
        {sidebarOpen && (
          <View style={dS.sidebar}>
            <Text style={dS.sidebarHeading}>YPN Community</Text>

            {/* AI first */}
            {CHANNELS.filter((c) => c.isAI).map((ch) => (
              <ChannelItem
                key={ch.id}
                channel={ch}
                isActive={activeChannel.id === ch.id}
                onPress={() => {
                  setActiveChannel(ch);
                  setSidebarOpen(false);
                }}
              />
            ))}

            <Text style={dS.sectionLabel}>TEXT CHANNELS</Text>

            {CHANNELS.filter((c) => !c.isAI).map((ch) => (
              <ChannelItem
                key={ch.id}
                channel={ch}
                isActive={activeChannel.id === ch.id}
                onPress={() => {
                  setActiveChannel(ch);
                  setSidebarOpen(false);
                }}
              />
            ))}
          </View>
        )}

        {/* Chat */}
        <KeyboardAvoidingView
          style={dS.chat}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={topPad + 56}
        >
          {loading ? (
            <View style={dS.centre}>
              <ActivityIndicator color={activeChannel.color} size="large" />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              renderItem={renderMessage}
              contentContainerStyle={[dS.messageList, { paddingBottom: 100 }]}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={scrollToBottom}
              ListEmptyComponent={
                <View style={dS.emptyContainer}>
                  <Text style={{ fontSize: 48 }}>{activeChannel.emoji}</Text>
                  <Text style={dS.emptyTitle}>
                    {activeChannel.isAI
                      ? "Private Chat 🤖"
                      : `#${activeChannel.name}`}
                  </Text>
                  <Text style={dS.emptyDesc}>{activeChannel.description}</Text>
                </View>
              }
              ListFooterComponent={
                aiTyping ? (
                  <View style={mS.row}>
                    <View
                      style={[
                        mS.avatar,
                        {
                          backgroundColor: "#1DB95433",
                          borderColor: "#1DB95455",
                        },
                      ]}
                    >
                      <Text>🤖</Text>
                    </View>
                    <View style={mS.bubbleThem}>
                      <Text
                        style={{
                          color: "#8E8E93",
                          fontStyle: "italic",
                          fontSize: 14,
                        }}
                      >
                        typing…
                      </Text>
                    </View>
                  </View>
                ) : null
              }
            />
          )}

          {/* Input bar */}
          <View style={dS.inputBar}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={
                me
                  ? `Message ${activeChannel.isAI ? "YPN AI" : `#${activeChannel.name}`}`
                  : "Sign in to chat"
              }
              placeholderTextColor="#555"
              style={dS.textInput}
              multiline
              maxLength={2000}
              editable={!!me}
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
            />
            <TouchableOpacity
              onPress={handleSend}
              disabled={!input.trim() || sending || !me}
              style={[
                dS.sendBtn,
                {
                  backgroundColor:
                    !input.trim() || !me ? "#222" : activeChannel.color,
                },
              ]}
              activeOpacity={0.8}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons
                  name="send"
                  size={18}
                  color={
                    activeChannel.color === "#FEE75C" && !!input.trim()
                      ? "#000"
                      : "#fff"
                  }
                />
              )}
            </TouchableOpacity>
          </View>

          {!me && (
            <View style={dS.authBanner}>
              <Ionicons name="lock-closed-outline" size={12} color="#FFA500" />
              <Text style={dS.authText}>Sign in to send messages</Text>
            </View>
          )}
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

// ── ChannelItem ────────────────────────────────────────────────
function ChannelItem({
  channel,
  isActive,
  onPress,
}: {
  channel: Channel;
  isActive: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        sideS.item,
        isActive && { backgroundColor: channel.color + "22" },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View
        style={[
          sideS.icon,
          {
            backgroundColor: channel.color + "22",
            borderColor: channel.color + "44",
          },
        ]}
      >
        <Text style={{ fontSize: 16 }}>{channel.emoji}</Text>
      </View>
      <View style={sideS.itemText}>
        <Text
          style={[
            sideS.chName,
            isActive && { color: channel.color, fontWeight: "700" },
          ]}
        >
          {channel.isAI ? channel.name : `#${channel.name}`}
        </Text>
        <Text style={sideS.chDesc} numberOfLines={1}>
          {channel.description}
        </Text>
      </View>
      {isActive && (
        <View style={[sideS.dot, { backgroundColor: channel.color }]} />
      )}
    </TouchableOpacity>
  );
}

// ── Styles ─────────────────────────────────────────────────────
const dS = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0D0D0D" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#111",
    borderBottomWidth: 1,
    borderBottomColor: "#222",
    gap: 10,
  },
  headerBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: { color: "#fff", fontSize: 16, fontWeight: "700", flex: 1 },
  aiBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  aiBadgeText: { fontSize: 11, fontWeight: "700" },
  body: { flex: 1, flexDirection: "row" },
  sidebar: {
    width: 240,
    backgroundColor: "#111",
    borderRightWidth: 1,
    borderRightColor: "#222",
    paddingTop: 12,
    paddingHorizontal: 8,
  },
  sidebarHeading: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#222",
    marginBottom: 8,
  },
  sectionLabel: {
    color: "#555",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    paddingHorizontal: 8,
    marginTop: 12,
    marginBottom: 6,
  },
  chat: { flex: 1 },
  messageList: { paddingVertical: 12, paddingHorizontal: 4 },
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    minHeight: 200,
  },
  emptyContainer: { alignItems: "center", padding: 32, gap: 10, marginTop: 60 },
  emptyTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  emptyDesc: { color: "#8E8E93", fontSize: 14, textAlign: "center" },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#111",
    borderTopWidth: 1,
    borderTopColor: "#222",
    gap: 8,
    paddingBottom: 90, // clear tab bar
  },
  textInput: {
    flex: 1,
    backgroundColor: "#1A1A1A",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#fff",
    fontSize: 15,
    maxHeight: 120,
    lineHeight: 20,
    borderWidth: 1,
    borderColor: "#2A2A2A",
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  authBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    backgroundColor: "#FFA50015",
  },
  authText: { color: "#FFA500", fontSize: 12 },
});

const sideS = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 9,
    borderRadius: 10,
    marginBottom: 3,
    gap: 10,
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    justifyContent: "center",
    alignItems: "center",
  },
  itemText: { flex: 1 },
  chName: { color: "#8E8E93", fontSize: 14, fontWeight: "500" },
  chDesc: { color: "#444", fontSize: 11, marginTop: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});

const mS = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 3,
    paddingHorizontal: 10,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    marginHorizontal: 6,
    marginBottom: 2,
  },
  avatarText: { fontWeight: "700", fontSize: 12 },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#1A1A1A", borderBottomLeftRadius: 4 },
  bubblePending: { opacity: 0.55 },
  bubbleFailed: { borderWidth: 1, borderColor: "#FF453A" },
  senderName: { fontSize: 11, fontWeight: "700", marginBottom: 3 },
  msgText: { color: "#E0E0E0", fontSize: 15, lineHeight: 21 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    gap: 4,
  },
  time: { color: "rgba(255,255,255,0.3)", fontSize: 10 },
});
