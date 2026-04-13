// src/screens/VoiceCallScreen.tsx
//
// REFACTORED FOR:
// 1. WAV 16kHz Mono recording (Optimized for Vosk)
// 2. Simultaneous Text Display + Native Speech (expo-speech)
// 3. Zero Server-Side TTS dependency (Ultra-light backend)

import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import { BlurView } from "expo-blur";
import * as Speech from "expo-speech";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── Config ─────────────────────────────────────────────────────────────────────
const AI_BASE_URL = process.env.EXPO_PUBLIC_AI_URL ?? "";
const VOICE_ENDPOINT = `${AI_BASE_URL}/voice`;
const CACHE_KEY = "ypn_voice_history_v1";
const MAX_CACHED = 30;

// ── Types ──────────────────────────────────────────────────────────────────────
type VoicePhase =
  | "idle"
  | "recording"
  | "listening"
  | "processing"
  | "thinking"
  | "replying";

type VoiceMessage = {
  id: string;
  transcript: string;
  reply: string;
  timestamp: number;
};

// ── Phase display config ───────────────────────────────────────────────────────
const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: "Tap mic to speak",
  recording: "Recording • tap arrow to send",
  listening: "Listening...",
  processing: "Processing your voice...",
  thinking: "Thinking...",
  replying: "Speaking...", // Updated label
};

const PHASE_COLOR: Record<VoicePhase, string> = {
  idle: "rgba(255,255,255,0.3)",
  recording: "#FF453A",
  listening: "#1DB954",
  processing: "#1DB954",
  thinking: "#1DB954",
  replying: "#1DB954",
};

// ── L1/L2 cache ────────────────────────────────────────────────────────────────
let _l1: VoiceMessage[] = [];

async function cacheLoad(): Promise<VoiceMessage[]> {
  if (_l1.length > 0) return _l1;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    _l1 = raw ? (JSON.parse(raw) as VoiceMessage[]) : [];
    return _l1;
  } catch {
    return [];
  }
}

async function cacheSave(msgs: VoiceMessage[]): Promise<void> {
  _l1 = msgs.slice(-MAX_CACHED);
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(_l1));
  } catch {}
}

// ── Animated pulse ring ────────────────────────────────────────────────────────
function usePulse(active: boolean) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const loop = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (active) {
      opacity.setValue(0.4);
      loop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.35,
            duration: 700,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 700,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.current.start();
    } else {
      loop.current?.stop();
      Animated.timing(scale, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
    return () => loop.current?.stop();
  }, [active]);

  return { scale, opacity };
}

// ── Dot loader ─────────────────────────────────────────────────────────────────
function DotLoader({ color = "#1DB954" }: { color?: string }) {
  const dots = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.3)).current,
  ];

  useEffect(() => {
    const loop = Animated.loop(
      Animated.stagger(
        180,
        dots.map((d) =>
          Animated.sequence([
            Animated.timing(d, {
              toValue: 1,
              duration: 250,
              useNativeDriver: true,
            }),
            Animated.timing(d, {
              toValue: 0.3,
              duration: 250,
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <View style={dl.row}>
      {dots.map((d, i) => (
        <Animated.View
          key={i}
          style={[dl.dot, { backgroundColor: color, opacity: d }]}
        />
      ))}
    </View>
  );
}

const dl = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
});

// ── Props ──────────────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void;
  sessionId?: string;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function VoiceCallScreen({
  onClose,
  sessionId = "voice_default",
}: Props) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [history, setHistory] = useState<VoiceMessage[]>([]);
  const [currentReply, setCurrentReply] = useState("");
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const recordingRef = useRef<Audio.Recording | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const mountedRef = useRef(true);

  const isRecording = phase === "recording";
  const isBusy = phase !== "idle" && phase !== "recording";
  const { scale: pulseScale, opacity: pulseOpacity } = usePulse(isRecording);

  // ── Mount/unmount ─────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    cacheLoad().then((cached) => {
      if (mountedRef.current) setHistory(cached);
    });

    return () => {
      mountedRef.current = false;
      // Stop speech immediately on unmount
      Speech.stop();
      cleanupRecording();
    };
  }, []);

  const cleanupRecording = async () => {
    try {
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync();
        recordingRef.current = null;
      }
    } catch {}
  };

  const safeSetPhase = (p: VoicePhase) => {
    if (mountedRef.current) setPhase(p);
  };

  // ── Start recording (OPTIMIZED FOR VOSK: WAV 16kHz Mono) ─────────────────
  const startRecording = useCallback(async () => {
    if (isBusy) return;
    setErrorMsg("");
    setCurrentReply("");
    setCurrentTranscript("");

    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== "granted") {
        setErrorMsg("Microphone permission denied.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      // CUSTOM PRESET: Force WAV 16kHz Mono for Vosk compatibility
      const { recording } = await Audio.Recording.createAsync({
        android: {
          extension: ".wav",
          outputFormat:
            Audio.AndroidOutputFormat.WAVEFORM_AUDIO_ENCODING_PCM_16BIT,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT, // PCM doesn't need encoder
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000, // Irrelevant for PCM but good practice
        },
        ios: {
          extension: ".wav",
          outputFormat: Audio.IOSOutputFormat.LINEAR_PCM,
          audioEncoder: Audio.IOSAudioEncoding.LINEAR_PCM,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000,
        },
      });

      recordingRef.current = recording;
      safeSetPhase("recording");
    } catch (e) {
      console.error(e);
      setErrorMsg("Could not start recording. Please try again.");
    }
  }, [isBusy]);

  // ── Stop + Send + SYNC REPLY ─────────────────────────────────────────────
  const stopAndSend = useCallback(async () => {
    if (phase !== "recording" || !recordingRef.current) return;

    safeSetPhase("listening");

    let uri: string | null = null;
    try {
      await recordingRef.current.stopAndUnloadAsync();
      uri = recordingRef.current.getURI() ?? null;
      recordingRef.current = null;
    } catch {
      setErrorMsg("Recording failed.");
      safeSetPhase("idle");
      return;
    }

    if (!uri) {
      setErrorMsg("No audio captured.");
      safeSetPhase("idle");
      return;
    }

    // Switch mode for playback (though expo-speech handles its own session usually)
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
    });

    safeSetPhase("processing");

    const formData = new FormData();
    formData.append("audio", {
      uri,
      name: "voice.wav", // Explicitly tell server it's WAV
      type: "audio/wav",
    } as any);
    formData.append("session_id", sessionId);

    safeSetPhase("thinking");

    let data: { transcript: string; reply: string; tts_url: string | null };

    try {
      const res = await fetch(VOICE_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        let detail = `Server error ${res.status}`;
        try {
          const body = await res.json();
          detail = body.detail ?? body.message ?? detail;
        } catch {}
        throw new Error(detail);
      }

      data = await res.json();
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Network error.");
      safeSetPhase("idle");
      return;
    }

    // 1. Show Transcript Immediately
    setCurrentTranscript(data.transcript);

    // 2. Prepare Reply
    safeSetPhase("replying");
    setCurrentReply(data.reply);

    // 3. SCROLL TO BOTTOM so user sees text appearing
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

    // 4. TRIGGER SPEECH IMMEDIATELY (Simultaneous with text display)
    // We ignore server tts_url because we removed server-side TTS for speed.
    // We rely 100% on expo-speech.
    try {
      await Speech.speak(data.reply, {
        language: "en-US",
        pitch: 1.0,
        rate: Platform.OS === "ios" ? 0.55 : 0.95, // Slightly slower for clarity
        onStart: () => {
          console.log("Speech started");
        },
        onDone: () => {
          console.log("Speech finished");
          // Optional: Auto-reset phase or keep it until user speaks
        },
        onError: (e) => {
          console.warn("Speech error:", e);
        },
      });
    } catch (e) {
      console.warn("Speech synthesis failed:", e);
    }

    // 5. Save to History
    const msg: VoiceMessage = {
      id: Date.now().toString(),
      transcript: data.transcript,
      reply: data.reply,
      timestamp: Date.now(),
    };

    const updated = [...history, msg];
    if (mountedRef.current) {
      setHistory(updated);
      // Clear current live view after a short delay to merge into history cleanly
      setTimeout(() => {
        if (mountedRef.current) {
          setCurrentReply("");
          setCurrentTranscript("");
        }
      }, 1000);
    }
    cacheSave(updated);

    safeSetPhase("idle");
  }, [phase, history, sessionId]);

  const handlePress = useCallback(() => {
    if (isBusy) return;
    if (phase === "idle") startRecording();
    else if (phase === "recording") stopAndSend();
  }, [phase, isBusy, startRecording, stopAndSend]);

  const STATUS_H =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;

  const btnIcon = phase === "recording" ? "arrow-up" : "mic";
  const btnBgColor =
    phase === "recording"
      ? "#1DB954"
      : isBusy
        ? "rgba(255,255,255,0.05)"
        : "rgba(255,255,255,0.1)";
  const btnBorderColor =
    phase === "recording"
      ? "#1DB954"
      : isBusy
        ? "rgba(29,185,84,0.2)"
        : "rgba(255,255,255,0.2)";

  const showDots = phase !== "idle" && phase !== "recording";

  return (
    <View style={[s.root, { paddingTop: STATUS_H }]}>
      <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={s.darken} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={onClose}
          style={s.closeBtn}
          activeOpacity={0.75}
        >
          <Ionicons
            name="chevron-down"
            size={26}
            color="rgba(255,255,255,0.8)"
          />
        </TouchableOpacity>
        <View style={s.headerMid}>
          <Image
            source={require("../../assets/images/YPN.png")}
            style={s.avatar}
          />
          <Text style={s.headerName}>Team YPN</Text>
          <Text style={s.headerSub}>AI Voice</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      {/* Conversation */}
      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {history.length === 0 && phase === "idle" && (
          <View style={s.emptyWrap}>
            <Ionicons
              name="mic-circle-outline"
              size={64}
              color="rgba(255,255,255,0.1)"
            />
            <Text style={s.emptyTitle}>Voice Assistant</Text>
            <Text style={s.emptySubtitle}>
              Tap the mic, speak clearly,{"\n"}then tap the arrow.
            </Text>
          </View>
        )}

        {history.map((item) => (
          <View key={item.id} style={s.msgPair}>
            <View style={s.userRow}>
              <View style={s.userBubble}>
                <View style={s.micLabel}>
                  <Ionicons
                    name="mic"
                    size={11}
                    color="rgba(255,255,255,0.55)"
                  />
                  <Text style={s.micLabelText}>You said</Text>
                </View>
                <Text style={s.userText}>{item.transcript}</Text>
              </View>
            </View>
            <View style={s.aiRow}>
              <View style={s.aiBubble}>
                <Text style={s.aiText}>{item.reply}</Text>
              </View>
            </View>
          </View>
        ))}

        {/* Live Exchange */}
        {currentTranscript !== "" && (
          <View style={s.userRow}>
            <View style={[s.userBubble, s.userBubbleLive]}>
              <View style={s.micLabel}>
                <Ionicons name="mic" size={11} color="rgba(255,255,255,0.55)" />
                <Text style={s.micLabelText}>You said</Text>
              </View>
              <Text style={s.userText}>{currentTranscript}</Text>
            </View>
          </View>
        )}

        {currentReply !== "" && (
          <View style={s.aiRow}>
            <View style={[s.aiBubble, s.aiBubbleLive]}>
              <Text style={s.aiText}>{currentReply}</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Status Bar */}
      <View style={s.statusBar}>
        {showDots && (
          <View style={s.statusRow}>
            <DotLoader color="#1DB954" />
            <Text style={[s.statusText, { color: PHASE_COLOR[phase] }]}>
              {PHASE_LABEL[phase]}
            </Text>
          </View>
        )}
        {phase === "recording" && (
          <View style={s.statusRow}>
            <RecDot />
            <Text style={[s.statusText, { color: "#FF453A" }]}>
              {PHASE_LABEL.recording}
            </Text>
          </View>
        )}
        {phase === "idle" && !errorMsg && (
          <Text style={s.statusIdle}>{PHASE_LABEL.idle}</Text>
        )}
        {errorMsg !== "" && <Text style={s.errorText}>{errorMsg}</Text>}
      </View>

      {/* Mic Button */}
      <View style={s.btnArea}>
        <Animated.View
          style={[
            s.pulseRing,
            { transform: [{ scale: pulseScale }], opacity: pulseOpacity },
          ]}
        />
        <TouchableOpacity
          onPress={handlePress}
          disabled={isBusy}
          activeOpacity={0.8}
          style={[
            s.micBtn,
            { backgroundColor: btnBgColor, borderColor: btnBorderColor },
          ]}
        >
          {isBusy ? (
            <ActivityIndicator size="large" color="#1DB954" />
          ) : (
            <Ionicons
              name={btnIcon}
              size={38}
              color={phase === "recording" ? "#000" : "#fff"}
            />
          )}
        </TouchableOpacity>
      </View>

      <View style={{ height: Platform.OS === "ios" ? 34 : 20 }} />
    </View>
  );
}

function RecDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.2,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={[rd.dot, { opacity }]} />;
}

const rd = StyleSheet.create({
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#FF453A" },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B141A" },
  darken: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(11,20,26,0.78)",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  closeBtn: {
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  headerMid: { alignItems: "center", gap: 5 },
  avatar: { width: 52, height: 52, borderRadius: 26 },
  headerName: { color: "#fff", fontSize: 17, fontWeight: "700" },
  headerSub: { color: "#8696A0", fontSize: 12 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
    flexGrow: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
    paddingVertical: 60,
  },
  emptyTitle: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 18,
    fontWeight: "600",
  },
  emptySubtitle: {
    color: "rgba(255,255,255,0.25)",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
  msgPair: { gap: 6, marginBottom: 8 },
  userRow: { flexDirection: "row", justifyContent: "flex-end" },
  userBubble: {
    backgroundColor: "#005C4B",
    borderRadius: 18,
    borderBottomRightRadius: 4,
    paddingHorizontal: 13,
    paddingVertical: 9,
    maxWidth: "82%",
    gap: 3,
  },
  userBubbleLive: { borderWidth: 1, borderColor: "rgba(29,185,84,0.4)" },
  micLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 2,
  },
  micLabelText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 10,
    fontWeight: "600",
  },
  userText: { color: "#E9EDEF", fontSize: 15, lineHeight: 21 },
  aiRow: { flexDirection: "row", justifyContent: "flex-start" },
  aiBubble: {
    backgroundColor: "#202C33",
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 13,
    paddingVertical: 9,
    maxWidth: "82%",
  },
  aiBubbleLive: { borderWidth: 1, borderColor: "rgba(29,185,84,0.3)" },
  aiText: { color: "#E9EDEF", fontSize: 15, lineHeight: 21 },
  statusBar: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 4,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusText: { fontSize: 15, fontWeight: "600" },
  statusIdle: { color: "rgba(255,255,255,0.28)", fontSize: 14 },
  errorText: {
    color: "#FF453A",
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 16,
  },
  btnArea: { alignItems: "center", justifyContent: "center", height: 150 },
  pulseRing: {
    position: "absolute",
    width: 144,
    height: 144,
    borderRadius: 72,
    backgroundColor: "#1DB954",
  },
  micBtn: {
    width: 96,
    height: 96,
    borderRadius: 48,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
  },
});
