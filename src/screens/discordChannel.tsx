//
// Key fixes:
// 1. Profile loaded from SecureStore (app.user_data) first — always available after login
// 2. API profile fetch runs in background only — never blocks UI
// 3. isMe check uses uid comparison — consistent with DB and Backend
// 4. Send button enabled as soon as local profile resolves (instant)
// 5. Messages now use uid for sender_id to ensure correct identity alignment
// 6. Added Initial Full History Fetch for new users
// 7. FIXED: SQLite Transaction Collisions via Queue System
// 8. FIXED: Polling Race Conditions via pollLock

import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  addOptimisticMessage,
  confirmMessage,
  deleteMessageLocally,
  getCachedMessages,
  initChatDB,
  type CachedMessage,
} from "../utils/chatCache";
import {
  getChatProfile,
  getStoredUid,
  getStoredUserData,
  type ChatProfile,
} from "../utils/chatProfile";
// Import the new queue system
import { queueCacheDiscordMessages } from "../utils/cacheQueue";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

type Message = CachedMessage & {
  localId?: string;
  failed?: boolean;
  isMe?: boolean;
};

export default function DiscordChannelScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    channelId,
    channelName,
    channelEmoji,
    channelColor,
    channelDescription,
  } = useLocalSearchParams<{
    channelId: string;
    channelName: string;
    channelEmoji: string;
    channelColor: string;
    channelDescription: string;
  }>();

  const color = channelColor ?? "#5865F2";

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [chatProfile, setChatProfile] = useState<ChatProfile | null>(null);

  const listRef = useRef<FlatList>(null);

  // 🔥 LOCKS
  const pollLock = useRef(false); // Prevents overlapping poll cycles
  const fetchLock = useRef(false); // Prevents overlapping network requests
  const initialLoaded = useRef(false); // Prevents double initial sync

  // ── Step 1: Load profile from SecureStore FIRST (instant, no network)
  useEffect(() => {
    const loadProfile = async () => {
      // Try SecureStore (always available after login)
      const stored = await getStoredUserData();
      if (stored?.uid && stored?.username) {
        setChatProfile({
          uid: stored.uid,
          username: stored.username,
          avatarUrl: stored.avatarUrl || null,
        });
        setLoading(false);

        // Background refresh from API (non-blocking)
        const uid = stored.uid;
        getChatProfile(uid, false)
          .then((fresh) => {
            if (fresh) setChatProfile(fresh);
          })
          .catch(() => {
            // Non-fatal — keep using SecureStore data
          });

        return;
      }

      // Fallback: try API
      const uid = await getStoredUid();
      if (uid) {
        const profile = await getChatProfile(uid).catch(() => null);
        if (profile) setChatProfile(profile);
      }
      setLoading(false);
    };

    loadProfile();
  }, []);

  // ── Network status
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(!!state.isConnected);
    });
    return () => unsubscribe();
  }, []);

  // ── Init DB + load cached messages
  useEffect(() => {
    if (!channelId) return;
    const setup = async () => {
      await initChatDB();
      await loadCachedMessages();
    };
    setup();
  }, [channelId]);

  // 🔥 FIX 1 & 3: Force initial full sync with guard
  const loadCachedMessages = async () => {
    if (initialLoaded.current) return;
    initialLoaded.current = true;

    try {
      const cached = await getCachedMessages(channelId);
      const visible = cached.filter((m) => m.is_deleted_local !== 1);
      setMessages(visible);

      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: false });
      }, 50);

      // 🔥 ALWAYS fetch full history on first load (new users included)
      await fetchInitialMessages();
    } catch (e) {
      console.warn("[Discord] cache load failed:", e);
    }
  };

  // 🔥 FIX 2: Add proper “initial full history fetch”
  const fetchInitialMessages = async () => {
    if (!channelId || !isOnline) return;

    try {
      const res = await fetch(
        `${API_URL}/api/discord/messages/${channelId}?limit=50`,
      );

      if (!res.ok) return;

      const data: CachedMessage[] = await res.json();
      const clean = data.filter((m) => m.is_deleted_local !== 1);

      setMessages(clean);
      // Use Queue System
      queueCacheDiscordMessages(channelId, clean);

      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: false });
      }, 100);
    } catch (e) {
      console.warn("[Discord] initial sync failed:", e);
    }
  };

  // ── Fetch new messages from server (incremental)
  const fetchNewMessages = async (currentMessages?: Message[]) => {
    if (!channelId || !isOnline) return;
    if (fetchLock.current) return; // Prevent overlap

    fetchLock.current = true;

    try {
      const msgs = currentMessages ?? messages;
      const lastMsg = msgs[msgs.length - 1];

      const url = new URL(`${API_URL}/api/discord/messages/${channelId}`);
      if (lastMsg?.created_at) {
        url.searchParams.append("after", lastMsg.created_at);
      }

      const res = await fetch(url.toString());
      if (!res.ok) return;

      const newMsgs: CachedMessage[] = await res.json();
      if (!newMsgs.length) return;

      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const unique = newMsgs.filter(
          (m) => !ids.has(m.id) && m.is_deleted_local !== 1,
        );
        return [...prev, ...unique].slice(-200);
      });

      const toCache = newMsgs.filter((m) => m.is_deleted_local !== 1);
      if (toCache.length > 0) {
        // Use Queue System
        queueCacheDiscordMessages(channelId, toCache);
      }
    } catch (e) {
      console.warn("[Discord] Sync failed:", e);
    } finally {
      fetchLock.current = false;
    }
  };

  // ── Pull-to-refresh older messages
  const fetchOlderMessages = async () => {
    if (!channelId || !isOnline || messages.length === 0) return;
    try {
      const oldest = messages[0].created_at;
      const res = await fetch(
        `${API_URL}/api/discord/messages/${channelId}?before=${oldest}&limit=30`,
      );
      if (!res.ok) return;
      const older: CachedMessage[] = await res.json();
      const visible = older.filter((m) => m.is_deleted_local !== 1);
      if (!visible.length) return;
      setMessages((prev) => [...visible, ...prev]);
      // Use Queue System for older messages too
      queueCacheDiscordMessages(channelId, visible);
    } catch (e) {
      console.warn("[Discord] Older messages error:", e);
    }
  };

  useFocusEffect(
    useCallback(() => {
      // Only fetch if we aren't already syncing or fetching
      if (!fetchLock.current && !pollLock.current) {
        fetchNewMessages();
      }
    }, [channelId, isOnline]),
  );

  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        router.replace("/(tabs)/discord");
        return true;
      };
      const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
      return () => sub.remove();
    }, [router]),
  );

  // 🔥 FIX 3: Real-time sync (Polling fallback) with pollLock
  useEffect(() => {
    if (!channelId || !isOnline) return;

    const interval = setInterval(async () => {
      if (pollLock.current) return;

      pollLock.current = true;
      try {
        await fetchNewMessages();
      } finally {
        pollLock.current = false;
      }
    }, 4000); // 4s polling interval

    return () => clearInterval(interval);
  }, [channelId, isOnline]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  // ── Send message
  const sendTextMessage = async () => {
    const text = input.trim();
    if (!text || !channelId || !chatProfile) return;

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // ✅ FIX: Use uid for sender_id
    const msg: CachedMessage = {
      id: localId,
      channel_id: channelId,
      sender_id: chatProfile.uid,
      content: text,
      media_type: null,
      media_url: null,
      username: chatProfile.username,
      avatar_url: chatProfile.avatarUrl,
      created_at: new Date().toISOString(),
      is_optimistic: 1,
      is_deleted_local: 0,
    };

    // Clear input immediately — don't wait for network
    setInput("");

    await addOptimisticMessage(msg);
    setMessages((prev) => [
      ...prev,
      { ...msg, localId, failed: false, isMe: true },
    ]);

    sendMessageToServer(msg, localId);
  };

  const sendMessageToServer = async (msg: CachedMessage, localId: string) => {
    try {
      // ✅ FIX: Send uid to backend so it can use it as the true sender_id
      const res = await fetch(`${API_URL}/api/discord/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: msg.channel_id,
          uid: msg.sender_id, // ✅ ADD THIS
          username: msg.username,
          avatarUrl: msg.avatar_url,
          content: msg.content,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const serverMsg = await res.json();
      await confirmMessage(serverMsg.id, localId);

      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId || m.id === localId
            ? { ...serverMsg, localId: undefined, failed: false, isMe: true }
            : m,
        ),
      );
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId || m.id === localId
            ? { ...m, failed: true }
            : m,
        ),
      );
    }
  };

  const retryMessage = (msg: Message) => {
    if (!msg.failed) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id || m.localId === msg.id ? { ...m, failed: false } : m,
      ),
    );
    sendMessageToServer(msg, msg.localId ?? msg.id);
  };

  // ── Delete message
  const handleLongPress = (msg: Message) => {
    // ✅ FIX: Use uid for ownership check
    const isMyMessage = msg.sender_id === chatProfile?.uid || msg.isMe;

    Alert.alert(
      "Delete Message",
      isMyMessage
        ? "Delete for everyone or just for you?"
        : "Hide this message?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isMyMessage ? "Delete for Everyone" : "Hide for Me",
          style: "destructive",
          onPress: async () => {
            if (isMyMessage) {
              try {
                await fetch(`${API_URL}/api/discord/messages/${msg.id}`, {
                  method: "DELETE",
                });
                setMessages((prev) => prev.filter((m) => m.id !== msg.id));
                await deleteMessageLocally(msg.id);
              } catch {
                Alert.alert("Error", "Could not delete message");
              }
            } else {
              await deleteMessageLocally(msg.id);
              setMessages((prev) => prev.filter((m) => m.id !== msg.id));
            }
          },
        },
        ...(isMyMessage
          ? [
              {
                text: "Hide for Me Only",
                onPress: async () => {
                  await deleteMessageLocally(msg.id);
                  setMessages((prev) => prev.filter((m) => m.id !== msg.id));
                },
              },
            ]
          : []),
      ],
    );
  };

  // ── Render single message
  const renderMessage = ({ item }: { item: Message }) => {
    // ✅ FIX: Use uid for isMe check ONLY
    const isMe = item.sender_id === chatProfile?.uid;
    const time = new Date(item.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <TouchableOpacity
        style={[bS.row, isMe && bS.rowMe]}
        onLongPress={() => handleLongPress(item)}
        delayLongPress={300}
        activeOpacity={0.9}
      >
        {/* Avatar — only for other users */}
        {!isMe &&
          (item.avatar_url ? (
            <Image
              source={{ uri: item.avatar_url }}
              style={bS.avatar}
              resizeMode="cover"
            />
          ) : (
            <View
              style={[
                bS.avatar,
                bS.avatarPlaceholder,
                { backgroundColor: color + "33" },
              ]}
            >
              <Text style={[bS.avatarText, { color }]}>
                {(item.username?.[0] ?? "?").toUpperCase()}
              </Text>
            </View>
          ))}

        <View
          style={[
            bS.bubble,
            isMe ? [bS.bubbleMe, { backgroundColor: color }] : bS.bubbleThem,
          ]}
        >
          {!isMe && item.username && (
            <Text style={[bS.senderName, { color }]}>{item.username}</Text>
          )}

          {item.content ? (
            <Text
              style={[
                bS.text,
                isMe && color === "#FEE75C" && { color: "#000" },
              ]}
            >
              {item.content}
            </Text>
          ) : null}

          {item.failed && (
            <TouchableOpacity
              onPress={() => retryMessage(item)}
              style={{ marginTop: 4 }}
            >
              <Text
                style={{ color: "#ff4444", fontSize: 11, fontWeight: "700" }}
              >
                Tap to retry
              </Text>
            </TouchableOpacity>
          )}

          <Text
            style={[
              bS.time,
              isMe && { color: color === "#FEE75C" ? "#0008" : "#fff8" },
            ]}
          >
            {time}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // ── Header (reused in loading and normal state)
  const Header = () => (
    <View style={s.header}>
      <TouchableOpacity
        onPress={() => router.replace("/(tabs)/discord")}
        style={s.backBtn}
      >
        <Ionicons name="arrow-back" size={22} color="#fff" />
      </TouchableOpacity>
      <Text style={s.headerEmoji}>{channelEmoji}</Text>
      <View style={s.headerText}>
        <Text style={s.headerTitle}>#{channelName}</Text>
        <Text style={s.headerDesc} numberOfLines={1}>
          {channelDescription}
        </Text>
      </View>
      {!isOnline && (
        <View style={s.offlineBadge}>
          <Text style={s.offlineText}>Offline</Text>
        </View>
      )}
    </View>
  );

  // ── Loading state (only while profile hasn't resolved yet)
  if (loading && !chatProfile) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <Header />
        <View style={s.centre}>
          <ActivityIndicator color={color} size="large" />
          <Text style={{ color: "#888", marginTop: 12 }}>Loading...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Header />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 56 : 0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.localId ?? m.id ?? Math.random().toString()}
          renderItem={renderMessage}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          onRefresh={fetchOlderMessages}
          refreshing={false}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>{channelEmoji}</Text>
              <Text style={s.emptyTitle}>#{channelName}</Text>
              <Text style={s.emptyDesc}>{channelDescription}</Text>
              <Text style={s.emptyHint}>Be the first to say something 👋</Text>
            </View>
          }
        />

        <View
          style={[s.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
        >
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={
              chatProfile
                ? `Message as ${chatProfile.username}`
                : "Loading profile..."
            }
            placeholderTextColor="#444"
            style={s.textInput}
            multiline
            maxLength={2000}
            editable={!!chatProfile}
            returnKeyType="send"
            onSubmitEditing={sendTextMessage}
          />
          <TouchableOpacity
            onPress={input.trim() ? sendTextMessage : undefined}
            disabled={!input.trim() || !chatProfile}
            style={[
              s.sendBtn,
              { backgroundColor: color },
              (!input.trim() || !chatProfile) && s.sendBtnOff,
            ]}
          >
            <Ionicons
              name="send"
              size={18}
              color={color === "#FEE75C" ? "#000" : "#fff"}
            />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Bubble styles
const bS = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 3,
    paddingHorizontal: 12,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: 8,
    marginBottom: 2,
    flexShrink: 0,
  },
  avatarPlaceholder: { justifyContent: "center", alignItems: "center" },
  avatarText: { fontWeight: "700", fontSize: 13 },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#161616", borderBottomLeftRadius: 4 },
  senderName: { fontSize: 11, fontWeight: "700", marginBottom: 3 },
  text: { color: "#fff", fontSize: 15, lineHeight: 21 },
  time: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 10,
    marginTop: 4,
    textAlign: "right",
  },
});

// ── Screen styles
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#0D0D0D",
    borderBottomWidth: 1,
    borderBottomColor: "#111",
    gap: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  headerEmoji: { fontSize: 22 },
  headerText: { flex: 1 },
  headerTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  headerDesc: { color: "#444", fontSize: 12, marginTop: 1 },
  offlineBadge: {
    backgroundColor: "#ED4245",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  offlineText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  centre: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingVertical: 12, paddingBottom: 8 },
  empty: { alignItems: "center", padding: 40, gap: 10, marginTop: 60 },
  emptyTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  emptyDesc: { color: "#555", fontSize: 14, textAlign: "center" },
  emptyHint: { color: "#333", fontSize: 13, marginTop: 6 },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingTop: 8,
    backgroundColor: "#0D0D0D",
    borderTopWidth: 1,
    borderTopColor: "#111",
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: "#161616",
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#fff",
    fontSize: 15,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnOff: { backgroundColor: "#1A1A1A" },
});
