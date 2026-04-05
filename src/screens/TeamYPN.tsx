// src/screens/TeamYPN.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
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
  BackHandler,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import {
  cacheTeamYPNMessages,
  getCachedTeamYPNMessages,
  TeamYPNMessage,
} from "../utils/teamypncache";

// ── Constants ──────────────────────────────────────────────────────────────────
const AI_API_URL = process.env.EXPO_PUBLIC_AI_URL
  ? `${process.env.EXPO_PUBLIC_AI_URL}/chat`
  : "https://ypn-1.onrender.com/chat";

const MAX_CACHED = 100;
const STREAM_CHUNK = 4;
const STREAM_INTERVAL_MS = 18;

// ── Types ──────────────────────────────────────────────────────────────────────
type MsgStatus = "sending" | "sent" | "read" | "failed";

type Message = {
  id: string;
  text: string;
  sender: "user" | "ai";
  timestamp: number;
  status: MsgStatus;
};

type ListRow =
  | { type: "header"; label: string; key: string }
  | { type: "message"; msg: Message; key: string };

export type TeamYPNScreenProps = {
  onBack?: () => void;
};

// ── Date helpers ───────────────────────────────────────────────────────────────
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

// ── Typing Indicator ───────────────────────────────────────────────────────────
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

// ── Ticks ──────────────────────────────────────────────────────────────────────
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

// ── Bubble ─────────────────────────────────────────────────────────────────────
type BubbleProps = {
  msg: Message;
  onRetry: (msg: Message) => void;
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

// ── Date Header ────────────────────────────────────────────────────────────────
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
// Main Screen
// ══════════════════════════════════════════════════════════════════════════════
export default function TeamYPNScreen({ onBack }: TeamYPNScreenProps) {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");

  const listRef = useRef<FlatList>(null);
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const me = auth.currentUser;

  // ── Load cached messages on mount ────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const cached = await getCachedTeamYPNMessages();
      if (cached.length > 0) {
        setMessages(cached as Message[]);
        setLoading(false);
        scrollToBottom(false);
        return;
      }
      setLoading(false);
      scrollToBottom(false);
    })();
  }, []);

  // ── Persist messages on change ───────────────────────────────────────────────
  useEffect(() => {
    if (messages.length === 0) return;
    cacheTeamYPNMessages(messages.slice(-MAX_CACHED) as TeamYPNMessage[]);
  }, [messages]);

  // ── Tab bar: hide on mount, restore on unmount ──────────────────────────────
  useLayoutEffect(() => {
    navigation.setOptions({
      tabBarStyle: {
        height: 0,
        overflow: "hidden",
        display: "none",
      },
    });
    return () => {
      navigation.setOptions({ tabBarStyle: undefined });
    };
  }, [navigation]);

  // ── Android back button: navigate to Discord main page or call onBack ───────
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (onBack) {
          onBack();
        } else {
          router.replace("/tabs/discord");
        }
        return true;
      };
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        onBackPress,
      );
      return () => subscription.remove();
    }, [onBack, router]),
  );

  // ── Network listener ─────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOnline(
        (state.isConnected ?? false) && (state.isInternetReachable ?? true),
      );
    });
    return () => unsub();
  }, []);

  // ── Cleanup stream timer ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (streamTimer.current) clearInterval(streamTimer.current);
    };
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated }), 60);
  }, []);

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

  const sendMessage = useCallback(
    async (text: string, retryMsgId?: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      if (!isOnline) return;

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
        if (retryMsgId) {
          return prev.map((m) => (m.id === retryMsgId ? userMsg : m));
        }
        return [...prev, userMsg];
      });
      setInput("");
      scrollToBottom();

      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) => (m.id === userMsgId ? { ...m, status: "sent" } : m)),
        );
      }, 300);

      setShowTyping(true);
      scrollToBottom();

      try {
        const res = await fetch(AI_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            session_id: me?.uid ?? "ypn-general",
          }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          console.error("[TeamYPN] AI fetch error:", res.status, errText);
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const reply: string =
          data.reply ?? data.message ?? data.text ?? "I'm here to help!";

        setShowTyping(false);

        setMessages((prev) =>
          prev.map((m) => (m.id === userMsgId ? { ...m, status: "read" } : m)),
        );

        const aiMsgId = `ai_${Date.now()}`;
        const aiMsg: Message = {
          id: aiMsgId,
          text: "",
          sender: "ai",
          timestamp: Date.now(),
          status: "read",
        };
        setMessages((prev) => [...prev, aiMsg]);
        scrollToBottom();

        startStreaming(aiMsgId, reply);
      } catch (e) {
        console.error("[TeamYPN] send error:", e);
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
    [sending, isOnline, scrollToBottom, startStreaming, me],
  );

  const handleRetry = useCallback(
    (msg: Message) => {
      sendMessage(msg.text, msg.id);
    },
    [sendMessage],
  );

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

  const statusBarH =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) : 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />

      <View style={[s.header, { paddingTop: insets.top || statusBarH + 8 }]}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => {
            if (onBack) {
              onBack();
            } else {
              router.replace("/tabs/discord");
            }
          }}
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

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={
          Platform.OS === "ios" ? (insets.top || statusBarH) + 56 : 0
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

        {!isOnline && (
          <View style={s.offlineBanner}>
            <Ionicons name="wifi-outline" size={13} color="#FFA500" />
            <Text style={s.offlineText}>No connection — messages paused</Text>
          </View>
        )}

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

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
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
  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  list: {
    paddingTop: 8,
    paddingHorizontal: 2,
  },
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
