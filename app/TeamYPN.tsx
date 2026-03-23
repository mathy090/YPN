import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Message } from "../src/types/chat";
import { getSecureCache, setSecureCache } from "../src/utils/cache";
import { useNetworkStatus } from "../src/utils/network";

const AI_API_URL = `${process.env.EXPO_PUBLIC_AI_URL}/chat`;

// ─── Typing indicator — three dots that bounce sequentially ──────────────────
function TypingIndicator() {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    const bounce = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
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
          Animated.delay(600),
        ]),
      );

    const anims = dots.map((d, i) => bounce(d, i * 150));
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, []);

  return (
    <View style={styles.row}>
      <View style={[styles.bubble, styles.aiBubble, styles.typingBubble]}>
        <View style={styles.typingRow}>
          {dots.map((d, i) => (
            <Animated.View
              key={i}
              style={[styles.typingDot, { transform: [{ translateY: d }] }]}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

// ─── Blue tick component ──────────────────────────────────────────────────────
function Ticks({ status }: { status: Message["status"] }) {
  if (status === "failed") return null;
  const color = status === "read" ? "#34B7F1" : "#8a8a8a";
  const icon = status === "sent" ? "checkmark" : "checkmark-done";
  return (
    <Ionicons name={icon} size={15} color={color} style={{ marginLeft: 2 }} />
  );
}

export default function TeamYPNScreen() {
  const router = useRouter();
  const listRef = useRef<FlatList>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [aiTyping, setAiTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inputHeight, setInputHeight] = useState(48);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const { isConnected } = useNetworkStatus();

  const scrollToBottom = (animated = true) =>
    setTimeout(() => listRef.current?.scrollToEnd({ animated }), 60);

  /* ── load cache ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    (async () => {
      const cached = await getSecureCache("chat_team-ypn");
      if (Array.isArray(cached)) setMessages(cached);
      setLoading(false);
      scrollToBottom(false); // open at bottom of last message
    })();
  }, []);

  /* ── persist cache ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!loading) setSecureCache("chat_team-ypn", messages);
  }, [messages]);

  /* ── keyboard ───────────────────────────────────────────────────────────── */
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(e.endCoordinates.height);
      scrollToBottom();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(0);
      setInputHeight(48);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /* ── send ───────────────────────────────────────────────────────────────── */
  const sendMessage = async (text: string, retryId?: string) => {
    if (!text.trim() || !isConnected) return;

    const messageId = retryId || Date.now().toString();

    const userMsg: Message = {
      id: messageId,
      text,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "sent", // single grey tick
    };

    setMessages((prev) =>
      retryId
        ? prev.filter((m) => m.id !== retryId).concat(userMsg)
        : [...prev, userMsg],
    );
    scrollToBottom();

    // 400ms later → double grey tick (delivered)
    setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, status: "delivered" } : m,
        ),
      );
    }, 400);

    setAiTyping(true);
    scrollToBottom();

    try {
      const res = await fetch(AI_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) throw new Error(await res.text());
      const { reply } = await res.json();

      // double blue tick (read) + AI reply appears
      setAiTyping(false);
      setMessages((prev) => [
        ...prev.map((m) => (m.id === messageId ? { ...m, status: "read" } : m)),
        {
          id: Date.now().toString(),
          text: reply,
          sender: "ai",
          timestamp: new Date().toISOString(),
          status: "read",
        },
      ]);
      scrollToBottom();
    } catch {
      setAiTyping(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, status: "failed" } : m)),
      );
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setInputHeight(48);
    sendMessage(text);
  };

  /* ── date headers ───────────────────────────────────────────────────────── */
  const formatDateHeader = (iso: string) => {
    const d = new Date(iso);
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
    | { type: "header"; text: string }
    | { type: "message"; text: string; item: Message };

  const grouped = (): GroupItem[] => {
    const out: GroupItem[] = [];
    let lastDate = "";
    messages.forEach((msg) => {
      const dh = formatDateHeader(msg.timestamp);
      if (dh !== lastDate) {
        out.push({ type: "header", text: dh });
        lastDate = dh;
      }
      out.push({ type: "message", text: msg.text, item: msg });
    });
    return out;
  };

  /* ── render item ────────────────────────────────────────────────────────── */
  const renderItem = ({ item }: { item: GroupItem }) => {
    if (item.type === "header") {
      return (
        <View style={styles.dateHeader}>
          <Text style={styles.dateHeaderText}>{item.text}</Text>
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
      <View style={[styles.row, isUser && styles.userRow]}>
        <View
          style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}
        >
          <Text style={styles.text}>{msg.text}</Text>
          <View style={styles.meta}>
            <Text style={styles.time}>{time}</Text>
            {isUser && msg.status === "failed" ? (
              <Pressable onPress={() => sendMessage(msg.text, msg.id)}>
                <Ionicons
                  name="alert-circle"
                  size={15}
                  color="#FF453A"
                  style={{ marginLeft: 2 }}
                />
              </Pressable>
            ) : isUser ? (
              <Ticks status={msg.status} />
            ) : null}
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#25D366" />
      </View>
    );
  }

  /* ── main render ────────────────────────────────────────────────────────── */
  return (
    <View style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </Pressable>
        <Image
          source={require("../assets/images/YPN.png")}
          style={styles.avatar}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Team YPN</Text>
          <Text style={styles.subtitle}>{aiTyping ? "typing…" : "Online"}</Text>
        </View>
      </View>

      {/* CHAT LIST */}
      <FlatList
        ref={listRef}
        data={grouped()}
        renderItem={renderItem}
        keyExtractor={(item, index) =>
          item.type === "header" ? `header-${index}` : item.item.id
        }
        showsVerticalScrollIndicator={false}
        onLayout={() => scrollToBottom(false)}
        onContentSizeChange={() => scrollToBottom()}
        contentContainerStyle={{
          padding: 12,
          paddingBottom: inputHeight + keyboardHeight + 20,
        }}
        ListFooterComponent={aiTyping ? <TypingIndicator /> : null}
      />

      {/* INPUT BAR */}
      <View style={[styles.inputContainer, { bottom: keyboardHeight }]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message"
          placeholderTextColor="#aaa"
          multiline
          style={[styles.input, { height: inputHeight }]}
          onContentSizeChange={(e) => {
            const h = Math.min(
              120,
              Math.max(48, e.nativeEvent.contentSize.height),
            );
            setInputHeight(h);
          }}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <Pressable
          onPress={handleSend}
          disabled={!input.trim() || aiTyping}
          style={[
            styles.send,
            (!input.trim() || aiTyping) && styles.sendDisabled,
          ]}
        >
          <Ionicons name="send" size={20} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

/* ── styles ─────────────────────────────────────────────────────────────────── */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    paddingTop:
      Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) + 4 : 12,
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  avatar: { width: 40, height: 40, borderRadius: 20, marginHorizontal: 12 },
  title: { color: "#fff", fontSize: 17, fontWeight: "600" },
  subtitle: { color: "#25D366", fontSize: 12 },

  row: { marginVertical: 4 },
  userRow: { alignItems: "flex-end" },

  bubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  userBubble: { backgroundColor: "#25D366" },
  aiBubble: { backgroundColor: "#1f1f1f" },

  typingBubble: { paddingVertical: 14 },
  typingRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  typingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#aaa" },

  text: { color: "#fff", fontSize: 16 },

  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 3,
    gap: 2,
  },
  time: { fontSize: 10, color: "#ddd" },

  dateHeader: {
    alignSelf: "center",
    backgroundColor: "#333",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginVertical: 8,
  },
  dateHeaderText: { color: "#ccc", fontSize: 12, fontWeight: "600" },

  inputContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: "#222",
    backgroundColor: "#111",
  },
  input: {
    flex: 1,
    backgroundColor: "#222",
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 16,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#25D366",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  sendDisabled: { backgroundColor: "#1a4d2e" },
});
