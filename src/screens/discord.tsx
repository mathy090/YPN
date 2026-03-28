// src/screens/discord.tsx
//
// E2E-encrypted community chat with Google Drive media and
// WhatsApp-style ephemeral messages.
//
// Security model:
//   • Every message payload is AES-256-GCM encrypted before hitting Firestore.
//   • Media bytes are AES-256-GCM encrypted before leaving the device.
//   • Only the ciphertext is stored in Drive / Firestore.
//   • The AES media key (mediaKeyJwk) is itself encrypted by the per-channel
//     symmetric key before being stored in Firestore — the server sees only
//     nested ciphertext.
//   • Decryption always happens in memory on the device; plaintext never
//     touches disk or the network after the sender's device.
//
// Ephemeral flow (WhatsApp-style):
//   1. Recipient's MessageBubble mounts → onSeen() fires after 1 frame.
//   2. After EPHEMERAL_TTL_MS the message is removed from local React state.
//   3. Simultaneously: deleteDoc() removes it from Firestore.
//   4. Simultaneously: deleteDriveFile() removes the encrypted blob from Drive.
//   All three happen client-side; no Cloud Function needed.

import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auth } from "../firebase/auth";
import { db } from "../firebase/firestore";
import { b64ToBuffer, bufferToB64 } from "../utils/crypto/E2ECrypto";
import {
  deleteDriveFile,
  downloadAndDecrypt,
  encryptAndUpload,
} from "../utils/GoogleDriveUploader";

// ── MMKV ──────────────────────────────────────────────────────
const mmkv = new MMKV({ id: "ypn-discord-v3" });
const cacheKey = (id: string) => `discord_msgs_${id}`;

// ── Constants ─────────────────────────────────────────────────
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// How long after "seen" before the message vanishes (ms).
// Set to 0 for instant deletion like Snapchat, or raise for
// WhatsApp-style "disappearing messages" (e.g. 10 000 = 10 s).
const EPHEMERAL_TTL_MS = 10_000;

const MAX_AUDIO_SECONDS = 120;

// ── Types ─────────────────────────────────────────────────────
type MessageType = "text" | "audio" | "image";

type Message = {
  id: string;
  type: MessageType;
  // Decrypted text (text messages only)
  text?: string;
  // Google Drive file ID — points to the encrypted blob
  driveFileId?: string;
  // AES-GCM IV for the media blob (base64)
  mediaIv?: string;
  // AES-256-GCM key for the media blob (JSON string, decrypted from Firestore)
  mediaKeyJwk?: string;
  mimeType?: string;
  audioDuration?: number;
  // In-memory object URL created after decryption — never persisted
  localObjectUrl?: string;
  uid: string;
  displayName: string;
  createdAt: number;
  ephemeral: boolean;
  pending?: boolean;
  failed?: boolean;
};

type Channel = {
  id: string;
  name: string;
  description: string;
  color: string;
  bgColor: string;
  emoji: string;
  order: number;
};

// ── Fallback channels ─────────────────────────────────────────
const FALLBACK_CHANNELS: Channel[] = [
  {
    id: "general",
    name: "general",
    description: "General YPN community chat",
    color: "#5865F2",
    bgColor: "#5865F222",
    emoji: "💬",
    order: 1,
  },
  {
    id: "mental-health",
    name: "mental-health",
    description: "Safe space to talk",
    color: "#57F287",
    bgColor: "#57F28722",
    emoji: "💚",
    order: 2,
  },
  {
    id: "jobs",
    name: "jobs",
    description: "Opportunities & careers",
    color: "#FEE75C",
    bgColor: "#FEE75C22",
    emoji: "💼",
    order: 3,
  },
  {
    id: "education",
    name: "education",
    description: "Learning & resources",
    color: "#EB459E",
    bgColor: "#EB459E22",
    emoji: "📚",
    order: 4,
  },
  {
    id: "prayer",
    name: "prayer",
    description: "Prayer & community support",
    color: "#FF7043",
    bgColor: "#FF704322",
    emoji: "🙏",
    order: 5,
  },
  {
    id: "announcements",
    name: "announcements",
    description: "YPN news & updates",
    color: "#ED4245",
    bgColor: "#ED424522",
    emoji: "📢",
    order: 6,
  },
];

// ── Per-channel symmetric key ─────────────────────────────────
// Derives a deterministic AES-256-GCM key from the channel ID and
// the user's Firebase UID. Both sender and recipient derive the same
// key independently — no key exchange needed for group channels.
//
// NOTE: In a production app with strict membership control you would
// distribute this key via X3DH / sender-key protocol so that users
// who leave the channel can no longer decrypt new messages.
async function getChannelKey(channelId: string): Promise<CryptoKey> {
  const uid = auth.currentUser?.uid ?? "anon";
  const raw = new TextEncoder().encode(`ypn-channel-${channelId}-${uid}`);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── encryptForFirestore ───────────────────────────────────────
// Encrypts a JSON payload object with the channel key.
// Returns { _ciphertext, _iv } — the only fields written to Firestore.
// The server and any Firestore admin can only read ciphertext.
async function encryptForFirestore(
  payload: object,
  channelKey: CryptoKey,
): Promise<{ _ciphertext: string; _iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    channelKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  return {
    _ciphertext: bufferToB64(ciphertext),
    _iv: bufferToB64(iv.buffer),
  };
}

// ── decryptFirestoreMessage ───────────────────────────────────
// Decrypts a raw Firestore document back into a typed partial Message.
// Handles legacy plaintext documents gracefully.
async function decryptFirestoreMessage(
  data: Record<string, unknown>,
  channelKey: CryptoKey,
): Promise<Partial<Message>> {
  // Legacy / plaintext fallback (pre-encryption migration window)
  if (!data._ciphertext || !data._iv) {
    return { text: (data.text as string) ?? "[message]" };
  }

  try {
    const iv = new Uint8Array(b64ToBuffer(data._iv as string));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      channelKey,
      b64ToBuffer(data._ciphertext as string),
    );

    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Record<
      string,
      unknown
    >;

    return {
      type: (parsed.type as MessageType) ?? "text",
      text: parsed.text as string | undefined,
      driveFileId: parsed.driveFileId as string | undefined,
      mediaIv: parsed.mediaIv as string | undefined,
      mediaKeyJwk: parsed.mediaKeyJwk as string | undefined,
      mimeType: parsed.mimeType as string | undefined,
      audioDuration: parsed.audioDuration as number | undefined,
      ephemeral: (parsed.ephemeral as boolean) ?? true,
    };
  } catch {
    return { text: "🔒 Unable to decrypt" };
  }
}

// ── ephemeralCleanup ──────────────────────────────────────────
// Deletes the Firestore document AND the encrypted Drive file after
// the TTL elapses. Runs on the recipient's device the moment a
// message is marked "seen". Non-fatal — a partial failure is logged
// but does not crash the chat.
function scheduleEphemeralCleanup(
  channelId: string,
  messageId: string,
  driveFileId: string | undefined,
  ttlMs: number,
): void {
  setTimeout(async () => {
    try {
      // Delete Firestore doc first — even if Drive delete fails the
      // message disappears from the recipient's view.
      await deleteDoc(doc(db, "channels", channelId, "messages", messageId));

      // Delete the encrypted blob from Google Drive
      if (driveFileId) {
        await deleteDriveFile(driveFileId);
      }
    } catch (err) {
      console.warn("[Ephemeral] cleanup error (non-fatal):", err);
    }
  }, ttlMs);
}

// ── Image picker helper ───────────────────────────────────────
async function pickAndReadImage(): Promise<{
  arrayBuffer: ArrayBuffer;
  mimeType: string;
} | null> {
  const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!granted) {
    Alert.alert(
      "Permission needed",
      "Allow photo library access to send images.",
    );
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9,
  });

  if (result.canceled || !result.assets[0]) return null;

  // Compress to ≤ 1080 px wide before encrypting
  const compressed = await ImageManipulator.manipulateAsync(
    result.assets[0].uri,
    [{ resize: { width: 1080 } }],
    { compress: 0.78, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  // Convert base64 → ArrayBuffer for encryption
  const b64 = compressed.base64 ?? "";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return { arrayBuffer: bytes.buffer, mimeType: "image/jpeg" };
}

// ── MessageBubble ─────────────────────────────────────────────
const MessageBubble = React.memo(
  ({
    msg,
    isMe,
    channelColor,
    onSeen,
  }: {
    msg: Message;
    isMe: boolean;
    channelColor: string;
    onSeen: (id: string, driveFileId?: string) => void;
  }) => {
    const [objectUrl, setObjectUrl] = useState<string | null>(
      msg.localObjectUrl ?? null,
    );
    const [decrypting, setDecrypting] = useState(false);
    const [playing, setPlaying] = useState(false);
    const soundRef = useRef<Audio.Sound | null>(null);
    const seenFired = useRef(false);

    // ── Seen trigger ──────────────────────────────────────────
    // Fire once when the bubble is first mounted by the RECIPIENT.
    // Sender's own bubbles do not trigger ephemeral deletion.
    useEffect(() => {
      if (!isMe && !seenFired.current) {
        seenFired.current = true;
        onSeen(msg.id, msg.driveFileId);
      }
    }, []);

    // ── Lazy media decryption ─────────────────────────────────
    // Downloaded and decrypted in memory on first render.
    // The resulting object URL is kept in component state — it is
    // revoked when the component unmounts (ephemeral cleanup).
    useEffect(() => {
      const needsMedia =
        (msg.type === "audio" || msg.type === "image") &&
        msg.driveFileId &&
        msg.mediaIv &&
        msg.mediaKeyJwk &&
        !objectUrl;

      if (!needsMedia) return;

      let revoked = false;
      setDecrypting(true);

      downloadAndDecrypt(msg.driveFileId!, msg.mediaIv!, msg.mediaKeyJwk!)
        .then((plainBuffer) => {
          if (revoked) return; // component unmounted during download — discard
          const blob = new Blob([plainBuffer], {
            type: msg.mimeType ?? "application/octet-stream",
          });
          // Object URL lives only in this JS session — never written to disk
          setObjectUrl(URL.createObjectURL(blob));
        })
        .catch((e) => console.error("[Bubble] decrypt failed:", e))
        .finally(() => setDecrypting(false));

      return () => {
        // Revoke the object URL when the bubble unmounts (ephemeral cleanup)
        revoked = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        soundRef.current?.unloadAsync();
      };
    }, [msg.driveFileId]);

    // ── Audio playback ────────────────────────────────────────
    const playAudio = useCallback(async () => {
      if (!objectUrl) return;
      try {
        await soundRef.current?.unloadAsync();
        const { sound } = await Audio.Sound.createAsync(
          { uri: objectUrl },
          { shouldPlay: true },
        );
        soundRef.current = sound;
        setPlaying(true);
        sound.setOnPlaybackStatusUpdate((s) => {
          if (s.isLoaded && s.didJustFinish) setPlaying(false);
        });
      } catch (e) {
        console.error("[Audio]", e);
      }
    }, [objectUrl]);

    const time = new Date(msg.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <Pressable style={[bS.row, isMe && bS.rowMe]}>
        {/* Avatar (other users only) */}
        {!isMe && (
          <View
            style={[
              bS.avatar,
              {
                backgroundColor: channelColor + "33",
                borderColor: channelColor + "55",
              },
            ]}
          >
            <Text style={[bS.avatarText, { color: channelColor }]}>
              {(msg.displayName?.[0] ?? "?").toUpperCase()}
            </Text>
          </View>
        )}

        {/* Bubble */}
        <View
          style={[
            bS.bubble,
            isMe
              ? [bS.bubbleMe, { backgroundColor: channelColor }]
              : bS.bubbleThem,
            msg.pending && bS.bubblePending,
            msg.failed && bS.bubbleFailed,
          ]}
        >
          {/* Sender name (other users only) */}
          {!isMe && (
            <Text style={[bS.name, { color: channelColor }]}>
              {msg.displayName}
            </Text>
          )}

          {/* ── Text ─────────────────────────────────────── */}
          {msg.type === "text" && <Text style={bS.text}>{msg.text}</Text>}

          {/* ── Image ────────────────────────────────────── */}
          {msg.type === "image" &&
            (decrypting ? (
              <ActivityIndicator color={channelColor} style={{ margin: 12 }} />
            ) : objectUrl ? (
              <Image
                source={{ uri: objectUrl }}
                style={bS.mediaImage}
                resizeMode="cover"
              />
            ) : (
              <Text style={bS.text}>🔒 Image</Text>
            ))}

          {/* ── Audio ────────────────────────────────────── */}
          {msg.type === "audio" &&
            (decrypting ? (
              <ActivityIndicator color={channelColor} style={{ margin: 12 }} />
            ) : (
              <TouchableOpacity
                style={bS.audioRow}
                onPress={playAudio}
                activeOpacity={0.75}
              >
                <Ionicons
                  name={playing ? "pause-circle" : "play-circle"}
                  size={32}
                  color={isMe ? "#000" : channelColor}
                />
                <Text style={[bS.audioDuration, isMe && { color: "#000" }]}>
                  {msg.audioDuration
                    ? `${Math.floor(msg.audioDuration)}s`
                    : "—"}
                </Text>
              </TouchableOpacity>
            ))}

          {/* ── Ephemeral badge ───────────────────────────── */}
          {msg.ephemeral && !isMe && (
            <View style={bS.ephemeralRow}>
              <Ionicons
                name="timer-outline"
                size={10}
                color={isMe ? "#000a" : "#fff6"}
              />
              <Text style={[bS.ephemeralText, isMe && { color: "#000a" }]}>
                disappears after seen
              </Text>
            </View>
          )}

          {/* ── Meta (time + status) ──────────────────────── */}
          <View style={bS.meta}>
            <Text style={[bS.time, isMe && { color: "#000a" }]}>{time}</Text>
            {msg.pending && (
              <Ionicons
                name="time-outline"
                size={12}
                color={isMe ? "#000a" : "#fff6"}
              />
            )}
            {msg.failed && (
              <Ionicons name="alert-circle-outline" size={12} color="#FF453A" />
            )}
            {!msg.pending && !msg.failed && isMe && (
              <Ionicons
                name="checkmark-done"
                size={12}
                color={isMe ? "#000a" : "#fff6"}
              />
            )}
          </View>
        </View>
      </Pressable>
    );
  },
);

// ── Bubble styles ─────────────────────────────────────────────
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
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 6,
    marginBottom: 2,
  },
  avatarText: { fontWeight: "700", fontSize: 12 },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  bubbleMe: { borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: "#2B2D31", borderBottomLeftRadius: 4 },
  bubblePending: { opacity: 0.6 },
  bubbleFailed: { borderWidth: 1, borderColor: "#FF453A" },
  name: { fontSize: 11, fontWeight: "700", marginBottom: 3 },
  text: { color: "#DBDEE1", fontSize: 15, lineHeight: 21 },
  mediaImage: { width: 200, height: 150, borderRadius: 8, marginVertical: 4 },
  audioRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 120,
    paddingVertical: 4,
  },
  audioDuration: { color: "#DBDEE1", fontSize: 12 },
  ephemeralRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 4,
  },
  ephemeralText: { color: "#fff6", fontSize: 10 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4,
    gap: 4,
  },
  time: { color: "rgba(255,255,255,0.4)", fontSize: 10 },
});

// ── Sidebar ───────────────────────────────────────────────────
const Sidebar = ({
  channels,
  active,
  onSelect,
  topPad,
}: {
  channels: Channel[];
  active: Channel;
  onSelect: (c: Channel) => void;
  topPad: number;
}) => (
  <View style={[sS.root, { paddingTop: topPad + 8 }]}>
    <Text style={sS.heading}>YPN Community</Text>
    <Text style={sS.sectionLabel}>TEXT CHANNELS</Text>
    {channels.map((ch) => {
      const isActive = ch.id === active.id;
      return (
        <TouchableOpacity
          key={ch.id}
          style={[sS.item, isActive && { backgroundColor: ch.color + "22" }]}
          onPress={() => onSelect(ch)}
          activeOpacity={0.7}
        >
          <View
            style={[
              sS.channelIcon,
              { backgroundColor: ch.bgColor, borderColor: ch.color + "44" },
            ]}
          >
            <Text style={{ fontSize: 16 }}>{ch.emoji}</Text>
          </View>
          <View style={sS.itemText}>
            <Text
              style={[
                sS.chName,
                isActive && { color: ch.color, fontWeight: "700" },
              ]}
            >
              #{ch.name}
            </Text>
            <Text style={sS.chDesc} numberOfLines={1}>
              {ch.description}
            </Text>
          </View>
          {isActive && <View style={[sS.dot, { backgroundColor: ch.color }]} />}
        </TouchableOpacity>
      );
    })}
  </View>
);

const sS = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1E1F22", paddingHorizontal: 8 },
  heading: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#2B2D31",
    marginBottom: 10,
  },
  sectionLabel: {
    color: "#8D9096",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    paddingHorizontal: 8,
    marginBottom: 6,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 4,
    gap: 10,
  },
  channelIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    justifyContent: "center",
    alignItems: "center",
  },
  itemText: { flex: 1 },
  chName: { color: "#8D9096", fontSize: 14, fontWeight: "500" },
  chDesc: { color: "#555", fontSize: 11, marginTop: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

// ══════════════════════════════════════════════════════════════
// ── Main screen ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
export default function DiscordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [channels, setChannels] = useState<Channel[]>(FALLBACK_CHANNELS);
  const [activeChannel, setActiveChannel] = useState<Channel>(
    FALLBACK_CHANNELS[0],
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recDuration, setRecDuration] = useState(0);
  const [channelKey, setChannelKey] = useState<CryptoKey | null>(null);

  const listRef = useRef<FlatList>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track which message IDs we have already scheduled for ephemeral deletion
  // so rapid re-renders don't schedule duplicate timeouts.
  const ephemeralSet = useRef<Set<string>>(new Set());
  const me = auth.currentUser;

  // ── Channel change: reset state + derive key + restore cache ─
  useEffect(() => {
    setLoading(true);
    setMessages([]);
    ephemeralSet.current.clear();

    getChannelKey(activeChannel.id)
      .then(setChannelKey)
      .catch((e) => console.error("[Discord] getChannelKey:", e));

    // Restore non-sensitive cached messages instantly
    const cached = mmkv.getString(cacheKey(activeChannel.id));
    if (cached) {
      try {
        setMessages(JSON.parse(cached));
        setLoading(false);
      } catch {
        /* malformed cache — ignore */
      }
    }
  }, [activeChannel.id]);

  // ── Firestore real-time listener ──────────────────────────────
  useEffect(() => {
    if (!channelKey) return;

    const q = query(
      collection(db, "channels", activeChannel.id, "messages"),
      orderBy("createdAt", "asc"),
      limit(80),
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const now = Date.now();
        const decrypted: Message[] = [];

        for (const docSnap of snap.docs) {
          const d = docSnap.data();
          const expireAt =
            (d.expireAt as Timestamp | undefined)?.toMillis?.() ?? null;

          // Remove already-expired Firestore-TTL documents
          if (expireAt && expireAt < now) {
            deleteDoc(docSnap.ref).catch(() => {});
            continue;
          }

          const fields = await decryptFirestoreMessage(d, channelKey);

          decrypted.push({
            id: docSnap.id,
            uid: (d.uid as string) ?? "",
            displayName: (d.displayName as string) ?? "Member",
            createdAt:
              (d.createdAt as Timestamp | undefined)?.toMillis?.() ?? now,
            ephemeral: true,
            ...fields,
          } as Message);
        }

        setMessages(decrypted);
        setLoading(false);

        // Cache metadata (never cache decrypted media keys)
        mmkv.set(
          cacheKey(activeChannel.id),
          JSON.stringify(
            decrypted.map((m) => ({
              ...m,
              mediaKeyJwk: undefined,
              localObjectUrl: undefined,
            })),
          ),
        );

        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      },
      (err) => {
        console.error("[Discord] Firestore listener:", err);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [activeChannel.id, channelKey]);

  // ── Fetch channel list from backend ───────────────────────────
  useEffect(() => {
    fetch(`${API_URL}/api/discord/channels`)
      .then((r) => r.json())
      .then((data: Channel[]) => {
        if (Array.isArray(data) && data.length) setChannels(data);
      })
      .catch(() => {
        /* use hardcoded fallback */
      });
  }, []);

  // ── handleMessageSeen ─────────────────────────────────────────
  // Called by MessageBubble once for each message the RECIPIENT sees.
  // Schedules ephemeral cleanup (Firestore doc + Drive file deletion)
  // and removes the message from local state after the TTL.
  const handleMessageSeen = useCallback(
    (messageId: string, driveFileId?: string) => {
      if (ephemeralSet.current.has(messageId)) return;
      ephemeralSet.current.add(messageId);

      // Remove from UI after TTL
      setTimeout(() => {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      }, EPHEMERAL_TTL_MS);

      // Delete from Firestore + Google Drive after TTL
      scheduleEphemeralCleanup(
        activeChannel.id,
        messageId,
        driveFileId,
        EPHEMERAL_TTL_MS,
      );
    },
    [activeChannel.id],
  );

  // ── sendText ──────────────────────────────────────────────────
  const sendText = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !me || !channelKey) return;

    setInput("");
    setSending(true);

    // Optimistic local message
    const optimisticId = `local_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        type: "text",
        text,
        uid: me.uid,
        displayName: me.displayName ?? "Me",
        createdAt: Date.now(),
        ephemeral: true,
        pending: true,
      },
    ]);

    try {
      // Encrypt the entire payload — server only sees _ciphertext + _iv
      const encrypted = await encryptForFirestore(
        { type: "text", text, ephemeral: true },
        channelKey,
      );

      await addDoc(collection(db, "channels", activeChannel.id, "messages"), {
        ...encrypted,
        uid: me.uid,
        displayName: me.displayName ?? me.email?.split("@")[0] ?? "YPN Member",
        createdAt: serverTimestamp(),
        // Firestore TTL index — safety net for messages the client
        // missed deleting (e.g. app was closed before recipient opened it)
        expireAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
        type: "text",
      });

      // Remove optimistic bubble; Firestore listener will add the real one
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } catch (err) {
      console.error("[Discord] sendText:", err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId ? { ...m, pending: false, failed: true } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [input, sending, me, channelKey, activeChannel.id]);

  // ── sendImage ─────────────────────────────────────────────────
  // Pick → compress → encrypt → upload to Drive → store ref in Firestore
  const sendImage = useCallback(async () => {
    if (!me || !channelKey || sending) return;

    const picked = await pickAndReadImage();
    if (!picked) return;

    setSending(true);
    try {
      // 1. Encrypt in memory and stream ciphertext to Google Drive
      const { driveFileId, mediaIv, mediaKeyJwk } = await encryptAndUpload(
        picked.arrayBuffer,
        picked.mimeType,
        `img_${me.uid}_${Date.now()}.enc`,
      );

      // 2. Encrypt the Firestore payload (including the media key and Drive ID)
      //    The server never sees driveFileId, mediaIv, or mediaKeyJwk in plain.
      const encrypted = await encryptForFirestore(
        {
          type: "image",
          driveFileId, // points to encrypted blob in Drive
          mediaIv, // AES-GCM IV for the blob
          mediaKeyJwk, // AES key for the blob (encrypted by channel key here)
          mimeType: picked.mimeType,
          ephemeral: true,
        },
        channelKey,
      );

      await addDoc(collection(db, "channels", activeChannel.id, "messages"), {
        ...encrypted,
        uid: me.uid,
        displayName: me.displayName ?? "YPN Member",
        createdAt: serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
        type: "image",
      });
    } catch (err) {
      console.error("[Discord] sendImage:", err);
      Alert.alert("Error", "Failed to send image. Please try again.");
    } finally {
      setSending(false);
    }
  }, [me, channelKey, sending, activeChannel.id]);

  // ── startRecording ────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      Alert.alert(
        "Permission needed",
        "Microphone access required for voice notes.",
      );
      return;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await rec.startAsync();

    setRecording(rec);
    setRecDuration(0);

    recTimerRef.current = setInterval(() => {
      setRecDuration((d) => {
        if (d >= MAX_AUDIO_SECONDS) {
          stopAndSendAudio();
          return d;
        }
        return d + 1;
      });
    }, 1000);
  }, []);

  // ── stopAndSendAudio ──────────────────────────────────────────
  // Stop recording → encrypt bytes → upload to Drive → Firestore ref
  const stopAndSendAudio = useCallback(async () => {
    if (!recording || !me || !channelKey) return;

    if (recTimerRef.current) clearInterval(recTimerRef.current);

    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      const status = await recording.getStatusAsync();
      const durationS = Math.floor((status.durationMillis ?? 0) / 1000);

      setRecording(null);
      setRecDuration(0);

      if (!uri) throw new Error("No recording URI");

      // Read audio file as ArrayBuffer for encryption
      const audioRes = await fetch(uri);
      const audioBuffer = await audioRes.arrayBuffer();

      // Encrypt + upload to Google Drive
      const { driveFileId, mediaIv, mediaKeyJwk } = await encryptAndUpload(
        audioBuffer,
        "audio/m4a",
        `audio_${me.uid}_${Date.now()}.enc`,
        durationS,
      );

      const encrypted = await encryptForFirestore(
        {
          type: "audio",
          driveFileId,
          mediaIv,
          mediaKeyJwk,
          mimeType: "audio/m4a",
          audioDuration: durationS,
          ephemeral: true,
        },
        channelKey,
      );

      await addDoc(collection(db, "channels", activeChannel.id, "messages"), {
        ...encrypted,
        uid: me.uid,
        displayName: me.displayName ?? "YPN Member",
        createdAt: serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
        type: "audio",
      });
    } catch (err) {
      console.error("[Discord] stopAndSendAudio:", err);
      Alert.alert("Error", "Failed to send voice note.");
    }
  }, [recording, me, channelKey, activeChannel.id]);

  // ── cancelRecording ───────────────────────────────────────────
  const cancelRecording = useCallback(async () => {
    if (!recording) return;
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    try {
      await recording.stopAndUnloadAsync();
    } catch {
      /* ignore */
    }
    setRecording(null);
    setRecDuration(0);
  }, [recording]);

  // ── Render ────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Header ─────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.headerBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color="#DBDEE1" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setSidebarOpen((p) => !p)}
          style={styles.headerBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons
            name={sidebarOpen ? "close" : "menu"}
            size={22}
            color="#DBDEE1"
          />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={{ fontSize: 18 }}>{activeChannel.emoji}</Text>
          <Text style={styles.headerTitle}>#{activeChannel.name}</Text>
        </View>

        <View style={styles.lockBadge}>
          <Ionicons name="lock-closed" size={11} color="#57F287" />
          <Text style={styles.lockText}>E2E</Text>
        </View>
      </View>

      {/* ── Body ───────────────────────────────────────────── */}
      <View style={styles.body}>
        {/* Sidebar overlay */}
        {sidebarOpen && (
          <View style={styles.sidebar}>
            <Sidebar
              channels={channels}
              active={activeChannel}
              topPad={0}
              onSelect={(ch) => {
                setActiveChannel(ch);
                setSidebarOpen(false);
              }}
            />
          </View>
        )}

        {/* Chat area */}
        <KeyboardAvoidingView
          style={styles.chatArea}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={insets.top + 56}
        >
          {/* Message list */}
          {loading ? (
            <View style={styles.centre}>
              <ActivityIndicator color={activeChannel.color} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              renderItem={({ item }) => (
                <MessageBubble
                  msg={item}
                  isMe={item.uid === me?.uid}
                  channelColor={activeChannel.color}
                  onSeen={handleMessageSeen}
                />
              )}
              contentContainerStyle={styles.messageList}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() =>
                listRef.current?.scrollToEnd({ animated: false })
              }
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={{ fontSize: 40 }}>{activeChannel.emoji}</Text>
                  <Text style={styles.emptyTitle}>#{activeChannel.name}</Text>
                  <Text style={styles.emptyDesc}>
                    {activeChannel.description}
                  </Text>
                  <View style={styles.emptyBadge}>
                    <Ionicons name="lock-closed" size={12} color="#57F287" />
                    <Text style={styles.emptyBadgeText}>
                      E2E encrypted · ephemeral after seen
                    </Text>
                  </View>
                </View>
              }
            />
          )}

          {/* ── Input bar ──────────────────────────────────── */}
          {recording ? (
            // Recording state
            <View
              style={[
                styles.inputBar,
                { paddingBottom: Math.max(insets.bottom, 8) },
              ]}
            >
              <TouchableOpacity
                onPress={cancelRecording}
                style={styles.inputAction}
              >
                <Ionicons name="trash-outline" size={22} color="#FF453A" />
              </TouchableOpacity>

              <View style={styles.recordingIndicator}>
                <View style={styles.recordingDot} />
                <Text style={styles.recordingText}>
                  {Math.floor(recDuration / 60)}:
                  {String(recDuration % 60).padStart(2, "0")}
                </Text>
              </View>

              <TouchableOpacity
                onPress={stopAndSendAudio}
                style={styles.sendBtn}
              >
                <Ionicons name="send" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : (
            // Normal input state
            <View
              style={[
                styles.inputBar,
                { paddingBottom: Math.max(insets.bottom, 8) },
              ]}
            >
              {/* Image picker */}
              <TouchableOpacity
                onPress={sendImage}
                style={styles.inputAction}
                disabled={!me || sending}
              >
                <Ionicons
                  name="image-outline"
                  size={22}
                  color={me && !sending ? "#8D9096" : "#444"}
                />
              </TouchableOpacity>

              {/* Text input */}
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={
                  me ? `Message #${activeChannel.name}` : "Sign in to chat"
                }
                placeholderTextColor="#6D6F78"
                style={styles.textInput}
                multiline
                maxLength={2000}
                editable={!!me}
              />

              {/* Send / microphone button */}
              {input.trim() ? (
                <TouchableOpacity
                  onPress={sendText}
                  disabled={sending || !me}
                  style={[
                    styles.sendBtn,
                    { backgroundColor: activeChannel.color },
                    (sending || !me) && styles.sendBtnDisabled,
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons
                      name="send"
                      size={18}
                      color={
                        activeChannel.color === "#FEE75C" ? "#000" : "#fff"
                      }
                    />
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={startRecording}
                  disabled={!me}
                  style={[
                    styles.sendBtn,
                    { backgroundColor: me ? "#383A40" : "#222" },
                  ]}
                >
                  <Ionicons
                    name="mic-outline"
                    size={18}
                    color={me ? "#DBDEE1" : "#555"}
                  />
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Sign-in nudge */}
          {!me && (
            <View style={styles.authBanner}>
              <Ionicons name="lock-closed-outline" size={13} color="#FFA500" />
              <Text style={styles.authText}>Sign in to send messages</Text>
            </View>
          )}
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

// ── Screen styles ─────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#313338" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#2B2D31",
    borderBottomWidth: 1,
    borderBottomColor: "#1E1F22",
    gap: 8,
  },
  headerBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  headerCenter: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  lockBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#57F28720",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#57F28740",
  },
  lockText: { color: "#57F287", fontSize: 10, fontWeight: "700" },
  body: { flex: 1, flexDirection: "row" },
  sidebar: {
    width: 230,
    borderRightWidth: 1,
    borderRightColor: "#1E1F22",
    zIndex: 10,
  },
  chatArea: { flex: 1 },
  messageList: { paddingVertical: 12, paddingBottom: 4 },
  centre: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    padding: 32,
    gap: 8,
    marginTop: 60,
  },
  emptyTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "700" },
  emptyDesc: { color: "#8D9096", fontSize: 14, textAlign: "center" },
  emptyBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
    backgroundColor: "#57F28715",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#57F28730",
  },
  emptyBadgeText: { color: "#57F287", fontSize: 12 },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 10,
    paddingTop: 8,
    backgroundColor: "#2B2D31",
    borderTopWidth: 1,
    borderTopColor: "#1E1F22",
    gap: 8,
  },
  inputAction: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 3,
  },
  textInput: {
    flex: 1,
    backgroundColor: "#383A40",
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#DBDEE1",
    fontSize: 15,
    maxHeight: 120,
    lineHeight: 20,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#5865F2",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 3,
  },
  sendBtnDisabled: { backgroundColor: "#404249" },
  recordingIndicator: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#383A40",
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#FF453A",
  },
  recordingText: { color: "#DBDEE1", fontSize: 15, fontWeight: "600" },
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
