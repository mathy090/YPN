// src/screens/VoiceCall.tsx
// Meta AI-style voice call screen.
// Flow: tap mic → record → send to /voice → play mp3 response → idle
//
// States: idle | recording | processing | speaking | error
// Two-layer cache: L1 in-memory Map (10 min) + AsyncStorage (session)

import { Ionicons } from "@expo/vector-icons";
import { Audio, AVPlaybackStatus } from "expo-av";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Config ────────────────────────────────────────────────────────────────────
const AI_URL = process.env.EXPO_PUBLIC_AI_URL ?? "";
const SESSION_KEY = "voice_session_id";
const CACHE_KEY = "voice_l1_cache"; // AsyncStorage key for L2
const L1_TTL_MS = 10 * 60 * 1000; // 10 min

// ── Types ─────────────────────────────────────────────────────────────────────
type ScreenState = "idle" | "recording" | "processing" | "speaking" | "error";

type CacheEntry = {
  reply: string;
  transcript: string;
  ts: number;
};

// ── In-memory L1 cache ────────────────────────────────────────────────────────
const _memCache = new Map<string, CacheEntry>();

function memCacheGet(transcript: string): CacheEntry | null {
  const entry = _memCache.get(transcript.toLowerCase().trim());
  if (!entry) return null;
  if (Date.now() - entry.ts > L1_TTL_MS) {
    _memCache.delete(transcript.toLowerCase().trim());
    return null;
  }
  return entry;
}

function memCacheSet(transcript: string, entry: CacheEntry): void {
  if (_memCache.size > 100) {
    // evict oldest
    const oldest = [..._memCache.entries()].sort(
      (a, b) => a[1].ts - b[1].ts,
    )[0];
    if (oldest) _memCache.delete(oldest[0]);
  }
  _memCache.set(transcript.toLowerCase().trim(), entry);
}

// ── AsyncStorage L2 cache ─────────────────────────────────────────────────────
async function l2Get(transcript: string): Promise<CacheEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const store: Record<string, CacheEntry> = JSON.parse(raw);
    const entry = store[transcript.toLowerCase().trim()];
    if (!entry) return null;
    if (Date.now() - entry.ts > L1_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

async function l2Set(transcript: string, entry: CacheEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const store: Record<string, CacheEntry> = raw ? JSON.parse(raw) : {};
    // keep max 50 entries
    const keys = Object.keys(store);
    if (keys.length >= 50) {
      const oldest = keys.sort((a, b) => store[a].ts - store[b].ts)[0];
      delete store[oldest];
    }
    store[transcript.toLowerCase().trim()] = entry;
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function VoiceCallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [state, setState] = useState<ScreenState>("idle");
  const [transcript, setTranscript] = useState("");
  const [replyText, setReplyText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [sessionId, setSessionId] = useState("default");

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  // ── Session ID (persisted) ────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(SESSION_KEY).then((sid) => {
      if (sid) {
        setSessionId(sid);
      } else {
        const newSid = `voice_${Date.now()}`;
        setSessionId(newSid);
        AsyncStorage.setItem(SESSION_KEY, newSid);
      }
    });
    return () => {
      stopPulse();
      cleanupSound();
    };
  }, []);

  // ── Pulse animation ───────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.25,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.current.start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseLoop.current?.stop();
    pulseAnim.setValue(1);
  }, [pulseAnim]);

  // ── Audio permissions ─────────────────────────────────────────────────────
  const requestPermissions = async (): Promise<boolean> => {
    const { granted } = await Audio.requestPermissionsAsync();
    return granted;
  };

  // ── Cleanup sound ─────────────────────────────────────────────────────────
  const cleanupSound = async () => {
    if (soundRef.current) {
      try {
        await soundRef.current.unloadAsync();
      } catch {}
      soundRef.current = null;
    }
  };

  // ── Start recording ───────────────────────────────────────────────────────
  const startRecording = async () => {
    const allowed = await requestPermissions();
    if (!allowed) {
      setErrorMsg("Microphone permission denied");
      setState("error");
      return;
    }

    await cleanupSound();
    setTranscript("");
    setReplyText("");
    setErrorMsg("");

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      setState("recording");
      startPulse();
    } catch (e) {
      setErrorMsg("Could not start recording");
      setState("error");
    }
  };

  // ── Stop recording + send ─────────────────────────────────────────────────
  const stopAndSend = async () => {
    stopPulse();
    if (!recordingRef.current) return;

    setState("processing");

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (!uri) throw new Error("No recording URI");

      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

      // Build multipart form
      const formData = new FormData();
      formData.append("file", {
        uri,
        name: "voice.m4a",
        type: "audio/m4a",
      } as any);
      formData.append("session_id", sessionId);

      const res = await fetch(`${AI_URL}/voice`, {
        method: "POST",
        body: formData,
        headers: { Accept: "audio/mpeg" },
      });

      if (!res.ok) {
        let errMsg = "Voice processing failed";
        try {
          const body = await res.json();
          errMsg = body?.detail?.message ?? errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      // Read response headers for display
      const userSaid = decodeURIComponent(
        res.headers.get("X-Transcript") ?? "",
      );
      const aiSaid = decodeURIComponent(res.headers.get("X-Reply-Text") ?? "");

      setTranscript(userSaid);
      setReplyText(aiSaid);

      // L1 memory cache
      if (userSaid && aiSaid) {
        const entry: CacheEntry = {
          reply: aiSaid,
          transcript: userSaid,
          ts: Date.now(),
        };
        memCacheSet(userSaid, entry);
        l2Set(userSaid, entry); // async, non-blocking
      }

      // Get audio bytes and play
      const audioBytes = await res.arrayBuffer();
      const base64Audio = _arrayBufferToBase64(audioBytes);
      const audioUri = `data:audio/mpeg;base64,${base64Audio}`;

      await cleanupSound();
      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUri },
        { shouldPlay: true, volume: 1.0 },
        _onPlaybackStatus,
      );
      soundRef.current = sound;
      setState("speaking");
    } catch (e: any) {
      console.warn("[VoiceCall] error:", e);
      setErrorMsg(e?.message ?? "Something went wrong. Please try again.");
      setState("error");
    }
  };

  // ── Playback status ───────────────────────────────────────────────────────
  const _onPlaybackStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    if (status.didJustFinish) {
      setState("idle");
      cleanupSound();
    }
  }, []);

  // ── Stop speaking ─────────────────────────────────────────────────────────
  const stopSpeaking = async () => {
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
      } catch {}
      await cleanupSound();
    }
    setState("idle");
  };

  // ── Mic button press ──────────────────────────────────────────────────────
  const onMicPress = () => {
    if (state === "idle" || state === "error") startRecording();
    else if (state === "recording") stopAndSend();
    else if (state === "speaking") stopSpeaking();
  };

  // ── UI helpers ────────────────────────────────────────────────────────────
  const micIcon: Record<ScreenState, keyof typeof Ionicons.glyphMap> = {
    idle: "mic",
    recording: "stop",
    processing: "hourglass",
    speaking: "volume-high",
    error: "mic",
  };

  const statusLabel: Record<ScreenState, string> = {
    idle: "Tap to speak",
    recording: "Listening… tap to send",
    processing: "Processing…",
    speaking: "Speaking… tap to stop",
    error: "Tap to try again",
  };

  const micBg =
    state === "recording"
      ? "#E91429"
      : state === "speaking"
        ? "#1DB954"
        : state === "error"
          ? "#333"
          : "#1DB954";

  return (
    <View
      style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-down" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>YPN AI Voice</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Centre display */}
      <View style={s.centre}>
        {/* Transcript bubble */}
        {transcript.length > 0 && (
          <View style={s.bubble}>
            <Text style={s.bubbleLabel}>You said</Text>
            <Text style={s.bubbleText}>{transcript}</Text>
          </View>
        )}

        {/* AI reply bubble */}
        {replyText.length > 0 && (
          <View style={[s.bubble, s.bubbleAI]}>
            <Text style={[s.bubbleLabel, { color: "#1DB954" }]}>YPN AI</Text>
            <Text style={s.bubbleText}>{replyText}</Text>
          </View>
        )}

        {/* Error */}
        {state === "error" && errorMsg.length > 0 && (
          <View style={s.errorBox}>
            <Ionicons name="alert-circle-outline" size={18} color="#E91429" />
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        )}
      </View>

      {/* Status label */}
      <Text style={s.statusLabel}>{statusLabel[state]}</Text>

      {/* Mic button */}
      <View style={s.micWrap}>
        {/* Pulse ring — only while recording */}
        {state === "recording" && (
          <Animated.View
            style={[s.pulseRing, { transform: [{ scale: pulseAnim }] }]}
          />
        )}

        <TouchableOpacity
          onPress={onMicPress}
          disabled={state === "processing"}
          activeOpacity={0.85}
          style={[s.micBtn, { backgroundColor: micBg }]}
        >
          {state === "processing" ? (
            <ActivityIndicator size="large" color="#fff" />
          ) : (
            <Ionicons name={micIcon[state]} size={36} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Base64 helper (no external dep) ──────────────────────────────────────────
function _arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
  },
  header: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#111",
  },
  backBtn: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "600",
  },
  centre: {
    flex: 1,
    width: "100%",
    paddingHorizontal: 24,
    paddingTop: 32,
    gap: 16,
  },
  bubble: {
    backgroundColor: "#111",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#222",
  },
  bubbleAI: {
    borderColor: "#1DB95430",
    backgroundColor: "#0a1a0f",
  },
  bubbleLabel: {
    color: "#555",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  bubbleText: {
    color: "#E8E8E8",
    fontSize: 16,
    lineHeight: 24,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1a0000",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E9142930",
  },
  errorText: {
    color: "#E91429",
    fontSize: 14,
    flex: 1,
  },
  statusLabel: {
    color: "#555",
    fontSize: 14,
    marginBottom: 24,
    fontWeight: "500",
  },
  micWrap: {
    width: 120,
    height: 120,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 40,
  },
  pulseRing: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(233,20,41,0.15)",
    borderWidth: 2,
    borderColor: "rgba(233,20,41,0.4)",
  },
  micBtn: {
    width: 90,
    height: 90,
    borderRadius: 45,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#1DB954",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
  },
});
