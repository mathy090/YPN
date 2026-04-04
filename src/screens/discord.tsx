// src/screens/discord.tsx
// ─────────────────────────────────────────────────────────────────────────────
// YPN Discord-style community chat
//   • Tab bar hidden on mount, restored on unmount (WhatsApp behaviour)
//   • AI private channel + 6 community Firestore channels
//   • 3-dot typing indicator for AI channel
//   • Two-layer cache: MMKV (L1) → AsyncStorage (L2), capped at 80 msgs/channel
//   • Optimistic send with pending/failed states
//   • Sidebar channel switcher with overlay
// ─────────────────────────────────────────────────────────────────────────────

import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
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
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
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
import { MMKV } from "react-native-mmkv";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";

// ── Constants ──────────────────────────────────────────────────────────────────
const AI_URL = process.env.EXPO_PUBLIC_AI_URL
  ? `${process.env.EXPO_PUBLIC_AI_URL}/chat`
  : "https://ypn-1.onrender.com/chat";

const TAB_BAR_H = Platform.OS === "ios" ? 90 : 72;
const MAX_CACHED = 80;

// ── MMKV singleton ─────────────────────────────────────────────────────────────
let _mmkv: MMKV | null = null;
const mmkv = (): MMKV => {
  if (!_mmkv) _mmkv = new MMKV({ id: "ypn-discord-v5" });
  return _mmkv;
};

// ── Cache helpers ──────────────────────────────────────────────────────────────
const L1_KEY = (id: string) => `disc_l1_${id}`;
const L2_KEY = (id: string) => `disc_l2_${id}`;

function readL1(channelId: string): Message[] | null {
  try {
    const raw = mmkv().getString(L1_KEY(channelId));
    return raw ? (JSON.parse(raw) as Message[]) : null;
  } catch {
    return null;
  }
}

function writeL1(channelId: string, msgs: Message[]): void {
  try {
    mmkv().set(L1_KEY(channelId), JSON.stringify(msgs.slice(-MAX_CACHED)));
  } catch {}
}

async function readL2(channelId: string): Promise<Message[] | null> {
  try {
    const raw = await AsyncStorage.getItem(L2_KEY(channelId));
    return raw ? (JSON.parse(raw) as Message[]) : null;
  } catch {
    return null;
  }
}

async function writeL2(channelId: string, msgs: Message[]): Promise<void> {
  try {
    await AsyncStorage.setItem(
      L2_KEY(channelId),
      JSON.stringify(msgs.slice(-MAX_CACHED)),
    );
  } catch {}
}

// ── Types ──────────────────────────────────────────────────────────────────────
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

// ── Channel definitions ────────────────────────────────────────────────────────
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

// ── 3-dot typing indicator ─────────────────────────────────────────────────────
const TypingIndicator = React.memo(({ color }: { color: string }) => {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(dot, {
            toValue: -6,
            duration: 280,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 280,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.delay(340),
        ]),
      ),
    );
    Animated.parallel(anims).start();
    return () => anims.forEach((a) => a.stop());
  }, []);

  return (
    <View style={ty.wrap}>
      <View style={[ty.bubble, { backgroundColor: "#1A1A1A" }]}>
        {dots.map((dot, i) => (
          <Animated.View
            key={i}
            style={[
              ty.dot,
              { backgroundColor: color, transform: [{ translateY: dot }] },
            ]}
          />
        ))}
      </View>
    </View>
  );
});

const ty = StyleSheet.create({
  wrap: { alignSelf: "flex-start", marginLeft: 10, marginBottom: 6 },
  bubble: {
    flexDirection: "row",
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 5,
    alignItems: "center",
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
});

// ── Time formatter ─────────────────────────────────────────────────────────────
function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Message bubble ─────────────────────────────────────────────────────────────
const MessageBubble = React.memo(
  ({
    item,
    meUid,
    channelColor,
  }: {
    item: Message;
    meUid: string | undefined;
    channelColor: string;
  }) => {
    const isMe = item.uid === meUid;
    const isAI = item.isAI;

    return (
      <View style={[mb.row, isMe && !isAI && mb.rowMe]}>
        {!isMe && (
          <View
            style={[
              mb.avatar,
              {
                backgroundColor: channelColor + "22",
                borderColor: channelColor + "44",
              },
            ]}
          >
            <Text style={[mb.avatarText, { color: channelColor }]}>
              {isAI ? "🤖" : (item.displayName?.[0] ?? "?").toUpperCase()}
            </Text>
          </View>
        )}

        <View
          style={[
            mb.bubble,
            isMe && !isAI
              ? [mb.bubbleMe, { backgroundColor: channelColor }]
              : mb.bubbleThem,
            item.pending && mb.bubblePending,
            item.failed && mb.bubbleFailed,
          ]}
        >
          {!isMe && (
            <Text style={[mb.senderName, { color: channelColor }]}>
              {isAI ? "YPN AI 🤖" : item.displayName}
            </Text>
          )}
          <Text
            style={[
              mb.msgText,
              isMe &&
                !isAI && {
                  color: channelColor === "#FEE75C" ? "#000" : "#fff",
                },
            ]}
          >
            {item.text}
          </Text>
          <View style={mb.meta}>
            <Text
              style={[mb.time, isMe && !isAI && { color: "rgba(0,0,0,0.4)" }]}
            >
              {timeStr(item.createdAt)}
            </Text>
            {item.pending && (
              <Ionicons name="time-outline" size={10} color="#8E8E93" />
            )}
            {item.failed && (
              <Ionicons name="alert-circle-outline" size={10} color="#FF453A" />
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
      </View>
    );
  },
);

const mb = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 3,
    paddingHorizontal: 8,
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
    flexShrink: 0,
  },
  avatarText: { fontWeight: "700", fontSize: 11 },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#1A1A1A", borderBottomLeftRadius: 4 },
  bubblePending: { opacity: 0.5 },
  bubbleFailed: { borderWidth: 1, borderColor: "#FF453A" },
  senderName: { fontSize: 10, fontWeight: "700", marginBottom: 3 },
  msgText: { color: "#E0E0E0", fontSize: 14, lineHeight: 20 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    gap: 3,
  },
  time: { color: "rgba(255,255,255,0.25)", fontSize: 9 },
});

// ── Channel item (sidebar) ─────────────────────────────────────────────────────
const ChannelItem = React.memo(
  ({
    channel,
    isActive,
    onPress,
  }: {
    channel: Channel;
    isActive: boolean;
    onPress: () => void;
  }) => (
    <TouchableOpacity
      style={[ci.item, isActive && { backgroundColor: channel.color + "18" }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View
        style={[
          ci.icon,
          {
            backgroundColor: channel.color + "22",
            borderColor: channel.color + "44",
          },
        ]}
      >
        <Text style={{ fontSize: 15 }}>{channel.emoji}</Text>
      </View>
      <View style={ci.textWrap}>
        <Text
          style={[
            ci.name,
            isActive && { color: channel.color, fontWeight: "700" },
          ]}
          numberOfLines={1}
        >
          {channel.isAI ? channel.name : `#${channel.name}`}
        </Text>
        <Text style={ci.desc} numberOfLines={1}>
          {channel.description}
        </Text>
      </View>
      {isActive && (
        <View style={[ci.dot, { backgroundColor: channel.color }]} />
      )}
    </TouchableOpacity>
  ),
);

const ci = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 9,
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
  textWrap: { flex: 1 },
  name: { color: "#8E8E93", fontSize: 13, fontWeight: "500" },
  desc: { color: "#3A3A3A", fontSize: 11, marginTop: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});

// ══════════════════════════════════════════════════════════════════════════════
// Main screen
// ══════════════════════════════════════════════════════════════════════════════
export default function DiscordScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

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

  // ── Hide tab bar on mount — WhatsApp behaviour ──────────────────────────────
  useLayoutEffect(() => {
    navigation.setOptions({ tabBarStyle: { display: "none" } });
    return () => {
      navigation.setOptions({ tabBarStyle: undefined });
    };
  }, [navigation]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  // ── Load channel: L1 → L2 → Firestore ──────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setMessages([]);

    // Serve from cache immediately
    const l1 = readL1(activeChannel.id);
    if (l1 && l1.length > 0) {
      setMessages(l1);
      setLoading(false);
      scrollToBottom();
    } else {
      readL2(activeChannel.id).then((l2) => {
        if (l2 && l2.length > 0) {
          setMessages(l2);
          writeL1(activeChannel.id, l2);
          setLoading(false);
          scrollToBottom();
        }
      });
    }

    // AI channel — no Firestore subscription
    if (activeChannel.isAI) {
      setLoading(false);
      return;
    }

    // Firestore real-time subscription
    const q = query(
      collection(db, "channels", activeChannel.id, "messages"),
      orderBy("createdAt", "asc"),
      limit(MAX_CACHED),
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
        writeL1(activeChannel.id, msgs);
        writeL2(activeChannel.id, msgs);
        scrollToBottom();
      },
      () => setLoading(false),
    );

    return () => unsub();
  }, [activeChannel.id]);

  // ── Send to AI channel ──────────────────────────────────────────────────────
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
        writeL1(activeChannel.id, next);
        writeL2(activeChannel.id, next);
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
        const reply =
          data.reply ?? data.message ?? data.text ?? "I'm here to help!";

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
          writeL1(activeChannel.id, next);
          writeL2(activeChannel.id, next);
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
    [sending, me, activeChannel.id, scrollToBottom],
  );

  // ── Send to Firestore channel ───────────────────────────────────────────────
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
    [sending, me, activeChannel.id, scrollToBottom],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (activeChannel.isAI) sendToAI(text);
    else sendToFirestore(text);
  }, [input, activeChannel.isAI, sendToAI, sendToFirestore]);

  const switchChannel = useCallback((ch: Channel) => {
    setActiveChannel(ch);
    setSidebarOpen(false);
  }, []);

  // ── Render message ──────────────────────────────────────────────────────────
  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        item={item}
        meUid={me?.uid}
        channelColor={activeChannel.color}
      />
    ),
    [me, activeChannel.color],
  );

  const keyExtractor = useCallback((item: Message) => item.id, []);

  // ── Input bar bottom padding (no tab bar — it's hidden) ─────────────────────
  // Use insets.bottom only so keyboard avoidance works cleanly
  const inputPaddingBottom = Math.max(insets.bottom, 8);

  return (
    <View style={s.root}>
      {/* Status bar spacer */}
      {Platform.OS === "android" && (
        <View style={{ height: statusBarH, backgroundColor: "#111" }} />
      )}
      {Platform.OS === "ios" && (
        <View style={{ height: insets.top, backgroundColor: "#111" }} />
      )}

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => setSidebarOpen((p) => !p)}
          style={s.headerBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons
            name={sidebarOpen ? "close" : "menu"}
            size={20}
            color="#fff"
          />
        </TouchableOpacity>

        <Text style={{ fontSize: 16 }}>{activeChannel.emoji}</Text>

        <View style={s.headerTitleWrap}>
          <Text style={s.headerTitle} numberOfLines={1}>
            {activeChannel.isAI ? activeChannel.name : `#${activeChannel.name}`}
          </Text>
          <Text style={s.headerSub} numberOfLines={1}>
            {activeChannel.description}
          </Text>
        </View>

        {activeChannel.isAI && (
          <View
            style={[
              s.aiBadge,
              {
                backgroundColor: activeChannel.color + "22",
                borderColor: activeChannel.color + "44",
              },
            ]}
          >
            <View style={[s.aiDot, { backgroundColor: activeChannel.color }]} />
            <Text style={[s.aiBadgeText, { color: activeChannel.color }]}>
              {aiTyping ? "typing..." : "Online"}
            </Text>
          </View>
        )}
      </View>

      {/* ── Body ── */}
      <View style={s.body}>
        {/* Sidebar overlay */}
        {sidebarOpen && (
          <>
            <Pressable
              style={s.overlay}
              onPress={() => setSidebarOpen(false)}
            />
            <View style={s.sidebar}>
              <Text style={s.sidebarHeading}>YPN Community</Text>

              {/* AI channel first */}
              {CHANNELS.filter((c) => c.isAI).map((ch) => (
                <ChannelItem
                  key={ch.id}
                  channel={ch}
                  isActive={activeChannel.id === ch.id}
                  onPress={() => switchChannel(ch)}
                />
              ))}

              <Text style={s.sectionLabel}>TEXT CHANNELS</Text>

              {CHANNELS.filter((c) => !c.isAI).map((ch) => (
                <ChannelItem
                  key={ch.id}
                  channel={ch}
                  isActive={activeChannel.id === ch.id}
                  onPress={() => switchChannel(ch)}
                />
              ))}
            </View>
          </>
        )}

        {/* ── Chat area ── */}
        <KeyboardAvoidingView
          style={s.chat}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={
            (Platform.OS === "ios" ? insets.top : statusBarH) + 52
          }
        >
          {loading ? (
            <View style={s.centre}>
              <ActivityIndicator color={activeChannel.color} size="large" />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={keyExtractor}
              renderItem={renderMessage}
              contentContainerStyle={[
                s.messageList,
                { paddingBottom: inputPaddingBottom + 64 },
              ]}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={scrollToBottom}
              removeClippedSubviews
              windowSize={5}
              ListEmptyComponent={
                <View style={s.emptyContainer}>
                  <Text style={{ fontSize: 52 }}>{activeChannel.emoji}</Text>
                  <Text style={s.emptyTitle}>
                    {activeChannel.isAI
                      ? "Start a conversation"
                      : `#${activeChannel.name}`}
                  </Text>
                  <Text style={s.emptyDesc}>{activeChannel.description}</Text>
                </View>
              }
              ListFooterComponent={
                aiTyping ? (
                  <TypingIndicator color={activeChannel.color} />
                ) : null
              }
            />
          )}

          {/* ── Input bar ── */}
          <View style={[s.inputBar, { paddingBottom: inputPaddingBottom }]}>
            {!me && (
              <View style={s.authBanner}>
                <Ionicons
                  name="lock-closed-outline"
                  size={11}
                  color="#FFA500"
                />
                <Text style={s.authText}>Sign in to send messages</Text>
              </View>
            )}
            <View style={s.inputRow}>
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
                style={s.textInput}
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
                  s.sendBtn,
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

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
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
    backgroundColor: "rgba(0,0,0,0.55)",
    zIndex: 10,
  },
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    width: 265,
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
  emptyTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
  },
  emptyDesc: {
    color: "#555",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },

  inputBar: {
    backgroundColor: "#111",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2A2A2A",
    paddingTop: 8,
    paddingHorizontal: 10,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
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
