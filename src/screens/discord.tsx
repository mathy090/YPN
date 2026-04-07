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
  Timestamp,
} from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db as firestoreDb } from "../firebase/firestore";
import { chatCacheRead, chatCacheWrite } from "../utils/db";

// ── Constants ──────────────────────────────────────────────────
const AI_URL = process.env.EXPO_PUBLIC_AI_URL
  ? `${process.env.EXPO_PUBLIC_AI_URL}/chat`
  : "https://ypn-1.onrender.com/chat";

const TAB_BAR_H = Platform.OS === "ios" ? 90 : 72;

// ── Types ──────────────────────────────────────────────────────
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

  const statusBarH =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  // ── Load channel ────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setMessages([]);

    // Load from SQLite cache first
    chatCacheRead<Message>(activeChannel.id).then((cached) => {
      if (cached?.length) {
        setMessages(cached);
        setLoading(false);
        scrollToBottom();
      }
    });

    if (activeChannel.isAI) {
      setLoading(false);
      return;
    }

    const q = query(
      collection(firestoreDb, "channels", activeChannel.id, "messages"),
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
        chatCacheWrite(activeChannel.id, msgs);
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
        chatCacheWrite(activeChannel.id, next);
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
          chatCacheWrite(activeChannel.id, next);
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
        await addDoc(
          collection(firestoreDb, "channels", activeChannel.id, "messages"),
          {
            text,
            uid: me.uid,
            displayName:
              me.displayName ?? me.email?.split("@")[0] ?? "YPN Member",
            createdAt: serverTimestamp(),
          },
        );
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
                style={[mS.time, isMe && !isAI && { color: "rgba(0,0,0,0.4)" }]}
              >
                {time}
              </Text>
              {item.pending && (
                <Ionicons name="time-outline" size={10} color="#8E8E93" />
              )}
              {item.failed && (
                <Ionicons
                  name="alert-circle-outline"
                  size={10}
                  color="#FF453A"
                />
              )}
              {isMe && !item.pending && !item.failed && (
                <Ionicons
                  name="checkmark-done"
                  size={10}
                  color={isMe && !isAI ? "rgba(0,0,0,0.4)" : "#8E8E93"}
                />
              )}
            </View>
          </View>
        </Pressable>
      );
    },
    [me, activeChannel],
  );

  const inputBarBottom = TAB_BAR_H + insets.bottom - insets.bottom;

  return (
    <View style={dS.root}>
      {Platform.OS === "android" && (
        <View style={{ height: statusBarH, backgroundColor: "#111" }} />
      )}
      {Platform.OS === "ios" && (
        <View style={{ height: insets.top, backgroundColor: "#111" }} />
      )}

      {/* Header */}
      <View style={dS.header}>
        <TouchableOpacity
          onPress={() => setSidebarOpen((p) => !p)}
          style={dS.headerBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons
            name={sidebarOpen ? "close" : "menu"}
            size={20}
            color="#fff"
          />
        </TouchableOpacity>

        <Text style={{ fontSize: 16 }}>{activeChannel.emoji}</Text>

        <View style={dS.headerTitleWrap}>
          <Text style={dS.headerTitle} numberOfLines={1}>
            {activeChannel.isAI ? activeChannel.name : `#${activeChannel.name}`}
          </Text>
          <Text style={dS.headerSub} numberOfLines={1}>
            {activeChannel.description}
          </Text>
        </View>

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
            <View
              style={[dS.aiDot, { backgroundColor: activeChannel.color }]}
            />
            <Text style={[dS.aiBadgeText, { color: activeChannel.color }]}>
              Online
            </Text>
          </View>
        )}
      </View>

      {/* Body */}
      <View style={dS.body}>
        {sidebarOpen && (
          <>
            <Pressable
              style={dS.overlay}
              onPress={() => setSidebarOpen(false)}
            />
            <View
              style={[
                dS.sidebar,
                { paddingBottom: insets.bottom + TAB_BAR_H + 8 },
              ]}
            >
              <Text style={dS.sidebarHeading}>YPN Community</Text>

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
          </>
        )}

        {/* Chat area */}
        <KeyboardAvoidingView
          style={dS.chat}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={
            (Platform.OS === "ios" ? insets.top : statusBarH) + 52
          }
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
              contentContainerStyle={[
                dS.messageList,
                { paddingBottom: TAB_BAR_H + insets.bottom + 56 },
              ]}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={scrollToBottom}
              ListEmptyComponent={
                <View style={dS.emptyContainer}>
                  <Text style={{ fontSize: 52 }}>{activeChannel.emoji}</Text>
                  <Text style={dS.emptyTitle}>
                    {activeChannel.isAI
                      ? "Start a conversation"
                      : `#${activeChannel.name}`}
                  </Text>
                  <Text style={dS.emptyDesc}>{activeChannel.description}</Text>
                </View>
              }
              ListFooterComponent={
                aiTyping ? (
                  <View style={[mS.row, { paddingHorizontal: 10 }]}>
                    <View
                      style={[
                        mS.avatar,
                        {
                          backgroundColor: "#1DB95433",
                          borderColor: "#1DB95455",
                        },
                      ]}
                    >
                      <Text style={{ fontSize: 14 }}>🤖</Text>
                    </View>
                    <View style={mS.bubbleThem}>
                      <Text style={dS.typingText}>typing…</Text>
                    </View>
                  </View>
                ) : null
              }
            />
          )}

          {/* Input bar */}
          <View
            style={[
              dS.inputBar,
              { paddingBottom: TAB_BAR_H + insets.bottom - 48 },
            ]}
          >
            {!me && (
              <View style={dS.authBanner}>
                <Ionicons
                  name="lock-closed-outline"
                  size={11}
                  color="#FFA500"
                />
                <Text style={dS.authText}>Sign in to send messages</Text>
              </View>
            )}
            <View style={dS.inputRow}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={
                  me
                    ? `Message ${
                        activeChannel.isAI ? "YPN AI" : `#${activeChannel.name}`
                      }`
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
                    size={17}
                    color={
                      activeChannel.color === "#FEE75C" && !!input.trim()
                        ? "#000"
                        : "#fff"
                    }
                  />
                )}
              </TouchableOpacity>
            </View>
          </View>
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
        isActive && { backgroundColor: channel.color + "18" },
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
        <Text style={{ fontSize: 15 }}>{channel.emoji}</Text>
      </View>
      <View style={sideS.itemText}>
        <Text
          style={[
            sideS.chName,
            isActive && { color: channel.color, fontWeight: "700" },
          ]}
          numberOfLines={1}
        >
          {channel.isAI ? channel.name : `#${channel.name}`}
        </Text>
        <Text style={sideS.chDesc} numberOfLines={1}>
          {channel.description}
        </Text>
      </View>
      {isActive && (
        <View style={[sideS.activeDot, { backgroundColor: channel.color }]} />
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#111",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2A2A2A",
    gap: 8,
    minHeight: 52,
  },
  headerBtn: {
    width: 32,
    height: 32,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  headerSub: { color: "#555", fontSize: 11, marginTop: 1 },
  aiBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    gap: 5,
  },
  aiDot: { width: 6, height: 6, borderRadius: 3 },
  aiBadgeText: { fontSize: 11, fontWeight: "700" },
  body: { flex: 1, position: "relative" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    zIndex: 10,
  },
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    width: 260,
    backgroundColor: "#111",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "#2A2A2A",
    paddingTop: 12,
    paddingHorizontal: 8,
    zIndex: 20,
  },
  sidebarHeading: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2A2A2A",
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  sectionLabel: {
    color: "#444",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    paddingHorizontal: 8,
    marginTop: 14,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  chat: { flex: 1 },
  messageList: { paddingVertical: 8, paddingHorizontal: 4 },
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    minHeight: 300,
  },
  emptyContainer: {
    alignItems: "center",
    padding: 32,
    gap: 10,
    marginTop: 60,
  },
  emptyTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginTop: 4 },
  emptyDesc: {
    color: "#555",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  typingText: { color: "#555", fontStyle: "italic", fontSize: 13 },
  inputBar: {
    backgroundColor: "#111",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2A2A2A",
    paddingTop: 8,
    paddingHorizontal: 10,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  textInput: {
    flex: 1,
    backgroundColor: "#1A1A1A",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    color: "#fff",
    fontSize: 15,
    maxHeight: 100,
    lineHeight: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2A2A2A",
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
  },
  authBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 4,
    marginBottom: 6,
  },
  authText: { color: "#FFA500", fontSize: 11 },
});

const sideS = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 2,
    gap: 10,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    justifyContent: "center",
    alignItems: "center",
  },
  itemText: { flex: 1 },
  chName: { color: "#8E8E93", fontSize: 13, fontWeight: "500" },
  chDesc: { color: "#3A3A3A", fontSize: 11, marginTop: 1 },
  activeDot: { width: 6, height: 6, borderRadius: 3 },
});

const mS = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 2,
    paddingHorizontal: 8,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    marginHorizontal: 6,
    marginBottom: 2,
    flexShrink: 0,
  },
  avatarText: { fontWeight: "700", fontSize: 11 },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 16,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#1A1A1A", borderBottomLeftRadius: 4 },
  bubblePending: { opacity: 0.5 },
  bubbleFailed: { borderWidth: 1, borderColor: "#FF453A" },
  senderName: { fontSize: 10, fontWeight: "700", marginBottom: 2 },
  msgText: { color: "#E0E0E0", fontSize: 14, lineHeight: 20 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 3,
    gap: 3,
  },
  time: { color: "rgba(255,255,255,0.25)", fontSize: 9 },
});
