import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useRef } from "react";
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
import { Message } from "../types/chat";

interface Props {
  messages: Message[];
  input: string;
  setInput: (v: string) => void;
  send: () => void;
  sending: boolean;
  typing: boolean;
  online: boolean;
  onBack: () => void;
}

export default function ChatUI({
  messages,
  input,
  setInput,
  send,
  sending,
  typing,
  online,
  onBack,
}: Props) {
  const listRef = useRef<FlatList>(null);

  const scrollToBottom = () =>
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

  useEffect(() => {
    scrollToBottom();
  }, [messages, typing]);

  const renderTicks = (status?: string) => {
    if (status === "sending") {
      return <Ionicons name="time-outline" size={12} color="#ccc" />;
    }
    if (status === "sent") {
      return <Ionicons name="checkmark" size={14} color="#ccc" />;
    }
    if (status === "delivered") {
      return (
        <View style={{ flexDirection: "row" }}>
          <Ionicons name="checkmark" size={14} color="#3396FD" />
          <Ionicons name="checkmark" size={14} color="#3396FD" />
        </View>
      );
    }
    if (status === "failed") {
      return <Ionicons name="alert-circle" size={14} color="#FF3B30" />;
    }
    return null;
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.sender === "user";

    return (
      <View style={[styles.row, isUser && styles.rowUser]}>
        <View
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}
        >
          <Text style={styles.msgText}>{item.text}</Text>
          <View style={styles.meta}>{isUser && renderTicks(item.status)}</View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        <View style={styles.headerInfo}>
          <Image
            source={require("../../assets/images/YPN.png")}
            style={styles.avatar}
          />
          <View>
            <Text style={styles.name}>Team YPN</Text>
            <Text style={styles.status}>
              {online ? (typing ? "typing..." : "Online") : "Offline"}
            </Text>
          </View>
        </View>

        <View
          style={[
            styles.dot,
            { backgroundColor: online ? "#34C759" : "#FF3B30" },
          ]}
        />
      </View>

      {/* CHAT */}
      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />

      {/* INPUT */}
      <View style={styles.bar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message"
          placeholderTextColor="#8E8E93"
          style={styles.input}
          multiline
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

  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#282828",
  },

  headerInfo: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginLeft: 10,
    gap: 10,
  },

  avatar: { width: 40, height: 40, borderRadius: 20 },
  name: { color: "#fff", fontSize: 16, fontWeight: "600" },
  status: { color: "#3396FD", fontSize: 12 },

  dot: { width: 10, height: 10, borderRadius: 5 },

  list: { padding: 12, paddingBottom: 100 },

  row: { marginVertical: 6, maxWidth: "85%" },
  rowUser: { alignSelf: "flex-end" },

  bubble: { padding: 10, borderRadius: 18 },
  bubbleUser: { backgroundColor: "#00A884" },
  bubbleAI: { backgroundColor: "#333" },

  msgText: { color: "#fff", fontSize: 16 },

  meta: {
    alignItems: "flex-end",
    marginTop: 4,
  },

  bar: {
    flexDirection: "row",
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: "#282828",
    backgroundColor: "#121212",
  },

  input: {
    flex: 1,
    backgroundColor: "#222",
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 10,
    color: "#fff",
    maxHeight: 100,
  },

  sendBtn: {
    marginLeft: 10,
    backgroundColor: "#00A884",
    padding: 10,
    borderRadius: 20,
  },

  sendBtnOff: {
    backgroundColor: "#333",
  },
});
