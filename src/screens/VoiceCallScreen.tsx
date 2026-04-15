// app/voice/VoiceCallScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { clearToken, getToken } from "../../src/utils/tokenManager";

const API_BASE = process.env.EXPO_PUBLIC_AI_URL || "http://localhost:8000";
const WS_URL = `${API_BASE.replace("http", "ws")}/ws`;

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export default function VoiceCallScreen({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [liveText, setLiveText] = useState("");
  const [aiReply, setAiReply] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const aiBufferRef = useRef("");

  useEffect(() => {
    initTTS();
    return () => {
      disconnect();
      Tts.stop();
    };
  }, []);

  const initTTS = async () => {
    try {
      Tts.setDefaultRate(0.95);
      Tts.setDefaultPitch(1.0);
      Tts.setDuck(true);

      const voices = await Tts.getVoices();
      const englishVoices = voices.filter((v) => v.language?.includes("en"));

      if (englishVoices.length > 0) {
        setAvailableVoices(englishVoices);
        const defaultVoice =
          englishVoices.find((v) => v.name.includes("Google")) ||
          englishVoices[0];

        setSelectedVoiceId(defaultVoice.id);
        await Tts.setDefaultVoice(defaultVoice.id);
      }
    } catch {}
  };

  const connect = async () => {
    setPhase("connecting");
    try {
      // 🔥 1. Load Firebase ID Token from SecureStore
      const token = await getToken();
      if (!token) throw new Error("NO_TOKEN");

      const ws = new WebSocket(WS_URL);
      socketRef.current = ws;

      ws.onopen = () => {
        // 🔥 2. Send auth immediately on connection
        ws.send(JSON.stringify({ type: "auth", token }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // 🔥 3. Handle Auth Verification
          if (
            msg.type === "auth_success" ||
            (msg.type === "ready" && phase === "connecting")
          ) {
            setPhase("listening");
            startStreaming();
            return;
          }

          if (msg.type === "auth_error" || msg.status === 401) {
            handleAuthFailure("Session expired. Please log in again.");
            return;
          }

          // 🔥 4. Handle Live Transcription & AI Responses
          if (msg.type === "transcript_partial" || msg.type === "partial") {
            setLiveText(msg.text || "");
          }

          if (msg.type === "mode" || msg.type === "state") {
            const state = msg.state || msg.value;
            if (state === "thinking") setPhase("thinking");
            if (state === "speaking") setPhase("speaking");
            if (state === "listening") {
              setPhase("listening");
              setLiveText("");
            }
          }

          if (msg.type === "ai_chunk" || msg.type === "ai_token") {
            aiBufferRef.current += msg.text;
            setAiReply(aiBufferRef.current);
          }

          if (msg.type === "ai_done" || msg.type === "done") {
            const fullReply = aiBufferRef.current.trim();
            aiBufferRef.current = "";
            setAiReply("");

            // 🔥 5. Trigger TTS when AI finishes responding
            if (fullReply) {
              Tts.stop();
              Tts.speak(fullReply);
            }
          }
        } catch (e) {
          console.warn("WS Parse Error", e);
        }
      };

      ws.onerror = () => setPhase("idle");
      ws.onclose = () => setPhase("idle");
    } catch (err: any) {
      if (err.message === "NO_TOKEN") {
        handleAuthFailure("Please log in to use voice features.");
      } else {
        handleAuthFailure("Connection failed. Check your network.");
      }
    }
  };

  // 🔥 Auth failure handler
  const handleAuthFailure = (message: string) => {
    clearToken();
    disconnect();
    Alert.alert("Authentication Required", message, [
      {
        text: "Log In",
        onPress: () => {
          onClose();
          router.replace("/auth/otp");
        },
      },
      { text: "Cancel", style: "cancel", onPress: onClose },
    ]);
  };

  const startStreaming = () => {
    if (intervalRef.current) return; // Prevent double-start

    const options = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // VOICE_COMMUNICATION
      wavFile: "stream.wav",
    };

    AudioRecord.init(options);
    AudioRecord.start();

    intervalRef.current = setInterval(() => {
      const data = AudioRecord.fetch?.();
      if (data && socketRef.current?.readyState === WebSocket.OPEN) {
        // Send raw binary for lower latency & RAM usage
        socketRef.current.send(data);
      }
    }, 120);
  };

  const disconnect = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    AudioRecord.stop();
    socketRef.current?.close();
    socketRef.current = null;
    aiBufferRef.current = "";
    setLiveText("");
    setAiReply("");
    setPhase("idle");
    Tts.stop();
  };

  const toggleMic = () => {
    if (phase === "idle") connect();
    else disconnect();
  };

  const pulseAnim = useRef(new Animated.Value(1)).current;

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
            toValue: 1,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [phase]);

  return (
    <View style={styles.container}>
      <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} />

      <SafeAreaView style={styles.header}>
        <TouchableOpacity onPress={onClose}>
          <Ionicons name="chevron-down" size={28} color="#fff" />
        </TouchableOpacity>

        <View style={{ alignItems: "center" }}>
          <Text style={styles.title}>YPN Voice</Text>
          <Text style={styles.status}>{phase}</Text>
        </View>

        <TouchableOpacity onPress={() => setIsSettingsOpen(true)}>
          <Ionicons name="settings-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </SafeAreaView>

      <ScrollView
        ref={scrollRef}
        style={styles.chat}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: true })
        }
      >
        {liveText ? <Text style={styles.userText}>{liveText}</Text> : null}
        {aiReply ? <Text style={styles.aiText}>{aiReply}</Text> : null}
        {phase === "thinking" && (
          <ActivityIndicator color="#1DB954" style={{ marginTop: 8 }} />
        )}
      </ScrollView>

      <View style={styles.controls}>
        <Animated.View
          style={[styles.ring, { transform: [{ scale: pulseAnim }] }]}
        />
        <TouchableOpacity
          onPress={toggleMic}
          style={[styles.mic, phase !== "idle" && styles.micActive]}
        >
          <Ionicons
            name={phase === "idle" ? "mic" : "stop"}
            size={32}
            color="#fff"
          />
        </TouchableOpacity>
      </View>

      <Modal visible={isSettingsOpen} transparent animationType="slide">
        <View style={styles.modal}>
          <Text style={{ color: "#fff", fontSize: 18, marginBottom: 12 }}>
            Voice Settings
          </Text>
          {availableVoices.map((voice) => (
            <TouchableOpacity
              key={voice.id}
              style={[
                styles.voiceOption,
                selectedVoiceId === voice.id && styles.voiceOptionActive,
              ]}
              onPress={() => {
                setSelectedVoiceId(voice.id);
                Tts.setDefaultVoice(voice.id);
              }}
            >
              <Text
                style={[
                  styles.voiceText,
                  selectedVoiceId === voice.id && styles.voiceTextActive,
                ]}
              >
                {voice.name}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => setIsSettingsOpen(false)}
          >
            <Text style={styles.closeText}>Close</Text>
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
  status: { color: "#aaa", fontSize: 12 },
  chat: { flex: 1, padding: 20 },
  userText: { color: "#fff", alignSelf: "flex-end", marginBottom: 8 },
  aiText: { color: "#1DB954", alignSelf: "flex-start", marginBottom: 8 },
  controls: { alignItems: "center", paddingBottom: 40 },
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
  modal: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.85)",
    padding: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  voiceOption: { padding: 14, borderRadius: 10, marginBottom: 6 },
  voiceOptionActive: { backgroundColor: "rgba(29,185,84,0.2)" },
  voiceText: { color: "#ccc", fontSize: 15 },
  voiceTextActive: { color: "#1DB954", fontWeight: "600" },
  closeBtn: {
    marginTop: 16,
    padding: 14,
    backgroundColor: "#1DB954",
    borderRadius: 10,
    alignItems: "center",
  },
  closeText: { color: "#000", fontWeight: "700", fontSize: 16 },
});
