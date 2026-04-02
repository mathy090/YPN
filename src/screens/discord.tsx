// src/screens/discord.tsx
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
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
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";

// ── Config ────────────────────────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const AI_URL = process.env.EXPO_PUBLIC_AI_URL
  ? `${process.env.EXPO_PUBLIC_AI_URL}/chat`
  : "https://ypn-1.onrender.com/chat";
const ADMIN_EMAIL = "admin@ypn.co.zw";
const TAB_BAR_H = Platform.OS === "ios" ? 90 : 72;

// ── AsyncStorage keys ─────────────────────────────────────────────────────────
const L1_KEY = (id: string) => `discord_l1_${id}`;
const L2_KEY = (id: string) => `discord_l2_${id}`;
const LAST_MSG_KEY = (id: string) => `discord_last_${id}`;

// ── Types ─────────────────────────────────────────────────────────────────────
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
  order?: number;
};

type LastMessage = { text: string; time: number; unread: number };

// ── Default channels ──────────────────────────────────────────────────────────
const DEFAULT_CHANNELS: Channel[] = [
  {
    id: "general",
    name: "general",
    description: "General YPN community",
    color: "#5865F2",
    emoji: "💬",
    order: 1,
  },
  {
    id: "mental-health",
    name: "mental-health",
    description: "Safe space to talk",
    color: "#57F287",
    emoji: "💚",
    order: 2,
  },
  {
    id: "jobs",
    name: "jobs",
    description: "Opportunities & careers",
    color: "#FEE75C",
    emoji: "💼",
    order: 3,
  },
  {
    id: "education",
    name: "education",
    description: "Learning & resources",
    color: "#EB459E",
    emoji: "📚",
    order: 4,
  },
  {
    id: "prayer",
    name: "prayer",
    description: "Prayer & support",
    color: "#FF7043",
    emoji: "🙏",
    order: 5,
  },
  {
    id: "announcements",
    name: "announcements",
    description: "YPN news & updates",
    color: "#ED4245",
    emoji: "📢",
    order: 6,
  },
];

const AI_CHANNEL: Channel = {
  id: "ai-private",
  name: "YPN AI",
  description: "Your private AI assistant",
  color: "#1DB954",
  emoji: "🤖",
  isAI: true,
  order: 0,
};

// ── AsyncStorage cache helpers ────────────────────────────────────────────────
async function readCache(channelId: string): Promise<Message[] | null> {
  try {
    const raw = await AsyncStorage.getItem(L1_KEY(channelId));
    if (raw) return JSON.parse(raw);
  } catch {}
  try {
    const raw = await AsyncStorage.getItem(L2_KEY(channelId));
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

async function writeCache(channelId: string, messages: Message[]) {
  const raw = JSON.stringify(messages.slice(-80));
  try {
    await AsyncStorage.setItem(L1_KEY(channelId), raw);
  } catch {}
  try {
    await AsyncStorage.setItem(L2_KEY(channelId), raw);
  } catch {}
}

async function saveLastMessage(channelId: string, lm: LastMessage) {
  try {
    await AsyncStorage.setItem(LAST_MSG_KEY(channelId), JSON.stringify(lm));
  } catch {}
}

async function readLastMessage(channelId: string): Promise<LastMessage | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_MSG_KEY(channelId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Time helper ───────────────────────────────────────────────────────────────
function fmtTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000)
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  const d = Math.floor(diff / 86_400_000);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString([], {
    day: "numeric",
    month: "short",
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CHANNEL LIST
// ══════════════════════════════════════════════════════════════════════════════
function ChannelListScreen({ onOpen }: { onOpen: (ch: Channel) => void }) {
  const insets = useSafeAreaInsets();
  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS);
  const [lastMessages, setLastMessages] = useState<Record<string, LastMessage>>(
    {},
  );
  const [bannerVisible, setBannerVisible] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const bannerAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) =>
      setIsOffline(!state.isConnected),
    );
    fetchChannels();
    loadLastMessages();
    return () => unsub();
  }, []);

  async function fetchChannels() {
    if (isOffline) return;
    try {
      const res = await fetch(`${API_URL}/api/discord/channels`);
      if (!res.ok) throw new Error("Failed");
      const data: Channel[] = await res.json();
      setChannels(data.sort((a, b) => (a.order ?? 99) - (b.order ?? 99)));
    } catch {
      setChannels(DEFAULT_CHANNELS);
    }
  }

  async function loadLastMessages() {
    const map: Record<string, LastMessage> = {};
    for (const ch of [AI_CHANNEL, ...DEFAULT_CHANNELS]) {
      const lm = await readLastMessage(ch.id);
      if (lm) map[ch.id] = lm;
    }
    setLastMessages(map);
  }

  function dismissBanner() {
    Animated.timing(bannerAnim, {
      toValue: 0,
      duration: 280,
      useNativeDriver: true,
    }).start(() => setBannerVisible(false));
  }

  const renderChannel = ({ item }: { item: Channel }) => {
    const lm = lastMessages[item.id];
    return (
      <TouchableOpacity
        style={ls.row}
        onPress={() => onOpen(item)}
        activeOpacity={0.75}
      >
        <View
          style={[
            ls.avatar,
            {
              backgroundColor: item.color + "22",
              borderColor: item.color + "55",
            },
          ]}
        >
          <Text style={ls.avatarEmoji}>{item.emoji}</Text>
          {item.isAI && <View style={ls.onlineDot} />}
        </View>
        <View style={ls.textBlock}>
          <View style={ls.topRow}>
            <Text style={ls.channelName} numberOfLines={1}>
              {item.isAI ? item.name : `#${item.name}`}
            </Text>
            {lm && <Text style={ls.timeLabel}>{fmtTime(lm.time)}</Text>}
          </View>
          <View style={ls.bottomRow}>
            <Text style={ls.preview} numberOfLines={1}>
              {lm ? lm.text : item.description}
            </Text>
            {lm && lm.unread > 0 && (
              <View style={[ls.badge, { backgroundColor: item.color }]}>
                <Text style={ls.badgeText}>
                  {lm.unread > 99 ? "99+" : lm.unread}
                </Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={ls.root}>
      <View style={[ls.header, { paddingTop: insets.top + 8 }]}>
        <Text style={ls.headerTitle}>Community</Text>
        <TouchableOpacity style={ls.headerBtn} onPress={fetchChannels}>
          <Ionicons name="refresh-outline" size={20} color="#B3B3B3" />
        </TouchableOpacity>
      </View>
      {bannerVisible && (
        <Animated.View style={[ls.banner, { opacity: bannerAnim }]}>
          <TouchableOpacity
            style={ls.bannerRow}
            activeOpacity={0.8}
            onPress={() =>
              Alert.alert(
                "Upload a Video",
                "Share your content with the YPN community! Videos appear in the For You feed.\n\nContact admin to upload.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Contact Admin",
                    onPress: () =>
                      Linking.openURL(
                        `mailto:${ADMIN_EMAIL}?subject=Video Upload Request`,
                      ),
                  },
                ],
              )
            }
          >
            <View style={ls.bannerIconWrap}>
              <Ionicons name="videocam" size={18} color="#1DB954" />
            </View>
            <View style={ls.bannerTextWrap}>
              <Text style={ls.bannerTitle}>Share your story</Text>
              <Text style={ls.bannerDesc}>
                Upload videos to the For You feed — contact admin
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#555" />
          </TouchableOpacity>
          <View style={ls.bannerDivider} />
          <TouchableOpacity
            style={ls.bannerRow}
            activeOpacity={0.8}
            onPress={() =>
              Alert.alert(
                "Suggest a Channel",
                "Have an idea for a new community channel? Let us know!",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Contact Admin",
                    onPress: () =>
                      Linking.openURL(
                        `mailto:${ADMIN_EMAIL}?subject=Channel Suggestion`,
                      ),
                  },
                ],
              )
            }
          >
            <View style={[ls.bannerIconWrap, { backgroundColor: "#5865F222" }]}>
              <Ionicons name="add-circle-outline" size={18} color="#5865F2" />
            </View>
            <View style={ls.bannerTextWrap}>
              <Text style={ls.bannerTitle}>Suggest a channel</Text>
              <Text style={ls.bannerDesc}>
                Don't see your topic? Contact admin to request
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#555" />
          </TouchableOpacity>
          <TouchableOpacity style={ls.bannerDismiss} onPress={dismissBanner}>
            <Ionicons name="close" size={14} color="#555" />
          </TouchableOpacity>
        </Animated.View>
      )}
      <FlatList
        data={[AI_CHANNEL, ...channels]}
        keyExtractor={(ch) => ch.id}
        renderItem={renderChannel}
        contentContainerStyle={{ paddingBottom: TAB_BAR_H + insets.bottom + 8 }}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={ls.separator} />}
        ListHeaderComponent={<Text style={ls.sectionLabel}>CHANNELS</Text>}
      />
      {isOffline && (
        <View style={ls.offlineBanner}>
          <Ionicons name="wifi-off-outline" size={14} color="#fff" />
          <Text style={ls.offlineText}>Offline • Cached channels only</Text>
        </View>
      )}
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT SCREEN
// ══════════════════════════════════════════════════════════════════════════════
function ChatScreen({
  channel,
  onBack,
  onNewMessage,
}: {
  channel: Channel;
  onBack: () => void;
  onNewMessage: (lm: LastMessage) => void;
}) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [aiTyping, setAiTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const listRef = useRef<FlatList>(null);
  const me = auth.currentUser;
  const statusBarH =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) =>
      setIsOffline(!state.isConnected),
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    setLoading(true);
    setMessages([]);
    readCache(channel.id).then((cached) => {
      if (cached?.length) {
        setMessages(cached);
        setLoading(false);
        scrollToBottom();
      }
    });
    if (channel.isAI) {
      setLoading(false);
      return;
    }
    if (isOffline) {
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, "channels", channel.id, "messages"),
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
        writeCache(channel.id, msgs);
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          const lm: LastMessage = {
            text: last.text,
            time: last.createdAt,
            unread: 0,
          };
          saveLastMessage(channel.id, lm);
          onNewMessage(lm);
        }
        scrollToBottom();
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [channel.id, isOffline]);

  const sendToAI = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return;
      if (isOffline) {
        setMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            text: "No internet connection. Please check your network.",
            uid: "ypn-ai",
            displayName: "YPN AI",
            createdAt: Date.now(),
            isAI: true,
          },
        ]);
        return;
      }
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
        writeCache(channel.id, next);
        const lm: LastMessage = { text, time: Date.now(), unread: 0 };
        saveLastMessage(channel.id, lm);
        onNewMessage(lm);
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
          writeCache(channel.id, next);
          const lm: LastMessage = { text: reply, time: Date.now(), unread: 0 };
          saveLastMessage(channel.id, lm);
          onNewMessage(lm);
          return next;
        });
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            text: "Couldn't reach the AI. Please check your connection.",
            uid: "ypn-ai",
            displayName: "YPN AI",
            createdAt: Date.now(),
            isAI: true,
          },
        ]);
      } finally {
        setAiTyping(false);
        setSending(false);
        scrollToBottom();
      }
    },
    [sending, me, channel.id, isOffline],
  );

  const sendToFirestore = useCallback(
    async (text: string) => {
      if (!text.trim() || !me || sending || isOffline) {
        if (isOffline)
          setMessages((prev) => [
            ...prev,
            {
              id: `err_${Date.now()}`,
              text: "No internet connection.",
              uid: me?.uid ?? "user",
              displayName: me?.displayName ?? "You",
              createdAt: Date.now(),
              failed: true,
            },
          ]);
        return;
      }
      setSending(true);
      setInput("");
      const oid = `local_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: oid,
          text,
          uid: me.uid,
          displayName: me.displayName ?? me.email?.split("@")[0] ?? "Member",
          createdAt: Date.now(),
          pending: true,
        },
      ]);
      scrollToBottom();
      try {
        await addDoc(collection(db, "channels", channel.id, "messages"), {
          text,
          uid: me.uid,
          displayName:
            me.displayName ?? me.email?.split("@")[0] ?? "YPN Member",
          createdAt: serverTimestamp(),
        });
        setMessages((prev) => prev.filter((m) => m.id !== oid));
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === oid ? { ...m, pending: false, failed: true } : m,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [sending, me, channel.id, isOffline],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    channel.isAI ? sendToAI(text) : sendToFirestore(text);
  }, [input, channel.isAI, sendToAI, sendToFirestore]);

  const renderMessage = useCallback(
    ({ item }: { item: Message }) => {
      const isMe = item.uid === me?.uid;
      const isAI = item.isAI;
      const time = new Date(item.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      return (
        <View style={[cs.msgRow, isMe && !isAI && cs.msgRowMe]}>
          {!isMe && (
            <View
              style={[
                cs.msgAvatar,
                {
                  backgroundColor: channel.color + "33",
                  borderColor: channel.color + "55",
                },
              ]}
            >
              <Text style={{ fontSize: 13 }}>
                {isAI ? "🤖" : (item.displayName?.[0] ?? "?").toUpperCase()}
              </Text>
            </View>
          )}
          <View
            style={[
              cs.bubble,
              isMe && !isAI
                ? [cs.bubbleMe, { backgroundColor: channel.color }]
                : cs.bubbleThem,
              item.pending && cs.bubblePending,
              item.failed && cs.bubbleFailed,
            ]}
          >
            {!isMe && (
              <Text style={[cs.senderName, { color: channel.color }]}>
                {isAI ? "YPN AI 🤖" : item.displayName}
              </Text>
            )}
            <Text
              style={[
                cs.msgText,
                isMe &&
                  !isAI && {
                    color: channel.color === "#FEE75C" ? "#000" : "#fff",
                  },
              ]}
            >
              {item.text}
            </Text>
            <View style={cs.msgMeta}>
              <Text
                style={[
                  cs.timeText,
                  isMe && !isAI && { color: "rgba(0,0,0,0.4)" },
                ]}
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
        </View>
      );
    },
    [me, channel],
  );

  return (
    <View style={cs.root}>
      <View
        style={[
          cs.header,
          {
            paddingTop:
              insets.top + (Platform.OS === "ios" ? 0 : statusBarH) + 8,
          },
        ]}
      >
        <TouchableOpacity
          onPress={onBack}
          style={cs.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View
          style={[
            cs.headerAvatar,
            {
              backgroundColor: channel.color + "33",
              borderColor: channel.color + "66",
            },
          ]}
        >
          <Text style={{ fontSize: 16 }}>{channel.emoji}</Text>
          {channel.isAI && <View style={cs.headerOnlineDot} />}
        </View>
        <View style={cs.headerMid}>
          <Text style={cs.headerTitle}>
            {channel.isAI ? channel.name : `#${channel.name}`}
          </Text>
          <Text style={cs.headerSub}>
            {channel.isAI
              ? aiTyping
                ? "typing…"
                : "Online"
              : channel.description}
          </Text>
        </View>
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={
          (Platform.OS === "ios" ? insets.top : statusBarH) + 60
        }
      >
        {loading ? (
          <View style={cs.centre}>
            <ActivityIndicator color={channel.color} size="large" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderMessage}
            contentContainerStyle={{
              padding: 12,
              paddingBottom: TAB_BAR_H + insets.bottom + 60,
            }}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={scrollToBottom}
            ListEmptyComponent={
              <View style={cs.emptyWrap}>
                <Text style={{ fontSize: 48 }}>{channel.emoji}</Text>
                <Text style={cs.emptyTitle}>
                  {channel.isAI ? "Ask me anything!" : `#${channel.name}`}
                </Text>
                <Text style={cs.emptyDesc}>{channel.description}</Text>
              </View>
            }
            ListFooterComponent={
              aiTyping ? (
                <View style={cs.msgRow}>
                  <View
                    style={[
                      cs.msgAvatar,
                      {
                        backgroundColor: "#1DB95433",
                        borderColor: "#1DB95455",
                      },
                    ]}
                  >
                    <Text style={{ fontSize: 13 }}>🤖</Text>
                  </View>
                  <View style={cs.bubbleThem}>
                    <Text style={cs.typingText}>typing…</Text>
                  </View>
                </View>
              ) : null
            }
          />
        )}
        <View
          style={[
            cs.inputBar,
            { paddingBottom: Math.max(insets.bottom - TAB_BAR_H + 16, 8) },
          ]}
        >
          {!me && (
            <View style={cs.authNote}>
              <Ionicons name="lock-closed-outline" size={11} color="#FFA500" />
              <Text style={cs.authNoteText}>Sign in to send messages</Text>
            </View>
          )}
          <View style={cs.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={
                me
                  ? `Message ${channel.isAI ? "YPN AI" : `#${channel.name}`}`
                  : "Sign in to chat"
              }
              placeholderTextColor="#555"
              style={cs.textInput}
              multiline
              maxLength={2000}
              editable={!!me}
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
            />
            <TouchableOpacity
              onPress={handleSend}
              disabled={!input.trim() || sending || !me || isOffline}
              style={[
                cs.sendBtn,
                {
                  backgroundColor:
                    !input.trim() || !me || isOffline ? "#222" : channel.color,
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
                    channel.color === "#FEE75C" && !!input.trim()
                      ? "#000"
                      : "#fff"
                  }
                />
              )}
            </TouchableOpacity>
          </View>
          {isOffline && (
            <Text style={cs.offlineHint}>
              ⚠️ Offline — messages won't send until reconnected
            </Text>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT
// ══════════════════════════════════════════════════════════════════════════════
export default function DiscordScreen() {
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  if (activeChannel)
    return (
      <ChatScreen
        channel={activeChannel}
        onBack={() => setActiveChannel(null)}
        onNewMessage={() => {}}
      />
    );
  return <ChannelListScreen onOpen={setActiveChannel} />;
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLES (added offline banners/hints)
// ══════════════════════════════════════════════════════════════════════════════
const ls = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0D0D0D" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#111",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1E1E1E",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  headerBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#1A1A1A",
    justifyContent: "center",
    alignItems: "center",
  },
  banner: {
    margin: 12,
    marginBottom: 4,
    backgroundColor: "#141414",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2A2A2A",
    overflow: "hidden",
  },
  bannerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  bannerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1DB95422",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  bannerTextWrap: { flex: 1 },
  bannerTitle: {
    color: "#E8E8E8",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 1,
  },
  bannerDesc: { color: "#666", fontSize: 11, lineHeight: 15 },
  bannerDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#222",
    marginHorizontal: 14,
  },
  bannerDismiss: { position: "absolute", top: 8, right: 8, padding: 4 },
  sectionLabel: {
    color: "#444",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#0D0D0D",
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1.5,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
    flexShrink: 0,
    position: "relative",
  },
  avatarEmoji: { fontSize: 22 },
  onlineDot: {
    position: "absolute",
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#1DB954",
    borderWidth: 2,
    borderColor: "#0D0D0D",
  },
  textBlock: { flex: 1, minWidth: 0 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 3,
  },
  channelName: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    flex: 1,
    marginRight: 8,
  },
  timeLabel: { color: "#555", fontSize: 11, flexShrink: 0 },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  preview: { color: "#666", fontSize: 13, flex: 1, marginRight: 8 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 5,
    flexShrink: 0,
  },
  badgeText: { color: "#000", fontSize: 11, fontWeight: "800" },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#1A1A1A",
    marginLeft: 80,
  },
  offlineBanner: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#333",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 6,
  },
  offlineText: { color: "#fff", fontSize: 11, fontWeight: "500" },
});

const cs = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0D0D0D" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: "#111",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1E1E1E",
    gap: 10,
    minHeight: 56,
  },
  backBtn: {
    width: 32,
    height: 32,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  headerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
    flexShrink: 0,
  },
  headerOnlineDot: {
    position: "absolute",
    bottom: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#1DB954",
    borderWidth: 1.5,
    borderColor: "#111",
  },
  headerMid: { flex: 1 },
  headerTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  headerSub: { color: "#666", fontSize: 11, marginTop: 1 },
  centre: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyWrap: { alignItems: "center", padding: 32, gap: 10, marginTop: 60 },
  emptyTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginTop: 4 },
  emptyDesc: {
    color: "#555",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  msgRow: {
    flexDirection: "row",
    marginVertical: 2,
    paddingHorizontal: 4,
    alignItems: "flex-end",
  },
  msgRowMe: { flexDirection: "row-reverse" },
  msgAvatar: {
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
  typingText: {
    color: "#8E8E93",
    fontSize: 14,
    fontStyle: "italic",
    padding: 4,
  },
  msgMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 3,
    gap: 3,
  },
  timeText: { color: "rgba(255,255,255,0.25)", fontSize: 9 },
  inputBar: {
    backgroundColor: "#111",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1E1E1E",
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
  authNote: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 4,
    marginBottom: 4,
  },
  authNoteText: { color: "#FFA500", fontSize: 11 },
  offlineHint: {
    color: "#FFA500",
    fontSize: 10,
    textAlign: "center",
    marginTop: 4,
    fontStyle: "italic",
  },
});
