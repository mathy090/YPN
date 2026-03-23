import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Message } from "../src/types/chat";
import { getSecureCache, setSecureCache } from "../src/utils/cache";

const AI_URL = process.env.EXPO_PUBLIC_AI_URL + "/chat";

export default function TeamYPNScreen() {
  const router = useRouter();
  const listRef = useRef<FlatList>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [loading, setLoading] = useState(true);

  const scrollToBottom = () =>
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

  useEffect(() => {
    (async () => {
      try {
        const cached = await getSecureCache("chat_team-ypn");
        if (Array.isArray(cached)) setMessages(cached);
      } catch {
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loading && messages.length > 0)
      setSecureCache("chat_team-ypn", messages).catch(() => {});
  }, [messages]);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, typing]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput("");

    const msgId = Date.now().toString();
    const userMsg: Message = {
      id: msgId,
      text,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "sent",
    };

    setMessages((prev) => [...prev, userMsg]);
    setTyping(true);

    try {
      const res = await fetch(AI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: "ypn-general" }),
      });

      const data = await res.json();
      const reply = data.reply || data.message || data.text || "No response";

      setTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          text: reply,
          sender: "ai",
          timestamp: new Date().toISOString(),
          status: "read",
        },
      ]);
    } catch (e) {
      setTyping(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, status: "failed" } : m)),
      );
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.sender === "user";
    const time = new Date(item.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <View style={[styles.row, isUser && styles.rowUser]}>
        <View
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}
        >
          <Text style={styles.msgText}>{item.text}</Text>
          <View style={styles.meta}>
            <Text style={styles.time}>{time}</Text>
            {isUser && item.status === "failed" && (
              <TouchableOpacity
                onPress={() => {
                  setMessages((prev) => prev.filter((m) => m.id !== item.id));
                  setInput(item.text);
                }}
              >
                <Ionicons name="alert-circle" size={14} color="#FF3B30" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3396FD" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Image
            source={require("../assets/images/YPN.png")}
            style={styles.avatar}
          />
          <View>
            <Text style={styles.name}>Team YPN</Text>
            <Text style={styles.status}>{typing ? "typing..." : "Online"}</Text>
          </View>
        </View>
        <View style={styles.dot} />
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={scrollToBottom}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>Say hello to Team YPN</Text>
          </View>
        }
        ListFooterComponent={
          typing ? (
            <View style={styles.row}>
              <View style={styles.bubbleAI}>
                <Text style={styles.typingText}>typing...</Text>
              </View>
            </View>
          ) : null
        }
      />

      <View style={styles.bar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message"
          placeholderTextColor="#8E8E93"
          style={styles.input}
          multiline
          maxLength={500}
          editable={!sending}
          onSubmitEditing={send}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          onPress={send}
          disabled={!input.trim() || sending}
          style={[
            styles.sendBtn,
            (!input.trim() || sending) && styles.sendBtnOff,
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="send" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#000",
    borderBottomWidth: 1,
    borderBottomColor: "#282828",
  },
  back: { padding: 4 },
  headerInfo: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginLeft: 8,
    gap: 10,
  },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  name: { fontSize: 18, fontWeight: "600", color: "#fff" },
  status: { fontSize: 12, color: "#3396FD", marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#34C759" },

  list: { padding: 12, paddingBottom: 100 },
  emptyWrap: { flex: 1, alignItems: "center", paddingTop: 60 },
  emptyText: { color: "#555", fontSize: 16 },

  row: { marginVertical: 6, maxWidth: "85%" },
  rowUser: { alignSelf: "flex-end" },

  bubble: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18 },
  bubbleUser: { backgroundColor: "#00A884", borderBottomRightRadius: 4 },
  bubbleAI: { backgroundColor: "#333", borderBottomLeftRadius: 4 },

  msgText: { color: "#fff", fontSize: 16, lineHeight: 22 },
  typingText: {
    color: "#8E8E93",
    fontSize: 14,
    fontStyle: "italic",
    padding: 4,
  },

  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    gap: 4,
  },
  time: { fontSize: 10, color: "#8E8E93" },

  bar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#121212",
    borderTopWidth: 1,
    borderTopColor: "#282828",
  },
  input: {
    flex: 1,
    backgroundColor: "#282828",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 100,
    marginRight: 10,
    color: "#fff",
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#00A884",
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnOff: { backgroundColor: "#333" },
});
