// src/screens/discordChannel.tsx
import { Ionicons } from "@expo/vector-icons";
import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Audio, ResizeMode, Video } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Dimensions,
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
const MAX_RETRIES = 3;
const SCREEN_WIDTH = Dimensions.get("window").width;

type Message = CachedMessage & { localId?: string; failed?: boolean };

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

  const [previewAsset, setPreviewAsset] =
    useState<ImagePicker.ImagePickerAsset | null>(null);
  const [viewingMedia, setViewingMedia] = useState<{
    uri: string;
    type: string;
  } | null>(null);

  // ✅ Audio recording state
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);

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
      setMessages(cached);
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
        const unique = newMsgs.filter((m) => !ids.has(m.id));
        return [...prev, ...unique].slice(-200);
      });
      await cacheMessages(channelId, newMsgs);
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
      setMessages((prev) => [...older, ...prev]);
      await cacheMessages(channelId, [...older, ...messages]);
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

  // 📝 Send text (only called when text exists)
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
    await addOptimisticMessage(msg);
    setMessages((prev) => [...prev, { ...msg, localId, failed: false }]);
    await sendMessageWithRetry(msg, localId);
  };

  // 🔄 Send/Upload with manual retry only (no auto-retry)
  const sendMessageWithRetry = async (msg: CachedMessage, localId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/discord/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: msg.channel_id,
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
            ? { ...serverMsg, localId: undefined }
            : m,
        ),
      );
      setSending(false);
    } catch (e: any) {
      setSending(false);
      // ✅ Mark as failed - user must tap to retry (no auto-retry)
      setMessages((prev) =>
        prev.map((m) =>
          m.localId === localId || m.id === localId
            ? { ...m, failed: true }
            : m,
        ),
      );
    }
  };

  // 📸 Media Picker
  const pickMedia = async (type: "image" | "video") => {
    const mediaType = type === "image" ? "images" : "videos";
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: mediaType as any,
      quality: 0.8,
    });
    if (!result.canceled && result.assets?.[0]) {
      setPreviewAsset(result.assets[0]);
    }
  };

  // ✅ Confirm & Upload Media
  const confirmSendMedia = async () => {
    if (!previewAsset || !chatProfile || !channelId) return;
    const asset = previewAsset;
    const mediaType = asset.mimeType?.startsWith("video") ? "video" : "image";

    setPreviewAsset(null);
    setSending(true);

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msg: CachedMessage = {
      id: localId,
      channel_id: channelId,
      sender_id: chatProfile.uid,
      content: null,
      media_type: mediaType,
      media_url: asset.uri,
      username: chatProfile.username,
      avatar_url: chatProfile.avatarUrl,
      created_at: new Date().toISOString(),
      is_optimistic: 1,
      is_deleted_local: 0,
    };

    setMessages((prev) => [...prev, { ...msg, localId, failed: false }]);
    await addOptimisticMessage(msg);

    try {
      const formData = new FormData();
      formData.append("file", {
        uri: asset.uri,
        name: asset.uri.split("/").pop() || `media.${mediaType}`,
        type:
          asset.mimeType ||
          (mediaType === "image" ? "image/jpeg" : "video/mp4"),
      } as any);

      const uploadRes = await fetch(`${API_URL}/api/discord/upload-media`, {
        method: "POST",
        body: formData,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => "Upload failed");
        console.error("[Media] Backend response:", uploadRes.status, errText);
        throw new Error(`Upload failed: ${uploadRes.status}`);
      }

      const { url, type } = await uploadRes.json();
      await sendMessageWithRetry(
        { ...msg, media_url: url, media_type: type },
        localId,
      );
    } catch (e: any) {
      console.error("[Media] Upload/send error:", e);
      setSending(false);
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

    if (
      msg.media_url?.startsWith("file:") ||
      msg.media_url?.startsWith("content:")
    ) {
      confirmSendMediaWithLocalAsset(msg);
    } else {
      sendMessageWithRetry(msg, msg.id || msg.localId!);
    }
  };

  // Helper to re-upload failed media
  const confirmSendMediaWithLocalAsset = async (msg: Message) => {
    if (!chatProfile || !channelId || !msg.media_url) return;
    const mediaType = msg.media_type === "video" ? "video" : "image";
    setSending(true);

    try {
      const formData = new FormData();
      formData.append("file", {
        uri: msg.media_url,
        name: msg.media_url.split("/").pop() || `media.${mediaType}`,
        type: mediaType === "video" ? "video/mp4" : "image/jpeg",
      } as any);

      const uploadRes = await fetch(`${API_URL}/api/discord/upload-media`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

      const { url, type } = await uploadRes.json();
      await sendMessageWithRetry(
        { ...msg, media_url: url, media_type: type },
        msg.id || msg.localId!,
      );
    } catch (e: any) {
      console.error("[Media] Retry upload error:", e);
      setSending(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id || m.localId === msg.id ? { ...m, failed: true } : m,
        ),
      );
    }
  };

  // 🎤 Start voice recording
  const startRecording = async () => {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert(
          "Permission Required",
          "Allow microphone access to record voice notes",
        );
        return;
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

      const info = await FileSystem.getInfoAsync(uri);
      if (info.size && info.size > 30 * 1024 * 1024) {
        Alert.alert("Recording Too Long", "Maximum recording size is 30MB");
        return;
      }

      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const msg: CachedMessage = {
        id: localId,
        channel_id: channelId,
        sender_id: chatProfile.uid,
        content: null,
        media_type: "audio",
        media_url: uri,
        username: chatProfile.username,
        avatar_url: chatProfile.avatarUrl,
        created_at: new Date().toISOString(),
        is_optimistic: 1,
        is_deleted_local: 0,
      };

      setSending(true);
      await addOptimisticMessage(msg);
      setMessages((prev) => [...prev, { ...msg, localId, failed: false }]);

      const formData = new FormData();
      formData.append("file", {
        uri,
        name: `voice_${Date.now()}.aac`,
        type: "audio/aac",
      } as any);

      const uploadRes = await fetch(`${API_URL}/api/discord/upload-media`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

      const { url, type } = await uploadRes.json();
      await sendMessageWithRetry(
        { ...msg, media_url: url, media_type: type },
        localId,
      );
    } catch (e: any) {
      console.error("[Record] Stop error:", e);
      setSending(false);
      Alert.alert("Error", e.message || "Could not process recording");
    } finally {
      setRecording(null);
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    }
  };

  // 🗑️ Delete
  const handleLongPress = (msg: Message) => {
    if (msg.id?.startsWith("local-") || msg.localId?.startsWith("local-")) {
      const idToRemove = msg.id || msg.localId;
      setMessages((prev) =>
        prev.filter((m) => m.id !== idToRemove && m.localId !== idToRemove),
      );
      removeFailedOptimistic(idToRemove);
      return;
    }
    Alert.alert("Delete?", "Delete this message?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await fetch(`${API_URL}/api/discord/messages/${msg.id}`, {
              method: "DELETE",
            });
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
            await deleteMessageLocally(msg.id);
          } catch {
            Alert.alert("Error", "Could not delete");
          }
        },
      },
    ]);
  };

  // 🎨 Render Message
  const renderMessage = ({ item }: { item: Message }) => {
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
        {!isMe && (
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
        )}
        <View
          style={[
            bS.bubble,
            isMe ? [bS.bubbleMe, { backgroundColor: color }] : bS.bubbleThem,
          ]}
        >
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

          {/* Image Card */}
          {item.media_type === "image" && item.media_url && (
            <TouchableOpacity
              onPress={() =>
                setViewingMedia({ uri: item.media_url, type: "image" })
              }
              activeOpacity={0.9}
            >
              <Image
                source={{ uri: item.media_url }}
                style={bS.mediaCard}
                resizeMode="cover"
              />
            </TouchableOpacity>
          )}

          {/* Video Card */}
          {item.media_type === "video" && item.media_url && (
            <TouchableOpacity
              onPress={() =>
                setViewingMedia({ uri: item.media_url, type: "video" })
              }
              activeOpacity={0.9}
              style={bS.videoCardWrap}
            >
              <Video
                source={{ uri: item.media_url }}
                style={bS.mediaCard}
                resizeMode={ResizeMode.COVER}
                useNativeControls={false}
                isMuted
              />
              <View style={bS.playOverlay}>
                <Ionicons name="play" size={32} color="#fff" />
              </View>
            </TouchableOpacity>
          )}

          {/* Audio Card */}
          {item.media_type === "audio" && item.media_url && (
            <View style={bS.audioCard}>
              <Ionicons name="waveform" size={24} color="#fff" />
              <Text style={bS.audioText}>Voice Note</Text>
            </View>
          )}

          {/* Sending indicator */}
          {item.is_optimistic === 1 && !item.failed && (
            <View style={bS.statusRow}>
              <ActivityIndicator size="small" color="#fff8" />
              <Text style={bS.sendingText}>Sending...</Text>
            </View>
          )}

          {/* Failed indicator (Red tap-to-retry) */}
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

  // 🖼️ Full Screen Media Viewer
  const renderMediaViewer = () => {
    if (!viewingMedia) return null;
    return (
      <Modal visible={!!viewingMedia} transparent animationType="fade">
        <View style={s.viewerOverlay}>
          <TouchableOpacity
            style={s.viewerClose}
            onPress={() => setViewingMedia(null)}
          >
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          {viewingMedia.type === "video" ? (
            <Video
              source={{ uri: viewingMedia.uri }}
              style={s.viewerMedia}
              resizeMode={ResizeMode.CONTAIN}
              useNativeControls
              shouldPlay
            />
          ) : (
            <Image
              source={{ uri: viewingMedia.uri }}
              style={s.viewerMedia}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>
    );
  };

  // 📸 WhatsApp-Style Preview Modal
  const renderPreviewModal = () => {
    if (!previewAsset) return null;
    const isVideo = previewAsset.mimeType?.startsWith("video");
    return (
      <Modal visible={!!previewAsset} transparent animationType="slide">
        <View style={s.previewOverlay}>
          <View style={s.previewHeader}>
            <TouchableOpacity
              onPress={() => setPreviewAsset(null)}
              style={s.previewBtn}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={s.previewTitle}>Preview</Text>
            <View style={{ width: 24 }} />
          </View>
          <View style={s.previewContent}>
            {isVideo ? (
              <Video
                source={{ uri: previewAsset.uri }}
                style={s.previewMedia}
                resizeMode={ResizeMode.CONTAIN}
                useNativeControls
                shouldPlay
              />
            ) : (
              <Image
                source={{ uri: previewAsset.uri }}
                style={s.previewMedia}
                resizeMode="contain"
              />
            )}
          </View>
          <View style={s.previewFooter}>
            <TouchableOpacity
              style={[s.previewAction, { backgroundColor: "#333" }]}
              onPress={() => setPreviewAsset(null)}
            >
              <Text style={s.previewActionText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.previewAction, { backgroundColor: color }]}
              onPress={confirmSendMedia}
            >
              <Ionicons
                name="send"
                size={20}
                color="#fff"
                style={{ marginRight: 6 }}
              />
              <Text style={s.previewActionText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
          <TouchableOpacity
            onPress={() => pickMedia("image")}
            disabled={sending || !chatProfile}
            style={s.attachBtn}
          >
            <Ionicons name="image-outline" size={24} color="#888" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => pickMedia("video")}
            disabled={sending || !chatProfile}
            style={s.attachBtn}
          >
            <Ionicons name="videocam-outline" size={24} color="#888" />
          </TouchableOpacity>
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

          {/* ✅ Facebook/iOS Style: Alternating Send/Mic Button */}
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
              { backgroundColor: isRecording ? "#ED4245" : color },
              (sending || !chatProfile) && s.sendBtnOff,
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
      </KeyboardAvoidingView>

      {renderPreviewModal()}
      {renderMediaViewer()}

      {/* 🎤 Recording Indicator Modal */}
      <Modal visible={isRecording} transparent animationType="fade">
        <View style={s.recordModal}>
          <View style={s.recordContent}>
            <View style={s.pulseCircle} />
            <Text style={s.recordText}>Recording... Tap to stop</Text>
          </View>
        </View>
      </Modal>
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
  rowMe: { flexDirection: "row-reverse" },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginRight: 6,
    marginBottom: 2,
    flexShrink: 0,
  },
  avatarPlaceholder: { justifyContent: "center", alignItems: "center" },
  avatarText: { fontWeight: "700", fontSize: 12 },
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
  mediaCard: {
    width: SCREEN_WIDTH * 0.65,
    height: SCREEN_WIDTH * 0.5,
    borderRadius: 12,
    marginTop: 6,
  },
  videoCardWrap: {
    width: SCREEN_WIDTH * 0.65,
    height: SCREEN_WIDTH * 0.5,
    borderRadius: 12,
    marginTop: 6,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  playOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  audioCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    padding: 10,
    backgroundColor: "rgba(0,0,0,0.2)",
    borderRadius: 8,
  },
  audioText: { color: "#fff", fontSize: 13, fontWeight: "500" },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  sendingText: { color: "#fff8", fontSize: 10 },
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
  attachBtn: { padding: 8 },
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

  // Preview Modal
  previewOverlay: { flex: 1, backgroundColor: "#000" },
  previewHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  previewTitle: { color: "#fff", fontSize: 18, fontWeight: "600" },
  previewBtn: { padding: 8 },
  previewContent: { flex: 1, justifyContent: "center", alignItems: "center" },
  previewMedia: { width: "100%", height: "70%" },
  previewFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
    gap: 12,
  },
  previewAction: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 12,
  },
  previewActionText: { color: "#fff", fontWeight: "600", fontSize: 16 },

  // Viewer
  viewerOverlay: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  viewerClose: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  viewerMedia: { width: SCREEN_WIDTH, height: SCREEN_WIDTH },

  // Recording Modal
  recordModal: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
    justifyContent: "center",
    alignItems: "center",
  },
  recordContent: {
    backgroundColor: "#1a1a1a",
    padding: 24,
    borderRadius: 16,
    alignItems: "center",
    gap: 16,
  },
  pulseCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#ED4245",
  },
  recordText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
