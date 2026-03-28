// src/screens/discord.tsx
//
// Discord-style multi-channel community chat.
// Powered by Firebase Firestore realtime (onSnapshot).
//
// Firestore structure:
//   channels/{channelId}/messages/{msgId}
//     → text, uid, displayName, createdAt (serverTimestamp)
//
// Security: add Firestore rules so only authenticated users can read/write.

import { Ionicons } from "@expo/vector-icons";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";

// ─── Channels ─────────────────────────────────────────────────────────────────
const CHANNELS = [
  {
    id: "general",
    name: "general",
    icon: "chatbubbles-outline",
    desc: "General YPN chat",
  },
  {
    id: "mental-health",
    name: "mental-health",
    icon: "heart-outline",
    desc: "Safe space to talk",
  },
  {
    id: "jobs",
    name: "jobs",
    icon: "briefcase-outline",
    desc: "Opportunities & careers",
  },
  {
    id: "education",
    name: "education",
    icon: "school-outline",
    desc: "Learning & resources",
  },
  {
    id: "prayer",
    name: "prayer",
    icon: "sparkles-outline",
    desc: "Prayer & support",
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type Message = {
  id: string;
  text: string;
  uid: string;
  displayName: string;
  createdAt: number;
};

type Channel = (typeof CHANNELS)[0];

// ─── Time formatter ───────────────────────────────────────────────────────────
function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateHeader(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

// ─── Message bubble ───────────────────────────────────────────────────────────
const Bubble = React.memo(
  ({
    msg,
    isMe,
    showName,
  }: {
    msg: Message;
    isMe: boolean;
    showName: boolean;
  }) => (
    <View style={[bub.row, isMe && bub.rowMe]}>
      {!isMe && (
        <View style={bub.avatar}>
          <Text style={bub.avatarText}>
            {(msg.displayName?.[0] ?? "?").toUpperCase()}
          </Text>
        </View>
      )}
      <View style={[bub.bubble, isMe ? bub.bubbleMe : bub.bubbleThem]}>
        {showName && !isMe && <Text style={bub.name}>{msg.displayName}</Text>}
        <Text style={bub.text}>{msg.text}</Text>
        <Text style={bub.time}>{formatTime(msg.createdAt)}</Text>
      </View>
    </View>
  ),
);

const bub = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 2,
    paddingHorizontal: 12,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#5865F2",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 6,
    marginBottom: 2,
  },
  avatarText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  bubbleMe: { backgroundColor: "#5865F2", borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#2B2D31", borderBottomLeftRadius: 4 },
  name: { color: "#B5BAC1", fontSize: 11, fontWeight: "700", marginBottom: 2 },
  text: { color: "#DBDEE1", fontSize: 15, lineHeight: 21 },
  time: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 10,
    marginTop: 3,
    textAlign: "right",
  },
});

// ─── Channel sidebar ──────────────────────────────────────────────────────────
const Sidebar = ({
  active,
  onSelect,
  onClose,
}: {
  active: Channel;
  onSelect: (c: Channel) => void;
  onClose: () => void;
}) => {
  const insets = useSafeAreaInsets();
  return (
    <View style={[side.root, { paddingTop: insets.top + 8 }]}>
      <Text style={side.heading}>YPN Community</Text>
      <Text style={side.subheading}>TEXT CHANNELS</Text>
      {CHANNELS.map((ch) => {
        const isActive = ch.id === active.id;
        return (
          <TouchableOpacity
            key={ch.id}
            style={[side.item, isActive && side.itemActive]}
            onPress={() => {
              onSelect(ch);
              onClose();
            }}
            activeOpacity={0.7}
          >
            <Text style={[side.hash, isActive && side.hashActive]}>#</Text>
            <Text style={[side.chName, isActive && side.chNameActive]}>
              {ch.name}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const side = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#2B2D31", paddingHorizontal: 8 },
  heading: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    paddingHorizontal: 8,
    marginBottom: 16,
  },
  subheading: {
    color: "#8D9096",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    marginBottom: 2,
  },
  itemActive: { backgroundColor: "#404249" },
  hash: {
    color: "#8D9096",
    fontSize: 18,
    fontWeight: "700",
    marginRight: 6,
    width: 16,
  },
  hashActive: { color: "#DBDEE1" },
  chName: { color: "#8D9096", fontSize: 15, fontWeight: "500" },
  chNameActive: { color: "#DBDEE1", fontWeight: "600" },
});

// ─── Chat view ────────────────────────────────────────────────────────────────
function ChatView({ channel }: { channel: Channel }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);
  const me = auth?.currentUser;

  // Realtime Firestore listener
  useEffect(() => {
    setLoading(true);
    setMessages([]);

    const q = query(
      collection(db, "channels", channel.id, "messages"),
      orderBy("createdAt", "asc"),
      limit(100),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const msgs: Message[] = snap.docs.map((doc) => {
          const d = doc.data();
          return {
            id: doc.id,
            text: d.text ?? "",
            uid: d.uid ?? "",
            displayName: d.displayName ?? "Anonymous",
            createdAt: d.createdAt?.toMillis?.() ?? Date.now(),
          };
        });
        setMessages(msgs);
        setLoading(false);
        // Scroll to bottom when new messages arrive
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      },
      (err) => {
        console.error("[Discord] Firestore error:", err);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [channel.id]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !me) return;
    setInput("");
    setSending(true);
    try {
      await addDoc(collection(db, "channels", channel.id, "messages"), {
        text,
        uid: me.uid,
        displayName: me.displayName || me.email?.split("@")[0] || "User",
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("[Discord] Send failed:", e);
      // Restore input if send failed
      setInput(text);
    } finally {
      setSending(false);
    }
  }, [input, sending, me, channel.id]);

  // Group messages by date for date headers
  const grouped = React.useMemo(() => {
    const result: Array<
      | { type: "header"; date: string }
      | { type: "msg"; msg: Message; showName: boolean }
    > = [];
    let lastDate = "";
    let lastUid = "";

    messages.forEach((msg) => {
      const dateStr = formatDateHeader(msg.createdAt);
      if (dateStr !== lastDate) {
        result.push({ type: "header", date: dateStr });
        lastDate = dateStr;
        lastUid = "";
      }
      result.push({ type: "msg", msg, showName: msg.uid !== lastUid });
      lastUid = msg.uid;
    });

    return result;
  }, [messages]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* Channel header */}
      <View style={chat.channelHeader}>
        <Text style={chat.hashIcon}>#</Text>
        <View>
          <Text style={chat.channelName}>{channel.name}</Text>
          <Text style={chat.channelDesc}>{channel.desc}</Text>
        </View>
      </View>

      {/* Messages */}
      {loading ? (
        <View style={chat.centre}>
          <ActivityIndicator color="#5865F2" />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={grouped}
          keyExtractor={(item, i) =>
            item.type === "header" ? `h-${i}` : item.msg.id
          }
          renderItem={({ item }) => {
            if (item.type === "header") {
              return (
                <View style={chat.dateRow}>
                  <View style={chat.dateLine} />
                  <Text style={chat.dateText}>{item.date}</Text>
                  <View style={chat.dateLine} />
                </View>
              );
            }
            return (
              <Bubble
                msg={item.msg}
                isMe={item.msg.uid === me?.uid}
                showName={item.showName}
              />
            );
          }}
          contentContainerStyle={{ paddingVertical: 12, paddingBottom: 8 }}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: false })
          }
          ListEmptyComponent={
            <View style={chat.centre}>
              <Ionicons name="chatbubbles-outline" size={40} color="#444" />
              <Text style={chat.emptyText}>
                No messages yet.{"\n"}Say hello in #{channel.name}!
              </Text>
            </View>
          }
        />
      )}

      {/* Input bar */}
      <View style={chat.inputBar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={`Message #${channel.name}`}
          placeholderTextColor="#6D6F78"
          style={chat.input}
          multiline
          maxLength={500}
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
          editable={!!me}
        />
        <Pressable
          onPress={sendMessage}
          disabled={!input.trim() || sending || !me}
          style={({ pressed }) => [
            chat.sendBtn,
            (!input.trim() || !me) && chat.sendBtnOff,
            pressed && { opacity: 0.7 },
          ]}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="send" size={18} color="#fff" />
          )}
        </Pressable>
      </View>

      {!me && (
        <View style={chat.authBanner}>
          <Ionicons name="lock-closed-outline" size={14} color="#FFA500" />
          <Text style={chat.authText}>Sign in to send messages</Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const chat = StyleSheet.create({
  channelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1E1F22",
    backgroundColor: "#313338",
  },
  hashIcon: { color: "#8D9096", fontSize: 22, fontWeight: "700" },
  channelName: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  channelDesc: { color: "#8D9096", fontSize: 12 },

  centre: { flex: 1, justifyContent: "center", alignItems: "center", gap: 10 },
  emptyText: {
    color: "#6D6F78",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },

  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginVertical: 12,
    gap: 8,
  },
  dateLine: { flex: 1, height: 1, backgroundColor: "#3F4147" },
  dateText: { color: "#8D9096", fontSize: 11, fontWeight: "600" },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    margin: 12,
    backgroundColor: "#383A40",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
    color: "#DBDEE1",
    fontSize: 15,
    maxHeight: 100,
    paddingVertical: 4,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#5865F2",
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnOff: { backgroundColor: "#404249" },

  authBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    backgroundColor: "#FFA50018",
  },
  authText: { color: "#FFA500", fontSize: 12 },
});

// ─── Main Discord screen ──────────────────────────────────────────────────────
const STATUS_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;
const TOP_OFFSET = STATUS_H + 48;

export default function DiscordScreen() {
  const [activeChannel, setActiveChannel] = useState(CHANNELS[0]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <View style={main.root}>
      {/* Spacer for floating community tab bar */}
      <View style={{ height: TOP_OFFSET }} />

      <View style={main.body}>
        {/* Sidebar (conditionally shown) */}
        {sidebarOpen && (
          <View style={main.sidebar}>
            <Sidebar
              active={activeChannel}
              onSelect={setActiveChannel}
              onClose={() => setSidebarOpen(false)}
            />
          </View>
        )}

        {/* Main chat area */}
        <View style={main.chat}>
          {/* Top bar with hamburger */}
          <View style={main.topBar}>
            <TouchableOpacity
              onPress={() => setSidebarOpen((p) => !p)}
              style={main.hamburger}
              activeOpacity={0.7}
            >
              <Ionicons
                name={sidebarOpen ? "close" : "menu"}
                size={22}
                color="#DBDEE1"
              />
            </TouchableOpacity>
            <Text style={main.topBarTitle}>#{activeChannel.name}</Text>
            <View style={{ width: 36 }} />
          </View>

          <ChatView channel={activeChannel} />
        </View>
      </View>
    </View>
  );
}

const main = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#313338" },
  body: { flex: 1, flexDirection: "row" },

  sidebar: { width: 220, borderRightWidth: 1, borderRightColor: "#1E1F22" },

  chat: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#313338",
    borderBottomWidth: 1,
    borderBottomColor: "#1E1F22",
  },
  hamburger: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  topBarTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
