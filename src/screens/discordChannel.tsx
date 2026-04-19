// src/screens/discordChannel.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
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
  removeFailedOptimistic,
  type CachedMessage,
} from "../utils/chatCache";
import {
  getChatProfile,
  getStoredUid,
  type ChatProfile,
} from "../utils/chatProfile";

const API_URL = process.env.EXPO_PUBLIC_API_URL;
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
const MAX_RETRIES = 3;

type Message = CachedMessage & { isMe: boolean; localId?: string };

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
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [chatProfile, setChatProfile] = useState<ChatProfile | null>(null);

  const listRef = useRef<FlatList>(null);
  const retryQueue = useRef<
    Map<string, { msg: CachedMessage; retries: number }>
  >(new Map());

  // Load profile by UID from SecureStore + MongoDB
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

  // Init SQLite DB & NetInfo listener
  useEffect(() => {
    const setup = async () => {
      await initChatDB();
      const unsubscribe = NetInfo.addEventListener((state) => {
        setIsOnline(!!state.isConnected);
        if (state.isConnected && retryQueue.current.size > 0) {
          processRetryQueue();
        }
      });
      return () => unsubscribe();
    };
    setup();
  }, []);

  // Load cached messages when channel changes
  useEffect(() => {
    if (!channelId) return;
    loadCachedMessages();
  }, [channelId]);

  const loadCachedMessages = async () => {
    try {
      const cached = await getCachedMessages(channelId);
      setMessages(
        cached.map((msg) => ({
          ...msg,
          isMe: msg.sender_id === chatProfile?.uid,
        })) as Message[],
      );
      setLoading(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      if (isOnline) fetchNewMessages();
    } catch (e) {
      console.warn("[Cache] Load failed:", e);
      setLoading(false);
    }
  };

  // 📡 WhatsApp-style incremental sync: only fetch NEW messages
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
        const unique = newMsgs.filter((m) => !ids.has(m.id));
        return [...prev, ...unique].slice(-200); // Keep last 200 in memory
      });

      await cacheMessages(channelId, newMsgs);
    } catch (e) {
      console.warn("[Sync] Fetch failed:", e);
    }
  };

  // 🔄 Pull-to-refresh: fetch OLDER messages
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

      setMessages((prev) => [...older, ...prev]);
      await cacheMessages(channelId, [...older, ...messages]);
    } catch (e) {
      console.warn("[Older fetch] Error:", e);
    }
  };

  // Auto-sync when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      fetchNewMessages();
    }, [channelId, isOnline]),
  );

  // Android hardware back button
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        router.replace("/tabs/discord");
        return true;
      };
      const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
      return () => sub.remove();
    }, [router]),
  );

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  // 📝 Send text message (uses profile from MongoDB via UID)
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
      avatar_url: chatProfile.avatarUrl,
      created_at: new Date().toISOString(),
      is_optimistic: 1,
      is_deleted_local: 0,
    };

    setInput("");
    setSending(true);

    // Show immediately (optimistic UI)
    await addOptimisticMessage(msg);
    setMessages((prev) => [...prev, { ...msg, isMe: true, localId }]);

    // Send to backend with retry logic
    await sendMessageWithRetry(msg, localId);
  };

  // 🔄 Retry logic with exponential backoff
  const sendMessageWithRetry = async (
    msg: CachedMessage,
    localId: string,
    attempt = 1,
  ) => {
    try {
      const res = await fetch(`${API_URL}/api/discord/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: msg.channel_id,
          username: msg.username,
          avatarUrl: msg.avatar_url,
          content: msg.content,
          mediaType: msg.media_type,
          mediaUrl: msg.media_url,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      const serverMsg = await res.json();

      // Update local DB with confirmed server ID
      await confirmMessage(serverMsg.id, localId);

      // Update UI: replace optimistic with confirmed
      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId || m.id === localId
            ? { ...serverMsg, isMe: true }
            : m,
        ),
      );

      setSending(false);
      retryQueue.current.delete(localId);
    } catch (e: any) {
      console.warn(`[Send] Attempt ${attempt} failed:`, e.message);

      // Retry if under limit and online
      if (attempt < MAX_RETRIES && isOnline) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        setTimeout(
          () => sendMessageWithRetry(msg, localId, attempt + 1),
          delay,
        );
        return;
      }

      // Queue for retry when back online
      retryQueue.current.set(localId, { msg, retries: attempt });

      setSending(false);

      // Show user-friendly error
      if (isOnline) {
        Alert.alert(
          "Send Failed",
          "Could not send message. Check your connection.",
          [
            {
              text: "Retry",
              onPress: () => sendMessageWithRetry(msg, localId, 1),
            },
            { text: "OK", style: "cancel" },
          ],
        );
      }
    }
  };

  // Process queued messages when back online
  const processRetryQueue = () => {
    for (const [localId, { msg }] of retryQueue.current) {
      sendMessageWithRetry(msg, localId, 1);
    }
  };

  // 📸 Pick and send media from gallery
  const pickAndSendMedia = async (type: "image" | "video") => {
    if (!channelId || !chatProfile) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes:
        type === "image"
          ? ImagePicker.MediaTypeOptions.Images
          : ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: false,
      quality: 0.8,
    });

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];

    // Enforce 30MB limit
    if (asset.fileSize && asset.fileSize > MAX_FILE_SIZE) {
      return Alert.alert("File Too Large", "Maximum file size is 30MB");
    }

    await uploadAndSendMedia(asset, type);
  };

  // Upload media to Supabase Storage, then send message
  const uploadAndSendMedia = async (
    asset: ImagePicker.ImageAsset,
    mediaType: "image" | "video" | "audio",
  ) => {
    if (!channelId || !chatProfile) return;

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msg: CachedMessage = {
      id: localId,
      channel_id: channelId,
      sender_id: chatProfile.uid,
      content: null,
      media_type: mediaType,
      media_url: asset.uri, // Temporary local URI
      username: chatProfile.username,
      avatar_url: chatProfile.avatarUrl,
      created_at: new Date().toISOString(),
      is_optimistic: 1,
      is_deleted_local: 0,
    };

    setSending(true);
    await addOptimisticMessage(msg);
    setMessages((prev) => [...prev, { ...msg, isMe: true, localId }]);

    try {
      // Upload file to backend (which pushes to Supabase Storage)
      const formData = new FormData();
      formData.append("file", {
        uri: asset.uri,
        name: asset.fileName || `file.${asset.uri.split(".").pop()}`,
        type: asset.mimeType || "application/octet-stream",
      } as any);

      const uploadRes = await fetch(`${API_URL}/api/discord/upload-media`, {
        method: "POST",
        body: formData,
        headers: { "Content-Type": "multipart/form-data" },
      });

      if (!uploadRes.ok) throw new Error("Upload failed");

      const { url, type } = await uploadRes.json();

      // Send message with uploaded media URL
      await sendMessageWithRetry(
        { ...msg, media_url: url, media_type: type },
        localId,
      );
    } catch (e: any) {
      console.error("[Media] Upload/send error:", e);
      setSending(false);

      // Remove failed optimistic message
      setMessages((prev) =>
        prev.filter((m) => m.localId !== localId && m.id !== localId),
      );
      await removeFailedOptimistic(localId);

      Alert.alert(
        "Upload Failed",
        e.message || "Could not send media. Try again.",
      );
    }
  };

  // 🎤 Start voice recording
  const startRecording = async () => {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        return Alert.alert(
          "Permission Required",
          "Allow microphone access to record voice notes",
        );
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );

      setRecording(recording);
      setIsRecording(true);
    } catch (e) {
      console.error("[Record] Start error:", e);
      Alert.alert("Error", "Could not start recording");
    }
  };

  // 🎤 Stop recording and send
  const stopRecording = async () => {
    if (!recording) return;

    try {
      setIsRecording(false);
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      if (!uri) throw new Error("No recording URI");

      // Check file size
      const info = await FileSystem.getInfoAsync(uri);
      if (info.size && info.size > MAX_FILE_SIZE) {
        return Alert.alert(
          "Recording Too Long",
          "Maximum recording size is 30MB",
        );
      }

      await uploadAndSendMedia(
        {
          uri,
          mimeType: "audio/aac",
          fileName: `voice-${Date.now()}.aac`,
        } as any,
        "audio",
      );
    } catch (e: any) {
      console.error("[Record] Stop error:", e);
      Alert.alert("Error", e.message || "Could not process recording");
    } finally {
      setRecording(null);
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    }
  };

  // 🗑️ Long-press delete handler
  const handleLongPress = (msg: Message) => {
    Alert.alert("Message Options", "Delete this message?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            // Delete from backend
            await fetch(`${API_URL}/api/discord/messages/${msg.id}`, {
              method: "DELETE",
            });

            // Remove from UI and local cache
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
            await deleteMessageLocally(msg.id);
          } catch {
            Alert.alert("Error", "Could not delete message");
          }
        },
      },
    ]);
  };

  // 🎨 Render individual message with avatar
  const renderMessage = ({ item }: { item: Message }) => {
    const time = new Date(item.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const showAvatar = !item.isMe && item.avatar_url;

    return (
      <TouchableOpacity
        style={[bS.row, item.isMe && bS.rowMe]}
        onLongPress={() => handleLongPress(item)}
        delayLongPress={300}
        activeOpacity={0.9}
      >
        {/* Avatar for other users */}
        {showAvatar ? (
          <Image
            source={{ uri: item.avatar_url }}
            style={bS.avatar}
            resizeMode="cover"
            onError={() =>
              console.warn("[Avatar] Load failed:", item.avatar_url)
            }
          />
        ) : !item.isMe ? (
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
        ) : null}

        <View
          style={[
            bS.bubble,
            item.isMe
              ? [bS.bubbleMe, { backgroundColor: color }]
              : bS.bubbleThem,
          ]}
        >
          {/* Username for other users */}
          {!item.isMe && item.username && (
            <Text style={[bS.senderName, { color }]}>{item.username}</Text>
          )}

          {/* Text content */}
          {item.content && (
            <Text
              style={[
                bS.text,
                item.isMe && color === "#FEE75C" && { color: "#000" },
              ]}
            >
              {item.content}
            </Text>
          )}

          {/* Image media */}
          {item.media_type === "image" && item.media_url && (
            <Image
              source={{ uri: item.media_url }}
              style={bS.mediaImage}
              resizeMode="cover"
              onError={() =>
                console.warn("[Media] Image load failed:", item.media_url)
              }
            />
          )}

          {/* Video placeholder */}
          {item.media_type === "video" && item.media_url && (
            <View style={bS.mediaPlaceholder}>
              <Ionicons name="videocam" size={24} color="#fff" />
              <Text style={bS.mediaText}>Video Attachment</Text>
            </View>
          )}

          {/* Audio placeholder */}
          {item.media_type === "audio" && item.media_url && (
            <View style={bS.audioPlayer}>
              <Ionicons name="play-circle" size={20} color="#fff" />
              <Text style={bS.mediaText}>Voice Note</Text>
            </View>
          )}

          {/* Sending indicator for optimistic messages */}
          {item.is_optimistic === 1 && (
            <View style={bS.statusRow}>
              <ActivityIndicator size="small" color="#fff8" />
              <Text style={bS.sendingText}>Sending...</Text>
            </View>
          )}

          {/* Timestamp */}
          <Text
            style={[
              bS.time,
              item.isMe && { color: color === "#FEE75C" ? "#0008" : "#fff8" },
            ]}
          >
            {time}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // Show loading state while fetching profile
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
        </View>
        <View style={s.centre}>
          <ActivityIndicator color={color} size="large" />
          <Text style={{ color: "#888", marginTop: 12 }}>
            Loading profile...
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
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
        {/* Message List */}
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

        {/* Input Bar */}
        <View
          style={[s.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
        >
          {/* Media buttons */}
          <View style={s.mediaButtons}>
            <TouchableOpacity
              onPress={() => pickAndSendMedia("image")}
              disabled={sending || !chatProfile}
              style={s.mediaBtn}
            >
              <Ionicons name="image-outline" size={22} color="#888" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => pickAndSendMedia("video")}
              disabled={sending || !chatProfile}
              style={s.mediaBtn}
            >
              <Ionicons name="videocam-outline" size={22} color="#888" />
            </TouchableOpacity>
          </View>

          {/* Text input */}
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
          />

          {/* Send/Record button */}
          <TouchableOpacity
            onPress={
              isRecording
                ? stopRecording
                : input.trim()
                  ? sendTextMessage
                  : startRecording
            }
            disabled={sending || !chatProfile}
            style={[
              s.sendBtn,
              { backgroundColor: color },
              (sending || !chatProfile) && s.sendBtnOff,
              isRecording && { backgroundColor: "#ED4245" },
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : isRecording ? (
              <Ionicons name="stop" size={20} color="#fff" />
            ) : input.trim() ? (
              <Ionicons
                name="send"
                size={18}
                color={color === "#FEE75C" ? "#000" : "#fff"}
              />
            ) : (
              <Ionicons
                name="mic-outline"
                size={20}
                color={color === "#FEE75C" ? "#000" : "#fff"}
              />
            )}
          </TouchableOpacity>
        </View>

        {/* Recording indicator modal */}
        <Modal visible={isRecording} transparent animationType="fade">
          <View style={s.recordModal}>
            <View style={s.recordContent}>
              <View style={s.pulseCircle} />
              <Text style={s.recordText}>Recording... Tap to stop</Text>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </View>
  );
}

// Message bubble styles
const bS = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 3,
    paddingHorizontal: 12,
    alignItems: "flex-end",
  },
  rowMe: { flexDirection: "row-reverse" },

  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: 6,
    marginBottom: 2,
    flexShrink: 0,
  },
  avatarPlaceholder: {
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    fontWeight: "700",
    fontSize: 12,
  },

  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#161616", borderBottomLeftRadius: 4 },

  senderName: {
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 3,
  },
  text: {
    color: "#fff",
    fontSize: 15,
    lineHeight: 21,
  },
  time: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 10,
    marginTop: 4,
    textAlign: "right",
  },

  mediaImage: {
    width: 200,
    height: 150,
    borderRadius: 8,
    marginTop: 5,
  },
  mediaPlaceholder: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 5,
    padding: 8,
    backgroundColor: "#0003",
    borderRadius: 6,
  },
  mediaText: {
    color: "#fff",
    fontSize: 13,
  },
  audioPlayer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 5,
    padding: 8,
    backgroundColor: "#0003",
    borderRadius: 6,
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  sendingText: {
    color: "#fff8",
    fontSize: 10,
  },
});

// Screen styles
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },

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
  headerEmoji: {
    fontSize: 22,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  headerDesc: {
    color: "#444",
    fontSize: 12,
    marginTop: 1,
  },

  offlineBadge: {
    backgroundColor: "#ED4245",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  offlineText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },

  centre: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  list: {
    paddingVertical: 12,
    paddingBottom: 8,
  },

  empty: {
    alignItems: "center",
    padding: 40,
    gap: 10,
    marginTop: 60,
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
  },
  emptyHint: {
    color: "#333",
    fontSize: 13,
    marginTop: 6,
  },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 10,
    paddingTop: 8,
    backgroundColor: "#0D0D0D",
    borderTopWidth: 1,
    borderTopColor: "#111",
    gap: 8,
  },

  mediaButtons: {
    flexDirection: "column",
    gap: 4,
    marginRight: 4,
  },
  mediaBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#161616",
  },

  textInput: {
    flex: 1,
    backgroundColor: "#161616",
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#fff",
    fontSize: 15,
    maxHeight: 120,
    lineHeight: 20,
  },

  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 2,
  },
  sendBtnOff: {
    backgroundColor: "#1A1A1A",
  },

  recordModal: {
    flex: 1,
    backgroundColor: "#0008",
    justifyContent: "center",
    alignItems: "center",
  },
  recordContent: {
    backgroundColor: "#1a1a1a",
    padding: 20,
    borderRadius: 16,
    alignItems: "center",
    gap: 12,
  },
  pulseCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#ED4245",
  },
  recordText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
});
