// src/screens/discordChannel.tsx
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";
import {
  cacheDiscordMessages,
  CachedMessage,
  getCachedDiscordMessages,
} from "../utils/cache";

type Message = {
  id: string;
  text: string;
  uid: string;
  displayName: string;
  createdAt: number;
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
  const me = auth.currentUser;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList>(null);

  // Ensure tab bar is visible on this screen
  useLayoutEffect(() => {
    navigation.setOptions({ tabBarStyle: undefined });
  }, [navigation]);

  // Android back button: navigate to Discord main page
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        router.replace("/tabs/discord");
        return true;
      };
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        onBackPress,
      );
      return () => subscription.remove();
    }, [router]),
  );

  // Load cached messages on mount
  useEffect(() => {
    if (!channelId) return;

    (async () => {
      const cached = await getCachedDiscordMessages(channelId);
      if (cached && cached.length > 0) {
        setMessages(cached as Message[]);
        setLoading(false);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      }
    })();
  }, [channelId]);

  useEffect(() => {
    if (!channelId) return;

    const q = query(
      collection(db, "channels", channelId, "messages"),
      orderBy("createdAt", "asc"),
      limit(100),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const msgs: Message[] = snap.docs.map((d) => ({
          id: d.id,
          text: (d.data().text as string) ?? "",
          uid: (d.data().uid as string) ?? "",
          displayName: (d.data().displayName as string) ?? "YPN Member",
          createdAt: d.data().createdAt?.toMillis?.() ?? Date.now(),
        }));
        setMessages(msgs);
        setLoading(false);
        cacheDiscordMessages(channelId, msgs as CachedMessage[]).catch((e) =>
          console.warn("Failed to cache Discord messages:", e),
        );
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
      },
      (err) => {
        console.error("[DiscordChannel] listener:", err.message);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [channelId]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending || !me || !channelId) return;

    setInput("");
    setSending(true);

    try {
      await addDoc(collection(db, "channels", channelId, "messages"), {
        text,
        uid: me.uid,
        displayName: me.displayName ?? me.email?.split("@")[0] ?? "YPN Member",
        createdAt: serverTimestamp(),
      });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (e) {
      console.error("[DiscordChannel] send:", e);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isMe = item.uid === me?.uid;
    const time = new Date(item.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <View style={[bS.row, isMe && bS.rowMe]}>
        {!isMe && (
          <View style={[bS.avatar, { backgroundColor: color + "33" }]}>
            <Text style={[bS.avatarText, { color }]}>
              {(item.displayName[0] ?? "?").toUpperCase()}
            </Text>
          </View>
        )}
        <View
          style={[
            bS.bubble,
            isMe ? [bS.bubbleMe, { backgroundColor: color }] : bS.bubbleThem,
          ]}
        >
          {!isMe && (
            <Text style={[bS.senderName, { color }]}>{item.displayName}</Text>
          )}
          <Text
            style={[bS.text, isMe && color === "#FEE75C" && { color: "#000" }]}
          >
            {item.text}
          </Text>
          <Text
            style={[
              bS.time,
              isMe && { color: color === "#FEE75C" ? "#0008" : "#fff8" },
            ]}
          >
            {time}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => router.replace("/tabs/discord")}
          style={s.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
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

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 56 : 0}
      >
        {loading ? (
          <View style={s.centre}>
            <ActivityIndicator color={color} size="large" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderMessage}
            contentContainerStyle={s.list}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
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
            placeholder={me ? `Message #${channelName}` : "Sign in to chat"}
            placeholderTextColor="#444"
            style={s.textInput}
            multiline
            maxLength={2000}
            editable={!!me}
          />
          <TouchableOpacity
            onPress={send}
            disabled={!input.trim() || sending || !me}
            style={[
              s.sendBtn,
              { backgroundColor: color },
              (!input.trim() || sending || !me) && s.sendBtnOff,
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
    justifyContent: "center",
    alignItems: "center",
    marginRight: 6,
    marginBottom: 2,
    flexShrink: 0,
  },
  avatarText: { fontWeight: "700", fontSize: 12 },
  bubble: {
    maxWidth: "78%",
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
  centre: { flex: 1, justifyContent: "center", alignItems: "center" },
  list: { paddingVertical: 12, paddingBottom: 8 },
  empty: {
    alignItems: "center",
    padding: 40,
    gap: 10,
    marginTop: 60,
  },
  emptyTitle: { color: "#fff", fontSize: 20, fontWeight: "700" },
  emptyDesc: { color: "#555", fontSize: 14, textAlign: "center" },
  emptyHint: { color: "#333", fontSize: 13, marginTop: 6 },
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
  sendBtnOff: { backgroundColor: "#1A1A1A" },
  signInBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    backgroundColor: "#FFA50015",
  },
  signInText: { color: "#FFA500", fontSize: 12 },
});
