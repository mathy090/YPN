// src/screens/TeamYPN.tsx
// ─────────────────────────────────────────────────────────────────────────────
// YPN AI Chat — WhatsApp-style layout
//   • Tab bar hidden on mount, restored on unmount
//   • 3-dot animated typing indicator (Meta/WhatsApp style)
//   • Simulated character-by-character text reveal after reply arrives
//   • Two-layer cache: MMKV (L1) → AsyncStorage (L2), capped at 100 msgs
//   • Network-aware send, retry on failure, date headers, read receipts
// ─────────────────────────────────────────────────────────────────────────────

import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useNavigation } from "@react-navigation/native";
import { useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
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

// ── Constants ──────────────────────────────────────────────────────────────────
const AI_API_URL = "https://ypn-1.onrender.com/chat";
const CACHE_KEY_L1 = "ypn_chat_teamypn_v2";
const CACHE_KEY_L2 = "ypn_chat_teamypn_async_v2";
const MAX_CACHED = 100;
// Simulate streaming: reveal N characters every tick
const STREAM_CHUNK = 4;
const STREAM_INTERVAL_MS = 18;

// ── MMKV singleton ─────────────────────────────────────────────────────────────
let _mmkv: MMKV | null = null;
const mmkv = (): MMKV => {
  if (!_mmkv) _mmkv = new MMKV({ id: "ypn-chat-v2" });
  return _mmkv;
};

// ── Types ──────────────────────────────────────────────────────────────────────
type MsgStatus = "sending" | "sent" | "read" | "failed";

type Message = {
  id: string;
  text: string;
  sender: "user" | "ai";
  timestamp: number; // unix ms
  status: MsgStatus;
};

type ListRow =
  | { type: "header"; label: string; key: string }
  | { type: "message"; msg: Message; key: string };

// ── Cache helpers ──────────────────────────────────────────────────────────────
function readL1(): Message[] | null {
  try {
    const raw = mmkv().getString(CACHE_KEY_L1);
    return raw ? (JSON.parse(raw) as Message[]) : null;
  } catch {
    return null;
  }
}

function writeL1(msgs: Message[]): void {
  try {
    mmkv().set(CACHE_KEY_L1, JSON.stringify(msgs.slice(-MAX_CACHED)));
  } catch {}
}

async function readL2(): Promise<Message[] | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY_L2);
    return raw ? (JSON.parse(raw) as Message[]) : null;
  } catch {
    return null;
  }
}

async function writeL2(msgs: Message[]): Promise<void> {
  try {
    await AsyncStorage.setItem(
      CACHE_KEY_L2,
      JSON.stringify(msgs.slice(-MAX_CACHED)),
    );
  } catch {}
}

// ── Date header helpers ────────────────────────────────────────────────────────
function dateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = today.getTime() - msgDay.getTime();
  if (diff === 0) return "Today";
  if (diff === 86_400_000) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── 3-dot typing indicator ─────────────────────────────────────────────────────
const TypingIndicator = React.memo(() => {
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
            duration: 300,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 300,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.delay(320),
        ]),
      ),
    );
    Animated.parallel(anims).start();
    return () => anims.forEach((a) => a.stop());
  }, []);

  return (
    <View style={ty.wrap}>
      <View style={ty.bubble}>
        {dots.map((dot, i) => (
          <Animated.View
            key={i}
            style={[ty.dot, { transform: [{ translateY: dot }] }]}
          />
        ))}
      </View>
    </View>
  );
});

const ty = StyleSheet.create({
  wrap: {
    alignSelf: "flex-start",
    marginLeft: 12,
    marginBottom: 6,
  },
  bubble: {
    flexDirection: "row",
    backgroundColor: "#1f1f1f",
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 5,
    alignItems: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#25D366",
  },
});

// ── Read receipt icon ──────────────────────────────────────────────────────────
const Ticks = React.memo(({ status }: { status: MsgStatus }) => {
  if (status === "sending") {
    return <ActivityIndicator size={10} color="rgba(255,255,255,0.5)" />;
  }
  if (status === "failed") {
    return <Ionicons name="alert-circle" size={14} color="#FF453A" />;
  }
  const color = status === "read" ? "#34B7F1" : "rgba(255,255,255,0.55)";
  return <Ionicons name="checkmark-done" size={14} color={color} />;
});

// ── Message bubble ─────────────────────────────────────────────────────────────
type BubbleProps = {
  msg: Message;
  onRetry: (msg: Message) => void;
  // streamingId + streamText: for the currently-streaming AI message
  streamingId: string | null;
  streamText: string;
};

const Bubble = React.memo(
  ({ msg, onRetry, streamingId, streamText }: BubbleProps) => {
    const isUser = msg.sender === "user";
    const displayText = msg.id === streamingId ? streamText : msg.text;

    return (
      <View style={[bs.row, isUser && bs.rowUser]}>
        <Pressable
          onLongPress={msg.status === "failed" ? () => onRetry(msg) : undefined}
          style={[bs.bubble, isUser ? bs.bubbleUser : bs.bubbleAI]}
        >
          <Text style={[bs.text, isUser && bs.textUser]}>{displayText}</Text>
          <View style={bs.meta}>
            <Text style={[bs.time, isUser && bs.timeUser]}>
              {timeStr(msg.timestamp)}
            </Text>
            {isUser && <Ticks status={msg.status} />}
          </View>
        </Pressable>
      </View>
    );
  },
);

const bs = StyleSheet.create({
  row: {
    marginVertical: 2,
    paddingHorizontal: 10,
    alignSelf: "flex-start",
    maxWidth: "80%",
  },
  rowUser: {
    alignSelf: "flex-end",
  },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  bubbleUser: {
    backgroundColor: "#25D366",
    borderBottomRightRadius: 4,
  },
  bubbleAI: {
    backgroundColor: "#1f1f1f",
    borderBottomLeftRadius: 4,
  },
  text: {
    color: "#E0E0E0",
    fontSize: 15,
    lineHeight: 21,
  },
  textUser: {
    color: "#fff",
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    gap: 4,
  },
  time: {
    fontSize: 10,
    color: "rgba(255,255,255,0.4)",
  },
  timeUser: {
    color: "rgba(255,255,255,0.65)",
  },
});

// ── Date header row ────────────────────────────────────────────────────────────
const DateHeader = React.memo(({ label }: { label: string }) => (
  <View style={dh.wrap}>
    <View style={dh.pill}>
      <Text style={dh.text}>{label}</Text>
    </View>
  </View>
));

const dh = StyleSheet.create({
  wrap: {
    alignItems: "center",
    marginVertical: 10,
  },
  pill: {
    backgroundColor: "#1a2a1a",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  text: {
    color: "#8E8E93",
    fontSize: 11,
    fontWeight: "600",
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// Main screen
// ══════════════════════════════════════════════════════════════════════════════
export default function TeamYPNScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // Simulated streaming state
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");

  const listRef = useRef<FlatList>(null);
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Hide tab bar on mount, restore on unmount ───────────────────────────────
  useLayoutEffect(() => {
    navigation.setOptions({ tabBarStyle: { display: "none" } });
    return () => {
      navigation.setOptions({ tabBarStyle: undefined });
    };
  }, [navigation]);

  // ── Network listener ────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOnline(
        (state.isConnected ?? false) && (state.isInternetReachable ?? true),
      );
    });
    return () => unsub();
  }, []);

  // ── Boot: L1 → L2 → empty ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const l1 = readL1();
      if (l1 && l1.length > 0) {
        setMessages(l1);
        setLoading(false);
        scrollToBottom(false);
        return;
      }
      const l2 = await readL2();
      if (l2 && l2.length > 0) {
        setMessages(l2);
        writeL1(l2); // warm L1
      }
      setLoading(false);
      scrollToBottom(false);
    })();
  }, []);

  // ── Persist messages whenever they change ───────────────────────────────────
  useEffect(() => {
    if (loading) return;
    writeL1(messages);
    writeL2(messages); // fire-and-forget
  }, [messages, loading]);

  // ── Cleanup stream timer on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (streamTimer.current) clearInterval(streamTimer.current);
    };
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated }), 60);
  }, []);

  // ── Simulated streaming reveal ──────────────────────────────────────────────
  const startStreaming = useCallback(
    (msgId: string, fullText: string) => {
      if (streamTimer.current) clearInterval(streamTimer.current);
      let revealed = 0;
      setStreamingId(msgId);
      setStreamText("");

      streamTimer.current = setInterval(() => {
        revealed += STREAM_CHUNK;
        const slice = fullText.slice(0, revealed);
        setStreamText(slice);
        scrollToBottom();

        if (revealed >= fullText.length) {
          clearInterval(streamTimer.current!);
          streamTimer.current = null;
          // Commit full text into the message list, clear streaming state
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, text: fullText, status: "read" } : m,
            ),
          );
          setStreamingId(null);
          setStreamText("");
        }
      }, STREAM_INTERVAL_MS);
    },
    [scrollToBottom],
  );

  // ── Send message ────────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (text: string, retryMsgId?: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      if (!isOnline) return; // TODO: queue offline

      setSending(true);

      const userMsgId = retryMsgId ?? `u_${Date.now()}`;
      const userMsg: Message = {
        id: userMsgId,
        text: trimmed,
        sender: "user",
        timestamp: Date.now(),
        status: "sending",
      };

      setMessages((prev) => {
        // If retry: replace old failed msg, else append
        if (retryMsgId) {
          return prev.map((m) => (m.id === retryMsgId ? userMsg : m));
        }
        return [...prev, userMsg];
      });
      setInput("");
      scrollToBottom();

      // Mark as sent after a tick
      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) => (m.id === userMsgId ? { ...m, status: "sent" } : m)),
        );
      }, 300);

      // Show typing indicator
      setShowTyping(true);
      scrollToBottom();

      try {
        const res = await fetch(AI_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const reply: string =
          data.reply ?? data.message ?? data.text ?? "I'm here to help!";

        setShowTyping(false);

        // Mark user msg as read
        setMessages((prev) =>
          prev.map((m) => (m.id === userMsgId ? { ...m, status: "read" } : m)),
        );

        // Insert AI placeholder (text will be revealed by streamer)
        const aiMsgId = `ai_${Date.now()}`;
        const aiMsg: Message = {
          id: aiMsgId,
          text: "", // placeholder — streamer fills this
          sender: "ai",
          timestamp: Date.now(),
          status: "read",
        };
        setMessages((prev) => [...prev, aiMsg]);
        scrollToBottom();

        // Start character-by-character reveal
        startStreaming(aiMsgId, reply);
      } catch {
        setShowTyping(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userMsgId ? { ...m, status: "failed" } : m,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [sending, isOnline, scrollToBottom, startStreaming],
  );

  const handleRetry = useCallback(
    (msg: Message) => {
      sendMessage(msg.text, msg.id);
    },
    [sendMessage],
  );

  // ── Build flat list data with date headers ──────────────────────────────────
  const listData = useMemo<ListRow[]>(() => {
    const rows: ListRow[] = [];
    let lastLabel = "";
    for (const msg of messages) {
      const label = dateLabel(msg.timestamp);
      if (label !== lastLabel) {
        rows.push({ type: "header", label, key: `hdr_${msg.id}` });
        lastLabel = label;
      }
      rows.push({ type: "message", msg, key: msg.id });
    }
    return rows;
  }, [messages]);

  // ── Render row ──────────────────────────────────────────────────────────────
  const renderRow = useCallback(
    ({ item }: { item: ListRow }) => {
      if (item.type === "header") {
        return <DateHeader label={item.label} />;
      }
      return (
        <Bubble
          msg={item.msg}
          onRetry={handleRetry}
          streamingId={streamingId}
          streamText={streamText}
        />
      );
    },
    [handleRetry, streamingId, streamText],
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  // ── Empty state ─────────────────────────────────────────────────────────────
  const EmptyState = useMemo(
    () => (
      <View style={s.empty}>
        <Image
          source={require("../../assets/images/YPN.png")}
          style={s.emptyAvatar}
        />
        <Text style={s.emptyTitle}>Team YPN</Text>
        <Text style={s.emptyDesc}>
          Hi! I'm your YPN AI assistant. Ask me anything about youth
          empowerment, mental health, jobs, or education in Zimbabwe.
        </Text>
      </View>
    ),
    [],
  );

  // ── Layout ──────────────────────────────────────────────────────────────────
  const statusBarH =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />

      {/* ── Header ── */}
      <View style={[s.header, { paddingTop: insets.top || statusBarH + 8 }]}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        <Image
          source={require("../../assets/images/YPN.png")}
          style={s.avatar}
        />

        <View style={s.headerInfo}>
          <Text style={s.headerName}>Team YPN</Text>
          <Text style={[s.headerStatus, showTyping && s.headerTyping]}>
            {showTyping ? "typing..." : "Online"}
          </Text>
        </View>

        <View style={s.onlineDot} />
      </View>

      {/* ── Chat body ── */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={
          (insets.top || statusBarH) + 56 /* header height */
        }
      >
        {loading ? (
          <View style={s.centre}>
            <ActivityIndicator size="large" color="#25D366" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={listData}
            renderItem={renderRow}
            keyExtractor={keyExtractor}
            contentContainerStyle={[
              s.list,
              { paddingBottom: insets.bottom + 72 },
            ]}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollToBottom(false)}
            ListEmptyComponent={EmptyState}
            ListFooterComponent={showTyping ? <TypingIndicator /> : null}
            removeClippedSubviews
            windowSize={5}
          />
        )}

        {/* ── Offline banner ── */}
        {!isOnline && (
          <View style={s.offlineBanner}>
            <Ionicons name="wifi-outline" size={13} color="#FFA500" />
            <Text style={s.offlineText}>No connection — messages paused</Text>
          </View>
        )}

        {/* ── Input bar ── */}
        <View style={[s.inputBar, { paddingBottom: insets.bottom || 8 }]}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Message"
            placeholderTextColor="#555"
            style={s.input}
            multiline
            maxLength={2000}
            editable={!sending && isOnline}
            onSubmitEditing={() => sendMessage(input)}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[
              s.sendBtn,
              (!input.trim() || sending || !isOnline) && s.sendBtnOff,
            ]}
            onPress={() => sendMessage(input)}
            disabled={!input.trim() || sending || !isOnline}
            activeOpacity={0.8}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="send" size={18} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111",
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
    gap: 10,
    minHeight: 56,
  },
  backBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#25D36644",
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  headerStatus: {
    color: "#25D366",
    fontSize: 12,
    marginTop: 1,
  },
  headerTyping: {
    color: "#25D366",
    fontStyle: "italic",
  },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#25D366",
    marginRight: 4,
  },

  // Body
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    paddingTop: 8,
    paddingHorizontal: 2,
  },

  // Empty state
  empty: {
    flex: 1,
    alignItems: "center",
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 14,
  },
  emptyAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: "#25D36633",
  },
  emptyTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
  },
  emptyDesc: {
    color: "#555",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },

  // Offline
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#1a1200",
    paddingVertical: 6,
  },
  offlineText: {
    color: "#FFA500",
    fontSize: 12,
    fontWeight: "600",
  },

  // Input bar
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 10,
    paddingTop: 8,
    backgroundColor: "#111",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#222",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: "#1c1c1e",
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    fontSize: 15,
    color: "#fff",
    maxHeight: 110,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2a2a2a",
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#25D366",
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnOff: {
    backgroundColor: "#1a2e1a",
  },
});
