// src/screens/VoiceCallScreen.tsx
//
// Voice call screen — connects to the auth-free /ws endpoint.
// Uses session_id (passed as prop from TeamYPNScreen) so conversation
// history is shared between text and voice within the same session.
//
// WS protocol (matches main.py):
//   SEND:    { type:"init", session_id }
//            { type:"audio", data:"<base64 PCM 16kHz mono int16>" }
//            { type:"text",  message:"..." }
//            { type:"interrupt" }
//            { type:"end_call" }
//   RECEIVE: { type:"ready",      session_id }
//            { type:"partial",    text }
//            { type:"transcript", text }
//            { type:"thinking" }
//            { type:"ai_token",   text }
//            { type:"done" }
//            { type:"error",      message }

import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import AudioRecord from "react-native-audio-record";
import { SafeAreaView } from "react-native-safe-area-context";
import Tts, { Voice } from "react-native-tts";

// ── Constants ─────────────────────────────────────────────────────────────────
const WS_URL =
  (process.env.EXPO_PUBLIC_AI_URL ?? "http://localhost:8000")
    .replace(/^https/, "wss")
    .replace(/^http/, "ws") + "/ws";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

interface Props {
  onClose: () => void;
  sessionId: string; // shared with text chat for unified history
}

export default function VoiceCallScreen({ onClose, sessionId }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [liveText, setLiveText] = useState("");
  const [aiReply, setAiReply] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const aiBufferRef = useRef("");
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // ── TTS init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        Tts.setDefaultRate(0.95);
        Tts.setDefaultPitch(1.0);
        Tts.setDuck(true);
        const all: Voice[] = await Tts.getVoices();
        const en = all.filter((v) => v.language?.startsWith("en"));
        if (en.length) {
          setVoices(en);
          const def = en.find((v) => v.name.includes("Google")) ?? en[0];
          setSelectedVoiceId(def.id);
          await Tts.setDefaultVoice(def.id);
        }
      } catch (e) {
        console.warn("[VoiceCall] TTS init:", e);
      }
    })();

    return () => {
      disconnect();
      Tts.stop();
    };
  }, []);

  // ── Pulse animation for mic ring ───────────────────────────────────────────
  useEffect(() => {
    if (phase === "listening" || phase === "speaking") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1.0,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
    pulseAnim.setValue(1);
  }, [phase]);

  // ── Connect ────────────────────────────────────────────────────────────────
  const connect = () => {
    setPhase("connecting");
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;

    ws.onopen = () => {
      // Send init with shared session_id — no auth token needed
      ws.send(JSON.stringify({ type: "init", session_id: sessionId }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        switch (msg.type) {
          case "ready":
            setPhase("listening");
            startMic();
            break;

          case "partial":
            setLiveText(msg.text ?? "");
            break;

          case "transcript":
            setLiveText(msg.text ?? "");
            break;

          case "thinking":
            setPhase("thinking");
            break;

          case "ai_token":
            setPhase("speaking");
            aiBufferRef.current += msg.text ?? "";
            setAiReply(aiBufferRef.current);
            scrollRef.current?.scrollToEnd({ animated: true });
            break;

          case "done": {
            const full = aiBufferRef.current.trim();
            aiBufferRef.current = "";
            setAiReply("");
            setLiveText("");
            if (full) {
              Tts.stop();
              Tts.speak(full);
            }
            setPhase("listening");
            break;
          }

          case "error":
            console.warn("[VoiceCall] Server error:", msg.message);
            setPhase("idle");
            break;
        }
      } catch (e) {
        console.warn("[VoiceCall] Parse error:", e);
      }
    };

    ws.onerror = () => setPhase("idle");
    ws.onclose = () => {
      if (phase !== "idle") setPhase("idle");
    };
  };

  // ── Mic streaming (react-native-audio-record) ──────────────────────────────
  const startMic = () => {
    if (intervalRef.current) return;

    AudioRecord.init({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // VOICE_COMMUNICATION
      wavFile: "stream.wav",
    });
    AudioRecord.start();

    // Poll every 30ms — matches Vosk FRAME_DURATION_MS
    intervalRef.current = setInterval(() => {
      const data = (AudioRecord as any).fetch?.();
      if (data && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "audio", data }));
      }
    }, 30);
  };

  const stopMic = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    try {
      AudioRecord.stop();
    } catch (_) {}
  };

  // ── Disconnect ─────────────────────────────────────────────────────────────
  const disconnect = () => {
    stopMic();
    if (socketRef.current) {
      if (socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "end_call" }));
      }
      socketRef.current.close();
      socketRef.current = null;
    }
    aiBufferRef.current = "";
    setLiveText("");
    setAiReply("");
    setPhase("idle");
    Tts.stop();
  };

  // ── Interrupt (barge-in) ───────────────────────────────────────────────────
  const interrupt = () => {
    Tts.stop();
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
    aiBufferRef.current = "";
    setAiReply("");
    setPhase("listening");
  };

  const toggleMic = () => {
    if (phase === "idle") {
      connect();
    } else {
      disconnect();
    }
  };

  const phaseLabel: Record<Phase, string> = {
    idle: "Tap mic to start",
    connecting: "Connecting…",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
  };

  return (
    <View style={styles.container}>
      <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} />

      <SafeAreaView style={styles.header}>
        <TouchableOpacity onPress={onClose}>
          <Ionicons name="chevron-down" size={28} color="#fff" />
        </TouchableOpacity>
        <View style={{ alignItems: "center" }}>
          <Text style={styles.title}>YPN Voice</Text>
          <Text style={styles.status}>{phaseLabel[phase]}</Text>
        </View>
        <TouchableOpacity onPress={() => setSettingsOpen(true)}>
          <Ionicons name="settings-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </SafeAreaView>

      {/* Transcript area */}
      <ScrollView ref={scrollRef} style={styles.chat}>
        {!!liveText && <Text style={styles.userText}>{liveText}</Text>}
        {!!aiReply && <Text style={styles.aiText}>{aiReply}</Text>}
        {phase === "thinking" && (
          <ActivityIndicator color="#1DB954" style={{ marginTop: 8 }} />
        )}
      </ScrollView>

      {/* Controls */}
      <View style={styles.controls}>
        {/* Barge-in button — visible while AI is speaking */}
        {phase === "speaking" && (
          <TouchableOpacity style={styles.interruptBtn} onPress={interrupt}>
            <Ionicons name="stop-circle-outline" size={28} color="#fff" />
          </TouchableOpacity>
        )}

        <Animated.View
          style={[styles.ring, { transform: [{ scale: pulseAnim }] }]}
        />
        <TouchableOpacity
          onPress={toggleMic}
          style={[styles.mic, phase !== "idle" && styles.micActive]}
        >
          {phase === "connecting" ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Ionicons
              name={phase === "idle" ? "mic" : "stop"}
              size={32}
              color="#fff"
            />
          )}
        </TouchableOpacity>
      </View>

      {/* Voice settings modal */}
      <Modal visible={settingsOpen} transparent animationType="slide">
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Voice</Text>
          {voices.map((v) => (
            <TouchableOpacity
              key={v.id}
              style={[
                styles.voiceOpt,
                selectedVoiceId === v.id && styles.voiceOptActive,
              ]}
              onPress={() => {
                setSelectedVoiceId(v.id);
                Tts.setDefaultVoice(v.id);
              }}
            >
              <Text
                style={[
                  styles.voiceTxt,
                  selectedVoiceId === v.id && styles.voiceTxtActive,
                ]}
              >
                {v.name}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => setSettingsOpen(false)}
          >
            <Text style={styles.closeTxt}>Close</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0B141A" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 20,
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  status: { color: "#aaa", fontSize: 12, marginTop: 2 },

  chat: { flex: 1, padding: 20 },
  userText: {
    color: "#fff",
    alignSelf: "flex-end",
    marginBottom: 8,
    backgroundColor: "#005C4B",
    padding: 10,
    borderRadius: 12,
    maxWidth: "80%",
  },
  aiText: {
    color: "#000",
    alignSelf: "flex-start",
    marginBottom: 8,
    backgroundColor: "#1DB954",
    padding: 10,
    borderRadius: 12,
    maxWidth: "80%",
  },

  controls: { alignItems: "center", paddingBottom: 50 },
  ring: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(29,185,84,0.2)",
  },
  mic: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#333",
  },
  micActive: { backgroundColor: "#1DB954" },
  interruptBtn: {
    marginBottom: 16,
    padding: 12,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 30,
  },

  modal: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.85)",
    padding: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  modalTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
  },
  voiceOpt: { padding: 14, borderRadius: 10, marginBottom: 6 },
  voiceOptActive: { backgroundColor: "rgba(29,185,84,0.2)" },
  voiceTxt: { color: "#ccc", fontSize: 15 },
  voiceTxtActive: { color: "#1DB954", fontWeight: "600" },
  closeBtn: {
    marginTop: 16,
    padding: 14,
    backgroundColor: "#1DB954",
    borderRadius: 10,
    alignItems: "center",
  },
  closeTxt: { color: "#000", fontWeight: "700", fontSize: 16 },
});
