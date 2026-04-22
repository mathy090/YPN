// src/screens/discordChannel.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Image, // ✅ IMPORTED Image for user icons
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
  cacheMessages,
  confirmMessage,
  deleteMessageLocally,
  getCachedMessages,
  initChatDB,
  type CachedMessage,
} from "../utils/chatCache";
import {
  getChatProfile,
  getStoredUid,
  type ChatProfile,
} from "../utils/chatProfile";

const API_URL = process.env.EXPO_PUBLIC_API_URL;
const MAX_RETRIES = 3;

type Message = CachedMessage & {
  localId?: string;
  failed?: boolean;
};

export default function DiscordChannelScreen() {
  const router = useRouter();
  const navigation = useNavigation();
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
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [chatProfile, setChatProfile] = useState<ChatProfile | null>(null);

  const listRef = useRef<FlatList>(null);

  // Load profile
  useEffect(() => {
    const loadProfile = async () => {
      const uid = await getStoredUid();
      if (!uid) {
        setLoading(false);
        return;
      }
      const profile = await getChatProfile(uid);
      if (profile) setChatProfile(profile);
      setLoading(false);
    };
    loadProfile();
  }, []);

  // Init DB & NetInfo
  useEffect(() => {
    const setup = async () => {
      await initChatDB();
      const unsubscribe = NetInfo.addEventListener((state) => {
        setIsOnline(!!state.isConnected);
      });
      return () => unsubscribe();
    };
    setup();
  }, []);

  // Load cached messages
  useEffect(() => {
    if (!channelId) return;
    loadCachedMessages();
  }, [channelId]);

  const loadCachedMessages = async () => {
    try {
      const cached = await getCachedMessages(channelId);
      // ✅ FIX: Filter out deleted messages and correctly flag 'isMe' using username
      const visible = cached
        .filter((m) => m.is_deleted_local !== 1)
        .map((m) => ({
          ...m,
          isMe: m.username === chatProfile?.username,
        }));
      setMessages(visible);
      setLoading(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      if (isOnline) fetchNewMessages();
    } catch {
      setLoading(false);
    }
  };

  // 📡 Incremental sync
  const fetchNewMessages = async () => {
    if (!channelId || !isOnline) return;
    try {
      const lastMsg = messages[messages.length - 1];
      const after = lastMsg?.created_at || undefined;
      const url = new URL(`${API_URL}/api/discord/messages/${channelId}`);
      if (after) url.searchParams.append("after", after);
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const newMsgs: CachedMessage[] = await res.json();
      if (newMsgs.length === 0) return;

      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        // ✅ FIX: Map 'isMe' using username to ensure alignment is correct
        const unique = newMsgs
          .filter((m) => !ids.has(m.id) && m.is_deleted_local !== 1)
          .map((m) => ({ ...m, isMe: m.username === chatProfile?.username }));
        return [...prev, ...unique].slice(-200);
      });

      const toCache = newMsgs.filter((m) => m.is_deleted_local !== 1);
      if (toCache.length > 0) await cacheMessages(channelId, toCache);
    } catch (e) {
      console.warn("[Sync] Failed:", e);
    }
  };

  // 🔄 Pull-to-refresh older
  const fetchOlderMessages = async () => {
    if (!channelId || !isOnline || loading || messages.length === 0) return;
    try {
      const oldest = messages[0].created_at;
      const res = await fetch(
        `${API_URL}/api/discord/messages/${channelId}?before=${oldest}&limit=30`,
      );
      if (!res.ok) return;
      const older: CachedMessage[] = await res.json();
      if (older.length === 0) return;

      const visible = older.filter((m) => m.is_deleted_local !== 1);
      if (visible.length === 0) return;

      // ✅ FIX: Map 'isMe' using username
      const mapped = visible.map((m) => ({
        ...m,
        isMe: m.username === chatProfile?.username,
      }));
      setMessages((prev) => [...mapped, ...prev]);
      await cacheMessages(channelId, visible);
    } catch (e) {
      console.warn("[Older] Error:", e);
    }
  };

  useFocusEffect(
    useCallback(() => {
      fetchNewMessages();
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

  useEffect(() => {
    if (messages.length > 0)
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages]);

  // 📝 Send text (INSTANT button reset)
  const sendTextMessage = async () => {
    const text = input.trim();
    if (!text || sending || !channelId || !chatProfile) return;

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msg: CachedMessage = {
      id: localId,
      channel_id: channelId,
      sender_id: chatProfile.uid,
      content: text,
      media_type: null,
      media_url: null,
      username: chatProfile.username,
      avatar_url: chatProfile.avatarUrl, // ✅ Ensure avatar_url is sent
      created_at: new Date().toISOString(),
      is_optimistic: 1,
      is_deleted_local: 0,
    };

    // ✅ Clear input and reset button IMMEDIATELY
    setInput("");
    setSending(false);

    // Add to UI optimistically (force isMe: true for instant display)
    await addOptimisticMessage(msg);
    setMessages((prev) => [
      ...prev,
      { ...msg, localId, failed: false, isMe: true },
    ]);

    // Send in background
    sendMessageWithRetry(msg, localId);
  };

  // 🔄 Send with manual retry only (runs in background)
  const sendMessageWithRetry = async (msg: CachedMessage, localId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/discord/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: msg.channel_id,
          username: msg.username,
          avatarUrl: msg.avatar_url, // ✅ Pass avatar to backend
          content: msg.content,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const serverMsg = await res.json();
      await confirmMessage(serverMsg.id, localId);
      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId || m.id === localId
            ? // ✅ FIX: Recalculate isMe based on server response username
              {
                ...serverMsg,
                localId: undefined,
                isMe: serverMsg.username === chatProfile?.username,
              }
            : m,
        ),
      );
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId || m.id === localId
            ? { ...m, failed: true }
            : m,
        ),
      );
    }
  };

  // ✅ Retry failed messages (manual tap only)
  const retryMessage = (msg: Message) => {
    if (!msg.failed) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id || m.localId === msg.id ? { ...m, failed: false } : m,
      ),
    );
    sendMessageWithRetry(msg, msg.id || msg.localId!);
  };

  // 🗑️ Smart Delete: Yours = backend + local, Others = local only
  const handleLongPress = (msg: Message) => {
    const isMyMessage = msg.username === chatProfile?.username;

    Alert.alert(
      "Delete Message",
      isMyMessage
        ? "Delete for everyone or just for you?"
        : "Hide this message just for you?",
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
        isMyMessage && {
          text: "Hide for Me Only",
          onPress: async () => {
            await deleteMessageLocally(msg.id);
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          },
        },
      ].filter(Boolean) as any[],
    );
  };

  // 🎨 Render Message (Fixed alignment + Avatar Import)
  const renderMessage = ({ item }: { item: Message }) => {
    // ✅ FIX: Reliable 'isMe' check using username
    const isMe = item.username === chatProfile?.username || item.isMe === true;
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
        {/* ✅ FIX: Avatar for OTHER users only */}
        {!isMe &&
          (item.avatar_url ? (
            // ✅ Show actual user icon if available
            <Image
              source={{ uri: item.avatar_url }}
              style={bS.avatar}
              resizeMode="cover"
            />
          ) : (
            // ✅ Fallback to colored circle with initial
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
          {/* ✅ FIX: Username for OTHER users only */}
          {!isMe && item.username && (
            <Text style={[bS.senderName, { color }]}>{item.username}</Text>
          )}

          {item.content && (
            <Text
              style={[
                bS.text,
                isMe && color === "#FEE75C" && { color: "#000" },
              ]}
            >
              {item.content}
            </Text>
          )}

          {/* Failed indicator */}
          {item.failed && (
            <TouchableOpacity
              onPress={() => retryMessage(item)}
              activeOpacity={0.6}
              style={{ marginTop: 4, alignSelf: "flex-end" }}
            >
              <Text
                style={{
                  color: "#ff4444",
                  fontSize: 11,
                  fontWeight: "700",
                  letterSpacing: 0.5,
                }}
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

  if (loading && !chatProfile) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
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
        <View style={s.centre}>
          <ActivityIndicator color={color} size="large" />
          <Text style={{ color: "#888", marginTop: 12 }}>Loading...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
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

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 56 : 0}
      >
        {loading && messages.length === 0 ? (
          <View style={s.centre}>
            <ActivityIndicator color={color} size="large" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id || m.localId || Math.random().toString()}
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
                <Text style={s.emptyHint}>
                  Be the first to say something 👋
                </Text>
              </View>
            }
          />
        )}

        <View
          style={[s.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
        >
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={
              chatProfile ? `Message as ${chatProfile.username}` : "Loading..."
            }
            placeholderTextColor="#444"
            style={s.textInput}
            multiline
            maxLength={2000}
            editable={!sending && !!chatProfile}
            onSubmitEditing={sendTextMessage}
            returnKeyType="send"
          />
          <TouchableOpacity
            onPress={input.trim() ? sendTextMessage : undefined}
            disabled={!input.trim() || sending || !chatProfile}
            style={[
              s.sendBtn,
              { backgroundColor: color },
              (!input.trim() || sending || !chatProfile) && s.sendBtnOff,
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons
                name="send"
                size={18}
                color={color === "#FEE75C" ? "#000" : "#fff"}
              />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// Styles
const bS = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 3,
    paddingHorizontal: 12,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" }, // ✅ Critical for right alignment
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
