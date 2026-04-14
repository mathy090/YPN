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
  View
} from "react-native";
import AudioRecord from "react-native-audio-record";
import { SafeAreaView } from "react-native-safe-area-context";
import Tts, { Voice } from "react-native-tts";

// ─ Config ─────────────────────────────────────────────────────────────────────
const WS_URL = `${process.env.EXPO_PUBLIC_AI_URL.replace("http", "ws")}/voice`;

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export default function VoiceCallScreen({ onClose }: { onClose: () => void }) {
  // State
  const [phase, setPhase] = useState<Phase>("idle");
  const [liveText, setLiveText] = useState(""); // Partial transcript
  const [aiReply, setAiReply] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>("");

  // Refs
  const socketRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<any>(null);
  const scrollRef = useRef<ScrollView>(null);

  // ─ Initialize TTS & Load Voices ───────────────────────────────────────────
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
      Tts.setDuck(true); // Lower other audio while speaking

      const voices = await Tts.getVoices();
      // Filter for English voices usually best quality offline
      const englishVoices = voices.filter((v) => v.language.includes("en"));

      if (englishVoices.length > 0) {
        setAvailableVoices(englishVoices);
        // Default to first Google voice if available
        const defaultVoice =
          englishVoices.find((v) => v.name.includes("Google")) ||
          englishVoices[0];
        setSelectedVoiceId(defaultVoice.id);
        await Tts.setDefaultVoice(defaultVoice.id);
      }
    } catch (e) {
      console.warn("TTS Init Error:", e);
    }
  };

  const changeVoice = async (voiceId: string) => {
    setSelectedVoiceId(voiceId);
    await Tts.setDefaultVoice(voiceId);
    // Optional: Speak a test sound
    // Tts.speak('Voice changed.');
  };

  // ── WebSocket Logic ────────────────────────────────────────────────────────
  const connect = () => {
    setPhase("connecting");
    socketRef.current = new WebSocket(WS_URL);

    socketRef.current.onopen = () => {
      console.log("✅ WS Connected");
      setPhase("listening");

      // Send initial "Hi" handshake
      socketRef.current?.send(
        JSON.stringify({ type: "chat", text: "Hi YPN, ready." }),
      );

      startStreaming();
    };

    socketRef.current.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "transcript_partial") {
          setLiveText(msg.text);
        } else if (msg.type === "transcript_final") {
          setLiveText(msg.text);
          setPhase("thinking");
        } else if (msg.type === "reply") {
          setAiReply(msg.text);
          setPhase("speaking");

          // 🔊 SPEAK IMMEDIATELY
          Tts.stop(); // Stop any previous speech
          Tts.speak(msg.text, {
            androidParams: { KEY_PARAM_STREAM: "STREAM_MUSIC" },
            onDone: () => {
              setPhase("listening"); // Ready for next turn
              setAiReply("");
              setLiveText("");
            },
            onError: () => setPhase("listening"),
          });
        }
      } catch (e) {
        console.error("WS Parse Error", e);
      }
    };

    socketRef.current.onerror = (e) => {
      console.error("WS Error", e);
      setPhase("idle");
    };
  };

  const startStreaming = () => {
    const options = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // Mic
      wavFile: "stream.wav",
    };

    AudioRecord.init(options);
    AudioRecord.start();

    intervalRef.current = setInterval(() => {
      const data = AudioRecord.fetch();
      if (data && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(data);
      }
    }, 100); // Send every 100ms
  };

  const disconnect = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    AudioRecord.stop();
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setPhase("idle");
  };

  // ── UI Handlers ───────────────────────────────────────────────────────────
  const toggleMic = () => {
    if (phase === "idle") connect();
    else disconnect();
  };

  // ── Animations ───────────────────────────────────────────────────────────
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (phase === "listening" || phase === "speaking") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
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

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} />

      {/* Header */}
      <SafeAreaView style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
          <Ionicons name="chevron-down" size={28} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>YPN Voice</Text>
          <Text style={styles.headerStatus}>
            {phase === "idle"
              ? "Tap to Start"
              : phase === "listening"
                ? "Listening..."
                : phase === "thinking"
                  ? "Thinking..."
                  : "Speaking..."}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setIsSettingsOpen(true)}
          style={styles.iconBtn}
        >
          <Ionicons name="settings-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </SafeAreaView>

      {/* Conversation Area */}
      <ScrollView
        ref={scrollRef}
        style={styles.chatArea}
        contentContainerStyle={styles.chatContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Live Transcript (User) */}
        {liveText !== "" && (
          <View style={styles.bubbleUser}>
            <Text style={styles.bubbleLabel}>You</Text>
            <Text style={styles.bubbleText}>{liveText}</Text>
          </View>
        )}

        {/* AI Reply */}
        {aiReply !== "" && (
          <View style={styles.bubbleAI}>
            <Text style={styles.bubbleLabel}>YPN AI</Text>
            <Text style={styles.bubbleText}>{aiReply}</Text>
          </View>
        )}

        {phase === "thinking" && (
          <View style={styles.typingIndicator}>
            <ActivityIndicator color="#1DB954" size="small" />
            <Text style={styles.typingText}>Generating reply...</Text>
          </View>
        )}
      </ScrollView>

      {/* Controls */}
      <View style={styles.controls}>
        <Animated.View
          style={[styles.pulseRing, { transform: [{ scale: pulseAnim }] }]}
        />
        <TouchableOpacity
          onPress={toggleMic}
          style={[styles.micBtn, phase !== "idle" && styles.micBtnActive]}
        >
          <Ionicons
            name={phase === "idle" ? "mic" : "stop"}
            size={32}
            color={phase === "idle" ? "#fff" : "#0B141A"}
          />
        </TouchableOpacity>
      </View>

      {/* Voice Settings Modal */}
      <Modal visible={isSettingsOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Voice</Text>
              <TouchableOpacity onPress={() => setIsSettingsOpen(false)}>
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.voiceList}>
              {availableVoices.map((voice) => (
                <TouchableOpacity
                  key={voice.id}
                  style={[
                    styles.voiceItem,
                    selectedVoiceId === voice.id && styles.voiceItemSelected,
                  ]}
                  onPress={() => changeVoice(voice.id)}
                >
                  <Text
                    style={[
                      styles.voiceName,
                      selectedVoiceId === voice.id && styles.voiceNameSelected,
                    ]}
                  >
                    {voice.name}
                  </Text>
                  {selectedVoiceId === voice.id && (
                    <Ionicons
                      name="checkmark-circle"
                      size={20}
                      color="#1DB954"
                    />
                  )}
                </TouchableOpacity>
              ))}
              {availableVoices.length === 0 && (
                <Text style={styles.emptyText}>Loading voices...</Text>
              )}
            </ScrollView>

            <Text style={styles.modalNote}>
              Voices are stored on your device. No internet required for
              playback.
            </Text>
          </View>
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
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  iconBtn: { padding: 8 },
  headerCenter: { alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  headerStatus: { color: "#8696A0", fontSize: 12, marginTop: 4 },

  chatArea: { flex: 1 },
  chatContent: { padding: 20, gap: 16, paddingBottom: 40 },

  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "#005C4B",
    borderRadius: 16,
    borderBottomRightRadius: 4,
    padding: 12,
    maxWidth: "80%",
  },
  bubbleAI: {
    alignSelf: "flex-start",
    backgroundColor: "#202C33",
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    padding: 12,
    maxWidth: "80%",
  },
  bubbleLabel: {
    fontSize: 10,
    color: "rgba(255,255,255,0.5)",
    marginBottom: 4,
    fontWeight: "600",
  },
  bubbleText: { color: "#E9EDEF", fontSize: 16, lineHeight: 22 },

  typingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    marginLeft: 10,
  },
  typingText: { color: "#8696A0", fontSize: 14 },

  controls: { alignItems: "center", paddingVertical: 30, position: "relative" },
  pulseRing: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(29, 185, 84, 0.2)",
  },
  micBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(255,255,255,0.1)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
  },
  micBtnActive: { backgroundColor: "#1DB954", borderColor: "#1DB954" },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: "#202C33",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    maxHeight: "70%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  modalTitle: { color: "#fff", fontSize: 20, fontWeight: "bold" },
  voiceList: { maxHeight: 300 },
  voiceItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  voiceItemSelected: {
    backgroundColor: "rgba(29, 185, 84, 0.1)",
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  voiceName: { color: "#E9EDEF", fontSize: 16 },
  voiceNameSelected: { color: "#1DB954", fontWeight: "600" },
  modalNote: {
    color: "#8696A0",
    fontSize: 12,
    textAlign: "center",
    marginTop: 16,
  },
  emptyText: { color: "#8696A0", textAlign: "center", paddingVertical: 20 },
});
