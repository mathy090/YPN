// src/screens/TeamYPN.tsx
// Added: voice call icon → opens VoiceCallScreen modal (full-screen slide)
// Everything else is unchanged from your original.

import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useFocusEffect, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { resumeOrStartAIStream } from "../errorHandlerAIchat/streamHandler";
import { Message } from "../types/chat";
import { getSecureCache, setSecureCache } from "../utils/cache";
import { useNetworkStatus } from "../utils/network";
import {
  clearPendingAIReply,
  getPendingAIReply,
} from "../utils/pendingAIReply";
import {
  clearTeamYPNUnreadBadge,
  incrementUnreadBadge,
} from "../utils/teamYPNBadge";
import VoiceCallScreen from "./VoiceCallScreen";

const AI_API_URL = `${process.env.EXPO_PUBLIC_AI_URL}/chat`;
const CACHE_KEY = "chat_team-ypn";
const UNDO_MS = 3000;

function fixStatus(msgs: unknown[]): Message[] {
  return (msgs as Message[]).map((m) =>
    (m as Message).status
      ? (m as Message)
      : { ...(m as Message), status: "read" as const },
  );
}

function TypingIndicator() {
  const dot0 = useRef(new Animated.Value(0.4)).current;
  const dot1 = useRef(new Animated.Value(0.4)).current;
  const dot2 = useRef(new Animated.Value(0.4)).current;
  const dots = [dot0, dot1, dot2];

  useEffect(() => {
    const loop = Animated.loop(
      Animated.stagger(
        150,
        dots.map((d) =>
          Animated.sequence([
            Animated.timing(d, {
              toValue: 1,
              duration: 200,
              useNativeDriver: true,
            }),
            Animated.timing(d, {
              toValue: 0.4,
              duration: 200,
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <View style={s.typingRow}>
      <BlurView intensity={80} tint="dark" style={s.glassBubble}>
        <View style={s.dotsWrap}>
          {dots.map((d, i) => (
            <Animated.View
              key={i}
              style={[
                s.dot,
                {
                  opacity: d,
                  transform: [
                    {
                      translateY: d.interpolate({
                        inputRange: [0.4, 1],
                        outputRange: [0, -2],
                      }),
                    },
                  ],
                },
              ]}
            />
          ))}
        </View>
      </BlurView>
    </View>
  );
}

interface UndoToastProps {
  onUndo: () => void;
  progress: Animated.Value;
}
function UndoToast({ onUndo, progress }: UndoToastProps) {
  const barWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["100%", "0%"],
  });
  return (
    <View style={s.toastCard}>
      <View style={s.toastRow}>
        <Text style={s.toastLabel}>Message deleted</Text>
        <TouchableOpacity
          onPress={onUndo}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={s.toastUndo}>UNDO</Text>
        </TouchableOpacity>
      </View>
      <Animated.View style={[s.toastBar, { width: barWidth }]} />
    </View>
  );
}

export default function TeamYPNScreen() {
  const router = useRouter();
  const listRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [aiTyping, setAiTyping] = useState(false);

  // ── New: voice modal visibility ─────────────────────────────────────────
  const [voiceVisible, setVoiceVisible] = useState(false);

  const [pending, setPending] = useState<Message | null>(null);
  const undoProgress = useRef(new Animated.Value(1)).current;
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  const { isConnected } = useNetworkStatus();
  const isChatOpenRef = useRef(true);

  useFocusEffect(
    useCallback(() => {
      isChatOpenRef.current = true;
      clearTeamYPNUnreadBadge().catch(() => {});
      return () => {
        isChatOpenRef.current = false;
      };
    }, []),
  );

  useEffect(() => {
    (async () => {
      try {
        const cached = await getSecureCache(CACHE_KEY);
        if (Array.isArray(cached) && cached.length > 0) {
          const fixed = fixStatus(cached);
          setMessages(fixed);
          await clearTeamYPNUnreadBadge();
          for (const msg of fixed) {
            if (msg.sender === "ai" && msg.status !== "read") {
              const saved = await getPendingAIReply(msg.id);
              if (saved) {
                resumeOrStartAIStream(
                  msg.id,
                  saved,
                  setMessages,
                  isChatOpenRef,
                ).catch(() => clearPendingAIReply(msg.id));
              } else {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === msg.id ? { ...m, status: "read" } : m,
                  ),
                );
              }
            }
          }
        }
      } catch (e) {
        console.warn("[TeamYPN] cache load:", e);
      } finally {
        setLoading(false);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loading && messages.length > 0) {
      setSecureCache(CACHE_KEY, messages).catch(() => {});
    }
  }, [messages, loading]);

  const scrollToBottom = useCallback((animated = true) => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated }), 80);
  }, []);

  const fetchAIReply = async (text: string): Promise<string> => {
    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const data = await res.json();
    return (data.reply ?? data.message ?? "Sorry, no response.") as string;
  };

  const sendMessage = useCallback(
    async (text: string, retryId?: string) => {
      if (!text.trim() || !isConnected || sending) return;
      setSending(true);

      const userMsgId = retryId ?? Date.now().toString();
      const userMsg: Message = {
        id: userMsgId,
        text,
        sender: "user",
        timestamp: new Date().toISOString(),
        status: "sent",
      };

      setMessages((prev) =>
        retryId
          ? prev.filter((m) => m.id !== retryId).concat(userMsg)
          : [...prev, userMsg],
      );
      scrollToBottom();
      setMessages((prev) =>
        prev.map((m) => (m.id === userMsgId ? { ...m, status: "read" } : m)),
      );

      const replyPromise = fetchAIReply(text);

      replyPromise
        .then(async (reply) => {
          if (isChatOpenRef.current) {
            setAiTyping(true);
            scrollToBottom();
            await new Promise<void>((r) => setTimeout(r, 700));
            setAiTyping(false);
          }
          const aiMsgId = `ai_${Date.now()}`;
          setMessages((prev) => [
            ...prev,
            {
              id: aiMsgId,
              text: "",
              sender: "ai",
              timestamp: new Date().toISOString(),
              status: "sent",
            },
          ]);
          if (isChatOpenRef.current) scrollToBottom();
          resumeOrStartAIStream(
            aiMsgId,
            reply,
            setMessages,
            isChatOpenRef,
          ).catch((err) => {
            console.warn("[TeamYPN] stream:", err);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMsgId ? { ...m, text: reply, status: "read" } : m,
              ),
            );
            clearPendingAIReply(aiMsgId).catch(() => {});
          });
          if (!isChatOpenRef.current) await incrementUnreadBadge();
        })
        .catch((err) => {
          console.warn("[TeamYPN] fetch:", err);
          setAiTyping(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === userMsgId ? { ...m, status: "failed" } : m,
            ),
          );
        })
        .finally(() => setSending(false));
    },
    [isConnected, sending, scrollToBottom],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
  }, [input, sendMessage]);

  const commitDelete = useCallback(
    (msg: Message) => {
      undoAnimRef.current?.stop();
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoProgress.setValue(1);
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      setPending(msg);
      undoAnimRef.current = Animated.timing(undoProgress, {
        toValue: 0,
        duration: UNDO_MS,
        useNativeDriver: false,
      });
      undoAnimRef.current.start();
      undoTimerRef.current = setTimeout(() => {
        setPending(null);
        undoProgress.setValue(1);
      }, UNDO_MS + 100);
    },
    [undoProgress],
  );

  const handleUndo = useCallback(() => {
    if (!pending) return;
    undoAnimRef.current?.stop();
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoProgress.setValue(1);
    setMessages((prev) =>
      [...prev, pending].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    );
    setPending(null);
  }, [pending, undoProgress]);

  const fmtHeader = (ts: string): string => {
    const d = new Date(ts);
    const now = new Date();
    const yest = new Date();
    yest.setDate(now.getDate() - 1);
    const same = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (same(d, now)) return "Today";
    if (same(d, yest)) return "Yesterday";
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  type GroupItem =
    | { type: "header"; key: string; text: string }
    | { type: "message"; key: string; item: Message };

  const grouped = useMemo<GroupItem[]>(() => {
    const out: GroupItem[] = [];
    let last = "";
    for (const m of messages) {
      const h = fmtHeader(m.timestamp);
      if (h !== last) {
        out.push({ type: "header", key: `h_${m.id}`, text: h });
        last = h;
      }
      out.push({ type: "message", key: m.id, item: m });
    }
    return out;
  }, [messages]);

  const renderItem = useCallback(
    ({ item }: { item: GroupItem }) => {
      if (item.type === "header") {
        return (
          <View style={s.dateHeader}>
            <Text style={s.dateHeaderText}>{item.text}</Text>
          </View>
        );
      }
      const msg = item.item;
      const isUser = msg.sender === "user";
      const time = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      return (
        <Pressable
          onLongPress={() => commitDelete(msg)}
          delayLongPress={420}
          style={[s.row, isUser ? s.rowUser : s.rowAI]}
        >
          <View style={[s.bubble, isUser ? s.userBubble : s.aiBubble]}>
            <Text style={[s.msgText, isUser && s.msgTextUser]}>{msg.text}</Text>
            <View style={s.metaRow}>
              <Text style={[s.timeText, isUser && s.timeUser]}>{time}</Text>
              {isUser && msg.status === "sent" && (
                <Ionicons
                  name="checkmark"
                  size={13}
                  color="rgba(255,255,255,0.5)"
                />
              )}
              {isUser && msg.status === "read" && (
                <Ionicons name="checkmark-done" size={13} color="#53BDEB" />
              )}
              {isUser && msg.status === "failed" && (
                <TouchableOpacity
                  onPress={() => sendMessage(msg.text, msg.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={s.retryRow}
                >
                  <Ionicons name="alert-circle" size={15} color="#FF453A" />
                  <Text style={s.retryTxt}>Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </Pressable>
      );
    },
    [commitDelete, sendMessage],
  );

  const keyExtractor = useCallback((item: GroupItem) => item.key, []);

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <ActivityIndicator size="large" color="#25D366" />
      </View>
    );
  }

  const STATUS_H =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;

  return (
    <View style={s.root}>
      {/* ── HEADER ── */}
      <BlurView
        intensity={90}
        tint="dark"
        style={[s.header, { paddingTop: STATUS_H }]}
      >
        <View style={s.headerContent}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={s.backBtn}
          >
            <Ionicons name="chevron-back" size={28} color="#25D366" />
          </Pressable>

          <Image
            source={require("../../assets/images/YPN.png")}
            style={s.avatar}
          />

          <View style={s.headerTextContainer}>
            <Text style={s.headerName}>Team YPN</Text>
            <Text style={s.headerSub}>{aiTyping ? "typing..." : "Online"}</Text>
          </View>

          {/* ── Voice call button ── */}
          <TouchableOpacity
            onPress={() => setVoiceVisible(true)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={s.voiceCallBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="call-outline" size={22} color="#25D366" />
          </TouchableOpacity>
        </View>
      </BlurView>

      {/* ── BODY ── */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <FlatList
          ref={listRef}
          data={grouped}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollToBottom(false)}
          ListFooterComponent={aiTyping ? <TypingIndicator /> : null}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        />

        {pending && <UndoToast onUndo={handleUndo} progress={undoProgress} />}

        <View style={s.inputBar}>
          <TouchableOpacity style={s.plusBtn}>
            <Ionicons name="add" size={24} color="#8E8E93" />
          </TouchableOpacity>
          <View style={s.inputContainer}>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder="Message"
              placeholderTextColor="#8E8E93"
              multiline
              maxLength={2000}
              style={s.input}
              blurOnSubmit={false}
            />
          </View>
          <TouchableOpacity
            onPress={handleSend}
            disabled={!input.trim() || sending}
            activeOpacity={0.78}
            style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnOff]}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons
                name="send"
                size={18}
                color="#fff"
                style={{ marginLeft: 2 }}
              />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* ── VOICE MODAL ── */}
      <Modal
        visible={voiceVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setVoiceVisible(false)}
      >
        <VoiceCallScreen
          onClose={() => setVoiceVisible(false)}
          sessionId="voice_team_ypn"
        />
      </Modal>
    </View>
  );
}

// ── Styles (identical to your original + voiceCallBtn added) ──────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B141A" },
  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0B141A",
  },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1F2C34",
    zIndex: 10,
    overflow: "hidden",
    backgroundColor: "#111B21",
  },
  headerContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    height: 60,
  },
  backBtn: { marginRight: 8 },
  avatar: { width: 36, height: 36, borderRadius: 18, marginRight: 10 },
  headerTextContainer: { flex: 1, justifyContent: "center" },
  headerName: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  headerSub: { color: "#8696A0", fontSize: 12, marginTop: 1 },

  // ── New voice button ──
  voiceCallBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(37,211,102,0.1)",
    borderWidth: 1,
    borderColor: "rgba(37,211,102,0.2)",
  },

  listContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10 },
  dateHeader: {
    alignSelf: "center",
    backgroundColor: "rgba(32,44,51,0.9)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginVertical: 12,
  },
  dateHeaderText: { color: "#8696A0", fontSize: 11, fontWeight: "500" },
  row: { marginVertical: 2, flexDirection: "row", maxWidth: "85%" },
  rowUser: { justifyContent: "flex-end", alignSelf: "flex-end" },
  rowAI: { justifyContent: "flex-start", alignSelf: "flex-start" },
  bubble: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    minWidth: 60,
  },
  userBubble: {
    backgroundColor: "#005C4B",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 2,
  },
  aiBubble: {
    backgroundColor: "#202C33",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 8,
  },
  msgText: {
    color: "#E9EDEF",
    fontSize: 16.5,
    lineHeight: 21,
    letterSpacing: 0.1,
  },
  msgTextUser: { color: "#E9EDEF" },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 2,
    marginBottom: -2,
    gap: 4,
    alignSelf: "flex-end",
  },
  timeText: { color: "rgba(255,255,255,0.6)", fontSize: 11 },
  timeUser: { color: "rgba(255,255,255,0.7)" },
  retryRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  retryTxt: { color: "#FF453A", fontSize: 11, fontWeight: "600" },
  typingRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginVertical: 4,
    alignSelf: "flex-start",
  },
  glassBubble: {
    borderRadius: 16,
    overflow: "hidden",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "#202C33",
  },
  dotsWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#8696A0" },
  toastCard: {
    position: "absolute",
    bottom: 70,
    left: 16,
    right: 16,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#2C2C2E",
    borderWidth: 1,
    borderColor: "#3A3A3C",
    zIndex: 100,
  },
  toastRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  toastLabel: { color: "#fff", fontSize: 15, flex: 1, fontWeight: "500" },
  toastUndo: { color: "#25D366", fontSize: 15, fontWeight: "600" },
  toastBar: { height: 3, backgroundColor: "#25D366" },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#111B21",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1F2C34",
    gap: 10,
  },
  plusBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  inputContainer: {
    flex: 1,
    backgroundColor: "#2A3942",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#2A3942",
    minHeight: 36,
    maxHeight: 100,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  input: {
    color: "#fff",
    fontSize: 16,
    lineHeight: 20,
    maxHeight: 90,
    textAlignVertical: "center",
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#25D366",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  sendBtnOff: {
    backgroundColor: "#1F2C34",
    borderWidth: 1,
    borderColor: "#333",
  },
});
