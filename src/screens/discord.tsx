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
  Animated,
  FlatList,
  Keyboard,
  KeyboardEvent,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { MMKV } from "react-native-mmkv";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";

// ── Config ──────────────────────────────────────────────────────
const AI_URL = process.env.EXPO_PUBLIC_AI_URL
  ? `${process.env.EXPO_PUBLIC_AI_URL}/chat`
  : "https://ypn-1.onrender.com/chat";
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const ADMIN_EMAIL = "tafadzwarunowanda@gmail.com";
const TAB_BAR_H = Platform.OS === "ios" ? 90 : 60;

// ── Two-layer message + channel cache ───────────────────────────
let _mmkv: MMKV | null = null;
const store = () => {
  if (!_mmkv) _mmkv = new MMKV({ id: "ypn-discord-v6" });
  return _mmkv;
};
const MSG_L1 = (id: string) => `msg_l1_${id}`;
const MSG_L2 = (id: string) => `msg_l2_${id}`;
const CH_KEY = "channels_v2";

async function readMsgCache(id: string): Promise<Message[] | null> {
  try {
    const raw = store().getString(MSG_L1(id));
    if (raw) return JSON.parse(raw);
  } catch {}
  try {
    const raw = await AsyncStorage.getItem(MSG_L2(id));
    if (raw) {
      store().set(MSG_L1(id), raw);
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

async function writeMsgCache(id: string, msgs: Message[]) {
  const raw = JSON.stringify(msgs.slice(-80));
  try {
    store().set(MSG_L1(id), raw);
  } catch {}
  try {
    await AsyncStorage.setItem(MSG_L2(id), raw);
  } catch {}
}

function readChannelCache(): Channel[] | null {
  try {
    const raw = store().getString(CH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeChannelCache(ch: Channel[]) {
  try {
    store().set(CH_KEY, JSON.stringify(ch));
  } catch {}
}

// ── Types ────────────────────────────────────────────────────────
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

// ── Static AI channel — always first ────────────────────────────
const AI_CHANNEL: Channel = {
  id: "ai-private",
  name: "Team YPN",
  description: "Your private AI assistant",
  color: "#1DB954",
  emoji: "🤖",
  isAI: true,
};

// ── Email helper ─────────────────────────────────────────────────
function openEmail(subject: string, body: string) {
  Linking.openURL(
    `mailto:${ADMIN_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  ).catch(() => {});
}

// ── Android keyboard hook ────────────────────────────────────────
// Animates input bar to sit right above the keyboard on Android 11+
function useKeyboardOffset() {
  const offset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const onShow = (e: KeyboardEvent) => {
      Animated.timing(offset, {
        toValue: e.endCoordinates.height,
        duration: e.duration > 0 ? e.duration : 220,
        useNativeDriver: false,
      }).start();
    };

    const onHide = (e: KeyboardEvent) => {
      Animated.timing(offset, {
        toValue: 0,
        duration: e.duration > 0 ? e.duration : 180,
        useNativeDriver: false,
      }).start();
    };

    const s1 = Keyboard.addListener("keyboardDidShow", onShow);
    const s2 = Keyboard.addListener("keyboardDidHide", onHide);
    return () => {
      s1.remove();
      s2.remove();
    };
  }, []);

  return offset;
}

// ════════════════════════════════════════════════════════════════
// CHANNEL LIST SCREEN
// ════════════════════════════════════════════════════════════════
function ChannelListScreen({
  channels,
  loadingChannels,
  onSelect,
}: {
  channels: Channel[];
  loadingChannels: boolean;
  onSelect: (ch: Channel) => void;
}) {
  const insets = useSafeAreaInsets();
  const statusBarH =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;
  const allChannels: Channel[] = [AI_CHANNEL, ...channels];

  return (
    <View
      style={[
        ls.root,
        { paddingTop: Platform.OS === "android" ? statusBarH : insets.top },
      ]}
    >
      {/* Header */}
      <View style={ls.header}>
        <Text style={ls.headerTitle}>YPN Community</Text>
        <View style={ls.onlineDot} />
      </View>

      {/* Banners */}
      <View style={ls.bannersWrap}>
        <TouchableOpacity
          style={[ls.banner, { borderLeftColor: "#5865F2" }]}
          activeOpacity={0.8}
          onPress={() =>
            openEmail(
              "Add my content to For You",
              "Hi,\n\nI would like to add my social content to the YPN For You feed.\n\nMy name: \nMy social handle: \nPlatform (TikTok / Instagram / YouTube): \n\nThank you!",
            )
          }
        >
          <View style={[ls.bannerIcon, { backgroundColor: "#5865F222" }]}>
            <Ionicons name="film-outline" size={18} color="#5865F2" />
          </View>
          <View style={ls.bannerBody}>
            <Text style={ls.bannerTitle}>Add content to For You</Text>
            <Text style={ls.bannerSub}>Contact admin</Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color="#3A3A3A" />
        </TouchableOpacity>

        <TouchableOpacity
          style={[ls.banner, { borderLeftColor: "#FEE75C" }]}
          activeOpacity={0.8}
          onPress={() =>
            openEmail(
              "Channel suggestion for YPN",
              "Hi,\n\nI would like to suggest a new community channel:\n\nChannel name: \nDescription: \nWhy it would be useful: \n\nThank you!",
            )
          }
        >
          <View style={[ls.bannerIcon, { backgroundColor: "#FEE75C22" }]}>
            <Ionicons name="bulb-outline" size={18} color="#FEE75C" />
          </View>
          <View style={ls.bannerBody}>
            <Text style={ls.bannerTitle}>Suggest a channel</Text>
            <Text style={ls.bannerSub}>Contact admin</Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color="#3A3A3A" />
        </TouchableOpacity>
      </View>

      {/* Section label */}
      <View style={ls.sectionRow}>
        <Text style={ls.sectionLabel}>CHATS</Text>
        <View style={ls.sectionLine} />
      </View>

      {/* Channel rows */}
      {loadingChannels && channels.length === 0 ? (
        <View style={ls.loadingWrap}>
          <ActivityIndicator color="#1DB954" />
          <Text style={ls.loadingText}>Loading channels…</Text>
        </View>
      ) : (
        <FlatList
          data={allChannels}
          keyExtractor={(ch) => ch.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: TAB_BAR_H + insets.bottom + 12,
          }}
          renderItem={({ item, index }) => (
            <TouchableOpacity
              style={[ls.row, index < allChannels.length - 1 && ls.rowDivider]}
              activeOpacity={0.7}
              onPress={() => onSelect(item)}
            >
              <View style={[ls.avatar, { backgroundColor: item.color + "22" }]}>
                <Text style={{ fontSize: 24 }}>{item.emoji}</Text>
                {item.isAI && <View style={ls.onlinePip} />}
              </View>
              <View style={ls.rowText}>
                <Text style={ls.rowName}>
                  {item.isAI ? item.name : `#${item.name}`}
                </Text>
                <Text style={ls.rowDesc} numberOfLines={1}>
                  {item.description}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color="#2A2A2A" />
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const ls = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#111",
  },
  headerTitle: {
    flex: 1,
    color: "#fff",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#1DB954",
  },

  bannersWrap: { paddingHorizontal: 14, paddingTop: 14, gap: 8 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0E0E0E",
    borderRadius: 12,
    borderLeftWidth: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#1A1A1A",
    paddingHorizontal: 12,
    paddingVertical: 11,
    gap: 12,
  },
  bannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 9,
    justifyContent: "center",
    alignItems: "center",
  },
  bannerBody: { flex: 1 },
  bannerTitle: { color: "#EFEFEF", fontSize: 13, fontWeight: "600" },
  bannerSub: { color: "#555", fontSize: 11, marginTop: 2 },

  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginTop: 22,
    marginBottom: 4,
    gap: 10,
  },
  sectionLabel: {
    color: "#2E2E2E",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  sectionLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#111",
  },

  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  loadingText: { color: "#333", fontSize: 13 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 14,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#0E0E0E",
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  onlinePip: {
    position: "absolute",
    bottom: 1,
    right: 1,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: "#1DB954",
    borderWidth: 2,
    borderColor: "#000",
  },
  rowText: { flex: 1 },
  rowName: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  rowDesc: { color: "#444", fontSize: 13, marginTop: 2 },
});

// ════════════════════════════════════════════════════════════════
// CHAT SCREEN
// ════════════════════════════════════════════════════════════════
function ChatScreen({
  channel,
  onBack,
}: {
  channel: Channel;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const statusBarH =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;
  const keyboardOffset = useKeyboardOffset();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [aiTyping, setAiTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList>(null);
  const me = auth.currentUser;

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, []);

  // Load messages / subscribe
  useEffect(() => {
    setLoading(true);
    setMessages([]);

    readMsgCache(channel.id).then((cached) => {
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
        writeMsgCache(channel.id, msgs);
        scrollToBottom();
      },
      () => setLoading(false),
    );

    return () => unsub();
  }, [channel.id]);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages.length, aiTyping]);

  // Send to AI
  const sendToAI = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return;
      setSending(true);

      const userMsg: Message = {
        id: `u_${Date.now()}`,
        text,
        uid: me?.uid ?? "user",
        displayName: me?.displayName ?? "You",
        createdAt: Date.now(),
      };
      setMessages((p) => {
        const n = [...p, userMsg];
        writeMsgCache(channel.id, n);
        return n;
      });
      setInput("");
      setAiTyping(true);

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
        setMessages((p) => {
          const n = [...p, aiMsg];
          writeMsgCache(channel.id, n);
          return n;
        });
      } catch {
        setMessages((p) => [
          ...p,
          {
            id: `err_${Date.now()}`,
            text: "Couldn't reach the AI. Check your connection.",
            uid: "ypn-ai",
            displayName: "YPN AI",
            createdAt: Date.now(),
            isAI: true,
          },
        ]);
      } finally {
        setAiTyping(false);
        setSending(false);
      }
    },
    [sending, me, channel.id],
  );

  // Send to Firestore
  const sendToFirestore = useCallback(
    async (text: string) => {
      if (!text.trim() || !me || sending) return;
      setSending(true);
      setInput("");

      const oid = `o_${Date.now()}`;
      const optimistic: Message = {
        id: oid,
        text,
        uid: me.uid,
        displayName: me.displayName ?? me.email?.split("@")[0] ?? "Member",
        createdAt: Date.now(),
        pending: true,
      };
      setMessages((p) => [...p, optimistic]);

      try {
        await addDoc(collection(db, "channels", channel.id, "messages"), {
          text,
          uid: me.uid,
          displayName:
            me.displayName ?? me.email?.split("@")[0] ?? "YPN Member",
          createdAt: serverTimestamp(),
        });
        setMessages((p) => p.filter((m) => m.id !== oid));
      } catch {
        setMessages((p) =>
          p.map((m) =>
            m.id === oid ? { ...m, pending: false, failed: true } : m,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [sending, me, channel.id],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (channel.isAI) sendToAI(text);
    else sendToFirestore(text);
  }, [input, channel.isAI, sendToAI, sendToFirestore]);

  // Render a single message bubble
  const renderMessage = useCallback(
    ({ item }: { item: Message }) => {
      const isMe = item.uid === me?.uid;
      const isAI = item.isAI;
      const time = new Date(item.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const darkText = isMe && channel.color === "#FEE75C" ? "#000" : "#fff";

      return (
        <View style={[cs.row, isMe && cs.rowMe]}>
          {/* Avatar — only for others */}
          {!isMe && (
            <View
              style={[cs.avatar, { backgroundColor: channel.color + "33" }]}
            >
              <Text
                style={{
                  fontSize: 11,
                  color: channel.color,
                  fontWeight: "700",
                }}
              >
                {isAI ? "AI" : (item.displayName?.[0] ?? "?").toUpperCase()}
              </Text>
            </View>
          )}

          {/* Bubble */}
          <View
            style={[
              cs.bubble,
              isMe
                ? [cs.bubbleMe, { backgroundColor: channel.color }]
                : cs.bubbleThem,
              item.pending && cs.bubblePending,
              item.failed && cs.bubbleFailed,
            ]}
          >
            {!isMe && (
              <Text style={[cs.sender, { color: channel.color }]}>
                {isAI ? "YPN AI" : item.displayName}
              </Text>
            )}
            <Text style={[cs.msgText, isMe && { color: darkText }]}>
              {item.text}
            </Text>
            <View style={cs.metaRow}>
              <Text
                style={[
                  cs.time,
                  isMe && {
                    color:
                      darkText === "#000"
                        ? "rgba(0,0,0,0.45)"
                        : "rgba(255,255,255,0.45)",
                  },
                ]}
              >
                {time}
              </Text>
              {item.pending && (
                <Ionicons name="time-outline" size={11} color="#555" />
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
                  color={
                    darkText === "#000"
                      ? "rgba(0,0,0,0.45)"
                      : "rgba(255,255,255,0.45)"
                  }
                />
              )}
            </View>
          </View>
        </View>
      );
    },
    [me, channel],
  );

  // iOS uses KeyboardAvoidingView; Android uses the animated marginBottom
  const InputBar = (
    <Animated.View
      style={[
        cs.inputWrap,
        Platform.OS === "android"
          ? { marginBottom: keyboardOffset }
          : {
              paddingBottom: insets.bottom > 0 ? insets.bottom : 8,
            },
      ]}
    >
      {!me && (
        <View style={cs.authRow}>
          <Ionicons name="lock-closed-outline" size={12} color="#FFA500" />
          <Text style={cs.authText}>Sign in to send messages</Text>
        </View>
      )}
      <View style={cs.inputRow}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={me ? "Message…" : "Sign in to chat"}
          placeholderTextColor="#555"
          style={cs.input}
          multiline
          maxLength={2000}
          editable={!!me}
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={handleSend}
          textAlignVertical="center"
        />
        <TouchableOpacity
          onPress={handleSend}
          disabled={!input.trim() || sending || !me}
          activeOpacity={0.8}
          style={[
            cs.sendBtn,
            {
              backgroundColor: input.trim() && me ? channel.color : "#1C1C1C",
            },
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons
              name="send"
              size={18}
              color={
                input.trim() && me && channel.color === "#FEE75C"
                  ? "#000"
                  : "#fff"
              }
            />
          )}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  return (
    <View
      style={[
        cs.root,
        {
          paddingTop: Platform.OS === "android" ? statusBarH : insets.top,
        },
      ]}
    >
      {/* Header with back button */}
      <View style={cs.header}>
        <TouchableOpacity
          onPress={onBack}
          style={cs.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View
          style={[cs.headerAvatar, { backgroundColor: channel.color + "22" }]}
        >
          <Text style={{ fontSize: 22 }}>{channel.emoji}</Text>
          {channel.isAI && <View style={cs.headerOnline} />}
        </View>
        <View style={cs.headerText}>
          <Text style={cs.headerName}>
            {channel.isAI ? channel.name : `#${channel.name}`}
          </Text>
          <Text style={[cs.headerStatus, { color: channel.color }]}>
            {channel.isAI
              ? aiTyping
                ? "typing…"
                : "Online"
              : channel.description}
          </Text>
        </View>
      </View>

      {/* Messages list */}
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
          contentContainerStyle={cs.msgList}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={scrollToBottom}
          ListEmptyComponent={
            <View style={cs.emptyWrap}>
              <Text style={{ fontSize: 52 }}>{channel.emoji}</Text>
              <Text style={cs.emptyTitle}>
                {channel.isAI ? "Say hello to YPN AI" : `#${channel.name}`}
              </Text>
              <Text style={cs.emptyDesc}>{channel.description}</Text>
            </View>
          }
          ListFooterComponent={
            aiTyping ? (
              <View style={cs.row}>
                <View
                  style={[cs.avatar, { backgroundColor: channel.color + "33" }]}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      color: channel.color,
                      fontWeight: "700",
                    }}
                  >
                    AI
                  </Text>
                </View>
                <View style={cs.bubbleThem}>
                  <Text style={cs.typingText}>typing…</Text>
                </View>
              </View>
            ) : null
          }
        />
      )}

      {/* Sticky input bar */}
      {InputBar}
    </View>
  );
}

const cs = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0A0A0A" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1A1A1A",
    gap: 10,
  },
  backBtn: {
    width: 38,
    height: 38,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 19,
  },
  headerAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  headerOnline: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#1DB954",
    borderWidth: 2,
    borderColor: "#111",
  },
  headerText: { flex: 1 },
  headerName: { color: "#fff", fontSize: 16, fontWeight: "700" },
  headerStatus: { fontSize: 12, marginTop: 1 },

  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  msgList: {
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 16,
  },

  row: {
    flexDirection: "row",
    marginBottom: 5,
    alignItems: "flex-end",
    paddingHorizontal: 2,
  },
  rowMe: { flexDirection: "row-reverse" },

  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
    marginHorizontal: 5,
    flexShrink: 0,
    alignSelf: "flex-end",
    marginBottom: 2,
  },

  bubble: {
    maxWidth: "75%",
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: {
    backgroundColor: "#1C1C1C",
    borderBottomLeftRadius: 4,
  },
  bubblePending: { opacity: 0.55 },
  bubbleFailed: { borderWidth: 1, borderColor: "#FF453A" },

  sender: { fontSize: 11, fontWeight: "700", marginBottom: 3 },
  msgText: { color: "#E8E8E8", fontSize: 15, lineHeight: 22 },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    gap: 3,
  },
  time: { fontSize: 10, color: "rgba(255,255,255,0.35)" },

  typingText: {
    color: "#555",
    fontStyle: "italic",
    fontSize: 13,
    padding: 2,
  },

  emptyWrap: {
    alignItems: "center",
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 8,
  },
  emptyDesc: {
    color: "#444",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },

  inputWrap: {
    backgroundColor: "#111",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1A1A1A",
    paddingTop: 8,
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: "#1C1C1C",
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "android" ? 8 : 10,
    color: "#fff",
    fontSize: 15,
    maxHeight: 110,
    lineHeight: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2A2A2A",
    textAlignVertical: "center",
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  authRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingBottom: 6,
  },
  authText: { color: "#FFA500", fontSize: 11 },
});

// ════════════════════════════════════════════════════════════════
// ROOT — switches between channel list and individual chat
// ════════════════════════════════════════════════════════════════
export default function DiscordScreen() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);

  // Fetch channels from backend + poll every 60s
  useEffect(() => {
    const cached = readChannelCache();
    if (cached?.length) {
      setChannels(cached);
      setLoadingChannels(false);
    }

    async function fetchChannels() {
      try {
        const res = await fetch(`${API_URL}/api/discord/channels`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Channel[] = await res.json();
        if (data.length > 0) {
          writeChannelCache(data);
          setChannels(data);
        }
      } catch (e) {
        console.warn("[Discord] channel fetch:", e);
      } finally {
        setLoadingChannels(false);
      }
    }

    fetchChannels();
    const timer = setInterval(fetchChannels, 60_000);
    return () => clearInterval(timer);
  }, []);

  if (activeChannel) {
    return (
      <ChatScreen
        channel={activeChannel}
        onBack={() => setActiveChannel(null)}
      />
    );
  }

  return (
    <ChannelListScreen
      channels={channels}
      loadingChannels={loadingChannels}
      onSelect={(ch) => setActiveChannel(ch)}
    />
  );
}
