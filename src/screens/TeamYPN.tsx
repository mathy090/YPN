// src/screens/TeamYPN.tsx
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
  Keyboard,
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

import { resumeOrStartAIStream } from "../errorHandlerAIchat/streamHandler";
import { Message } from "../types/chat";
import { getUserEmail } from "../utils/auth";
import {
  getCachedProfile,
  getSecureCache,
  setSecureCache,
} from "../utils/cache";
import { useNetworkStatus } from "../utils/network";
import {
  clearPendingAIReply,
  getPendingAIReply,
} from "../utils/pendingAIReply";
import {
  clearTeamYPNUnreadBadge,
  incrementUnreadBadge,
} from "../utils/teamYPNBadge";

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

// ── Glassmorphism Typing Indicator ─────────────────────────────────────
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
      <BlurView intensity={85} tint="dark" style={s.glassBubble}>
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

// ── Glassmorphism Undo Toast ───────────────────────────────────────────
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
      <BlurView intensity={70} tint="dark" style={s.toastGlass}>
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
      </BlurView>
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

  const [pending, setPending] = useState<Message | null>(null);
  const undoProgress = useRef(new Animated.Value(1)).current;
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  const [username, setUsername] = useState<string>("");
  const messageQueueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

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
    let isMounted = true;
    const loadUsername = async () => {
      try {
        const cached = await getCachedProfile();
        if (isMounted && cached?.username) {
          setUsername(cached.username);
        }
      } catch (e) {
        console.warn("[TeamYPN] Username cache load:", e);
      }
    };
    loadUsername();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const keyboardDidHideListener = Keyboard.addListener(
      "keyboardDidHide",
      () => {
        setTimeout(() => {
          listRef.current?.scrollToEnd({ animated: true });
        }, 100);
      },
    );
    return () => keyboardDidHideListener.remove();
  }, []);

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

  const fetchAIReply = async (
    text: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    try {
      const userEmail = await getUserEmail();
      const requestBody: {
        message: string;
        session_id?: string;
        email?: string;
        username?: string;
      } = {
        message: text,
        session_id: "team-ypn",
        email: userEmail || undefined,
        username: username || undefined,
      };

      const res = await fetch(AI_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`AI ${res.status}: ${errorText}`);
      }

      const data = await res.json();
      return (data.reply ?? data.message ?? "Sorry, no response.") as string;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("REQUEST_ABORTED");
      }
      console.error("[TeamYPN] fetchAIReply error:", err);
      throw err;
    }
  };

  const processNextMessage = useCallback(async () => {
    if (isProcessingRef.current || messageQueueRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;
    const text = messageQueueRef.current.shift()!;
    abortControllerRef.current = new AbortController();

    const userMsgId = Date.now().toString();
    const userMsg: Message = {
      id: userMsgId,
      text,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "sent",
    };

    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom();
    setMessages((prev) =>
      prev.map((m) => (m.id === userMsgId ? { ...m, status: "read" } : m)),
    );

    try {
      const reply = await fetchAIReply(text, abortControllerRef.current.signal);

      if (isChatOpenRef.current) {
        setAiTyping(true);
        scrollToBottom();
        await new Promise<void>((r) => setTimeout(r, 400));
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

      await resumeOrStartAIStream(aiMsgId, reply, setMessages, isChatOpenRef);

      if (!isChatOpenRef.current) {
        await incrementUnreadBadge();
      }
    } catch (err: any) {
      if (err.message === "REQUEST_ABORTED") {
        return;
      }
      console.warn("[TeamYPN] processNextMessage error:", err);
      setMessages((prev) =>
        prev.map((m) => (m.id === userMsgId ? { ...m, status: "failed" } : m)),
      );
    } finally {
      isProcessingRef.current = false;
      abortControllerRef.current = null;
      if (messageQueueRef.current.length > 0) {
        setTimeout(() => processNextMessage(), 300);
      }
    }
  }, [scrollToBottom, username]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || !isConnected) return;
      messageQueueRef.current.push(text.trim());
      if (!isProcessingRef.current) {
        processNextMessage();
      }
    },
    [isConnected, processNextMessage],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
    inputRef.current?.blur();
  }, [input, sendMessage]);

  const handleRetry = useCallback(
    (text: string, msgId: string) => {
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
      messageQueueRef.current.unshift(text);
      if (!isProcessingRef.current) {
        processNextMessage();
      }
    },
    [processNextMessage],
  );

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
            <BlurView intensity={40} tint="dark" style={s.dateHeaderGlass}>
              <Text style={s.dateHeaderText}>{item.text}</Text>
            </BlurView>
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
                  onPress={() => handleRetry(msg.text, msg.id)}
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
    [commitDelete, handleRetry],
  );

  const keyExtractor = useCallback((item: GroupItem) => item.key, []);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <BlurView intensity={60} tint="dark" style={s.loadingGlass}>
          <ActivityIndicator size="large" color="#25D366" />
        </BlurView>
      </View>
    );
  }

  const STATUS_H =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;

  return (
    <View style={s.root}>
      {/* ── DYNAMIC BACKGROUND ── */}
      <View style={s.bgGradient} />
      <View style={s.bgMesh1} pointerEvents="none" />
      <View style={s.bgMesh2} pointerEvents="none" />

      {/* ── GLASS HEADER ── */}
      <BlurView
        intensity={92}
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
          <View style={s.avatarWrap}>
            <Image
              source={require("../../assets/images/YPN.png")}
              style={s.avatar}
            />
            <View style={s.onlineDot} />
          </View>
          <View style={s.headerTextContainer}>
            <Text style={s.headerName}>Team YPN</Text>
            <Text style={s.headerSub}>{aiTyping ? "typing..." : "Online"}</Text>
          </View>
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

        {/* ── GLASS INPUT BAR ── */}
        <View style={s.inputBar}>
          <BlurView intensity={88} tint="dark" style={s.inputGlass}>
            <View style={s.inputContainer}>
              <TextInput
                ref={inputRef}
                value={input}
                onChangeText={setInput}
                placeholder="Message..."
                placeholderTextColor="#8E8E93"
                multiline
                maxLength={2000}
                style={s.input}
                blurOnSubmit={false}
                onSubmitEditing={handleSend}
                returnKeyType="send"
              />
            </View>
            <TouchableOpacity
              onPress={handleSend}
              disabled={!input.trim()}
              activeOpacity={0.78}
              style={[s.sendBtn, !input.trim() && s.sendBtnOff]}
            >
              <Ionicons
                name="send"
                size={18}
                color="#fff"
                style={{ marginLeft: 2 }}
              />
            </TouchableOpacity>
          </BlurView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── GLASSMORPHISM STYLES ───────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B141A",
    overflow: "hidden",
  },

  // Dynamic Background Layers
  bgGradient: {
    position: "absolute",
    inset: 0,
    backgroundColor: "#0B141A",
  },
  bgMesh1: {
    position: "absolute",
    width: 400,
    height: 400,
    borderRadius: 200,
    backgroundColor: "rgba(37, 211, 102, 0.08)",
    top: -100,
    right: -100,
  },
  bgMesh2: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "rgba(83, 189, 235, 0.06)",
    bottom: -50,
    left: -50,
  },

  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0B141A",
  },
  loadingGlass: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },

  // Glass Header
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
    zIndex: 10,
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  headerContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    height: 60,
  },
  backBtn: {
    marginRight: 4,
    padding: 6,
  },
  avatarWrap: {
    position: "relative",
    marginRight: 10,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.15)",
  },
  onlineDot: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#25D366",
    borderWidth: 2,
    borderColor: "#0B141A",
  },
  headerTextContainer: {
    flex: 1,
    justifyContent: "center",
    marginRight: 8,
  },
  headerName: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  headerSub: {
    color: "#8696A0",
    fontSize: 12,
    marginTop: 1,
    fontWeight: "400",
  },

  // Messages List
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },

  // Glass Date Header
  dateHeader: {
    alignSelf: "center",
    marginVertical: 14,
  },
  dateHeaderGlass: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  dateHeaderText: {
    color: "#8696A0",
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.3,
  },

  // Message Rows & Bubbles
  row: {
    marginVertical: 3,
    flexDirection: "row",
    maxWidth: "82%",
  },
  rowUser: {
    justifyContent: "flex-end",
    alignSelf: "flex-end",
  },
  rowAI: {
    justifyContent: "flex-start",
    alignSelf: "flex-start",
  },
  bubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    minWidth: 64,
    borderWidth: 1,
  },
  userBubble: {
    backgroundColor: "rgba(37, 211, 102, 0.18)",
    borderColor: "rgba(37, 211, 102, 0.35)",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 6,
    shadowColor: "#25D366",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  aiBubble: {
    backgroundColor: "rgba(32, 44, 51, 0.75)",
    borderColor: "rgba(255,255,255,0.12)",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 18,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  msgText: {
    color: "#E9EDEF",
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: 0.15,
  },
  msgTextUser: {
    color: "#E9EDEF",
    fontWeight: "400",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 3,
    marginBottom: -3,
    gap: 5,
    alignSelf: "flex-end",
  },
  timeText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
    fontWeight: "400",
  },
  timeUser: {
    color: "rgba(255,255,255,0.65)",
  },
  retryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginLeft: 4,
  },
  retryTxt: {
    color: "#FF453A",
    fontSize: 11,
    fontWeight: "600",
  },

  // Glass Typing Indicator
  typingRow: {
    flexDirection: "row",
    paddingHorizontal: 14,
    marginVertical: 6,
    alignSelf: "flex-start",
  },
  glassBubble: {
    borderRadius: 18,
    overflow: "hidden",
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(32, 44, 51, 0.7)",
  },
  dotsWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#8696A0",
  },

  // Glass Undo Toast
  toastCard: {
    position: "absolute",
    bottom: 85,
    left: 18,
    right: 18,
    borderRadius: 14,
    overflow: "hidden",
    zIndex: 100,
  },
  toastGlass: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  toastRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  toastLabel: {
    color: "#fff",
    fontSize: 15,
    flex: 1,
    fontWeight: "500",
  },
  toastUndo: {
    color: "#25D366",
    fontSize: 15,
    fontWeight: "700",
    paddingHorizontal: 8,
  },
  toastBar: {
    height: 3,
    backgroundColor: "#25D366",
  },

  // Glass Input Bar
  inputBar: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "transparent",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  inputGlass: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 8,
    backgroundColor: "rgba(26, 38, 45, 0.85)",
  },
  inputContainer: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  input: {
    color: "#fff",
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 95,
    textAlignVertical: "center",
    fontWeight: "400",
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#25D366",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
    shadowColor: "#25D366",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  sendBtnOff: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    shadowColor: "transparent",
    elevation: 0,
  },
});
