// src/screens/VoiceCall.tsx
//
// AI Voice Call — WebSocket + faster-whisper + gTTS
// All AI logic lives on the backend. This screen only:
//   1. Records microphone audio
//   2. Sends base64-encoded audio over WebSocket
//   3. Receives base64-encoded MP3 and plays it
//   4. Displays live transcript bubbles

import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    Animated,
    Image,
    Platform,
    Pressable,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";

// ── Config ─────────────────────────────────────────────────────────────────────
const AI_URL = process.env.EXPO_PUBLIC_AI_URL ?? "";
const WS_URL =
  AI_URL.replace("https://", "wss://").replace("http://", "ws://") + "/voice";

const STATUS_BAR_H =
  Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;

// ── Types ─────────────────────────────────────────────────────────────────────
type CallStatus =
  | "connecting"
  | "ready"
  | "recording"
  | "processing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

type Msg = { id: string; role: "user" | "ai"; text: string };

const STATUS_LABEL: Record<CallStatus, string> = {
  connecting: "Connecting...",
  ready: "Tap mic to speak",
  recording: "Listening...",
  processing: "Processing audio...",
  transcribing: "Transcribing...",
  thinking: "Thinking...",
  speaking: "Speaking...",
  error: "Connection error — tap end call",
  ended: "Call ended",
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function VoiceCallScreen() {
  const router = useRouter();

  // ── State ──────────────────────────────────────────────────────────────────
  const [callStatus, setCallStatus] = useState<CallStatus>("connecting");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [duration, setDuration] = useState(0);
  const [isRecording, setIsRecording] = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const statusRef = useRef<CallStatus>("connecting");
  const isCleaning = useRef(false);

  // Keep statusRef in sync (used inside event handlers to avoid stale closure)
  useEffect(() => {
    statusRef.current = callStatus;
  }, [callStatus]);

  // ── Animations ─────────────────────────────────────────────────────────────
  const ring1Scale = useRef(new Animated.Value(1)).current;
  const ring2Scale = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0)).current;
  const ring2Opacity = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(1)).current;
  const micPulse = useRef(new Animated.Value(1)).current;

  // Pulse rings when AI is speaking
  useEffect(() => {
    if (callStatus === "speaking") {
      ring1Opacity.setValue(0.55);
      ring2Opacity.setValue(0.25);

      const anim = Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(ring1Scale, {
              toValue: 1.5,
              duration: 850,
              useNativeDriver: true,
            }),
            Animated.timing(ring1Scale, {
              toValue: 1,
              duration: 850,
              useNativeDriver: true,
            }),
          ]),
          Animated.sequence([
            Animated.timing(ring2Scale, {
              toValue: 1.85,
              duration: 1100,
              useNativeDriver: true,
            }),
            Animated.timing(ring2Scale, {
              toValue: 1,
              duration: 1100,
              useNativeDriver: true,
            }),
          ]),
          Animated.sequence([
            Animated.timing(avatarScale, {
              toValue: 1.07,
              duration: 600,
              useNativeDriver: true,
            }),
            Animated.timing(avatarScale, {
              toValue: 1,
              duration: 600,
              useNativeDriver: true,
            }),
          ]),
        ]),
      );
      anim.start();
      return () => {
        anim.stop();
        ring1Scale.setValue(1);
        ring2Scale.setValue(1);
        avatarScale.setValue(1);
        ring1Opacity.setValue(0);
        ring2Opacity.setValue(0);
      };
    }
  }, [callStatus]);

  // Pulse mic button while recording
  useEffect(() => {
    if (isRecording) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(micPulse, {
            toValue: 1.18,
            duration: 380,
            useNativeDriver: true,
          }),
          Animated.timing(micPulse, {
            toValue: 1,
            duration: 380,
            useNativeDriver: true,
          }),
        ]),
      );
      anim.start();
      return () => {
        anim.stop();
        micPulse.setValue(1);
      };
    }
  }, [isRecording]);

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    initCall();
    durationTimer.current = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => {
      cleanup();
    };
  }, []);

  // ── Init ───────────────────────────────────────────────────────────────────
  const initCall = async () => {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      setCallStatus("error");
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    connectWS();
  };

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const connectWS = () => {
    const socket = new WebSocket(WS_URL);
    wsRef.current = socket;

    socket.onopen = () => {
      // Send periodic pings to keep Render connection alive
      pingTimer.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 25_000);
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data as string);
        handleServerMsg(data);
      } catch (e) {
        console.warn("[Voice] parse error:", e);
      }
    };

    socket.onerror = () => setCallStatus("error");

    socket.onclose = () => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      if (statusRef.current !== "ended") setCallStatus("error");
    };
  };

  const send = (obj: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    }
  };

  // ── Server message handler ─────────────────────────────────────────────────
  const handleServerMsg = async (data: Record<string, any>) => {
    switch (data.type) {
      case "session_started":
        setCallStatus("ready");
        break;

      case "status":
        setCallStatus(data.status as CallStatus);
        break;

      case "transcript":
        if (data.text?.trim()) {
          setMessages((p) => [
            ...p,
            { id: `u_${Date.now()}`, role: "user", text: data.text },
          ]);
          scrollRef.current?.scrollToEnd({ animated: true });
        }
        break;

      case "ai_response":
        if (data.text?.trim()) {
          setMessages((p) => [
            ...p,
            { id: `a_${Date.now()}`, role: "ai", text: data.text },
          ]);
          scrollRef.current?.scrollToEnd({ animated: true });
        }
        break;

      case "audio":
        // Play base64-encoded MP3 from TTS
        await playAudio(data.data as string);
        setCallStatus("ready");
        break;

      case "error":
        console.warn("[Voice] Server error:", data.message);
        setCallStatus("ready");
        break;

      case "timeout":
      case "call_ended":
        setCallStatus("ended");
        cleanup();
        router.back();
        break;
    }
  };

  // ── Audio playback ─────────────────────────────────────────────────────────
  const playAudio = async (base64Mp3: string) => {
    try {
      // Stop any current playback
      if (soundRef.current) {
        await soundRef.current.stopAsync().catch(() => {});
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }

      const fileUri =
        (FileSystem.cacheDirectory ?? "") + `ypn_voice_${Date.now()}.mp3`;

      await FileSystem.writeAsStringAsync(fileUri, base64Mp3, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: true },
      );
      soundRef.current = sound;

      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
        }
      });
    } catch (e) {
      console.error("[Voice] Playback error:", e);
    }
  };

  // ── Recording ──────────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (callStatus !== "ready") return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      setIsRecording(true);
      setCallStatus("recording");
    } catch (e) {
      console.error("[Voice] Start recording error:", e);
    }
  };

  const stopRecording = async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setIsRecording(false);
    setCallStatus("processing");

    try {
      const uri = rec.getURI(); // get URI before unloading
      await rec.stopAndUnloadAsync();

      if (!uri || wsRef.current?.readyState !== WebSocket.OPEN) {
        setCallStatus("ready");
        return;
      }

      const ext = uri.split(".").pop() ?? "m4a";
      const base64Audio = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Send audio then signal end-of-speech
      send({ type: "audio_chunk", data: base64Audio });
      send({ type: "end_of_speech", format: ext });

      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    } catch (e) {
      console.error("[Voice] Stop recording error:", e);
      setCallStatus("ready");
    }
  };

  const toggleMic = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, callStatus]);

  // ── End call ───────────────────────────────────────────────────────────────
  const endCall = useCallback(async () => {
    send({ type: "end_call" });
    setCallStatus("ended");
    await cleanup();
    router.back();
  }, [router]);

  const cleanup = async () => {
    if (isCleaning.current) return;
    isCleaning.current = true;

    if (durationTimer.current) clearInterval(durationTimer.current);
    if (pingTimer.current) clearInterval(pingTimer.current);

    if (recRef.current) {
      try {
        await recRef.current.stopAndUnloadAsync();
      } catch {}
      recRef.current = null;
    }
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch {}
      soundRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });
    } catch {}

    isCleaning.current = false;
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const fmtDuration = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  const micDisabled = callStatus !== "ready" && !isRecording;
  const connectedStatuses: CallStatus[] = [
    "ready",
    "recording",
    "processing",
    "transcribing",
    "thinking",
    "speaking",
  ];
  const isConnected = connectedStatuses.includes(callStatus);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0B141A" />

      {/* ── Header ── */}
      <View style={[s.header, { paddingTop: STATUS_BAR_H + 16 }]}>
        <View
          style={[
            s.connDot,
            { backgroundColor: isConnected ? "#25D366" : "#555" },
          ]}
        />
        <Text style={s.timer}>{fmtDuration(duration)}</Text>
      </View>

      {/* ── Avatar + animated rings ── */}
      <View style={s.avatarSection}>
        {/* Outer ring */}
        <Animated.View
          style={[
            s.ring2,
            {
              transform: [{ scale: ring2Scale }],
              opacity: ring2Opacity,
            },
          ]}
        />
        {/* Inner ring */}
        <Animated.View
          style={[
            s.ring1,
            {
              transform: [{ scale: ring1Scale }],
              opacity: ring1Opacity,
            },
          ]}
        />

        {/* Avatar */}
        <Animated.View
          style={[
            s.avatarWrap,
            { transform: [{ scale: avatarScale }] },
            isRecording && s.avatarRecording,
          ]}
        >
          <Image
            source={require("../../assets/images/YPN.png")}
            style={s.avatar}
          />
        </Animated.View>

        <Text style={s.name}>Team YPN</Text>
        <Text style={s.statusTxt}>{STATUS_LABEL[callStatus]}</Text>
      </View>

      {/* ── Transcript bubbles ── */}
      <ScrollView
        ref={scrollRef}
        style={s.transcriptArea}
        contentContainerStyle={s.transcriptContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.map((m) => (
          <View
            key={m.id}
            style={[s.bubble, m.role === "user" ? s.userBubble : s.aiBubble]}
          >
            <Text style={s.bubbleText}>{m.text}</Text>
          </View>
        ))}
      </ScrollView>

      {/* ── Call controls ── */}
      <View style={s.controls}>
        {/* End call */}
        <TouchableOpacity
          style={s.endBtn}
          onPress={endCall}
          activeOpacity={0.8}
        >
          <Ionicons
            name="call"
            size={26}
            color="#fff"
            style={{ transform: [{ rotate: "135deg" }] }}
          />
        </TouchableOpacity>

        {/* Mic toggle */}
        <Pressable
          onPress={toggleMic}
          disabled={micDisabled}
          style={({ pressed }) => [
            s.micBtn,
            isRecording && s.micBtnActive,
            micDisabled && s.micBtnDisabled,
            pressed && !micDisabled && { opacity: 0.82 },
          ]}
        >
          <Animated.View style={{ transform: [{ scale: micPulse }] }}>
            <Ionicons
              name={isRecording ? "stop" : "mic"}
              size={30}
              color="#fff"
            />
          </Animated.View>
        </Pressable>
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B141A",
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingBottom: 10,
    gap: 8,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  timer: {
    color: "#8696A0",
    fontSize: 16,
    fontWeight: "500",
  },

  // Avatar section
  avatarSection: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  ring2: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 1,
    borderColor: "#25D366",
    backgroundColor: "rgba(37,211,102,0.04)",
  },
  ring1: {
    position: "absolute",
    width: 165,
    height: 165,
    borderRadius: 82,
    borderWidth: 1.5,
    borderColor: "#25D366",
    backgroundColor: "rgba(37,211,102,0.08)",
  },
  avatarWrap: {
    width: 120,
    height: 120,
    borderRadius: 60,
    overflow: "hidden",
    borderWidth: 3,
    borderColor: "#25D366",
    shadowColor: "#25D366",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 12,
  },
  avatarRecording: {
    borderColor: "#E91429",
    shadowColor: "#E91429",
  },
  avatar: {
    width: 120,
    height: 120,
  },
  name: {
    color: "#E9EDEF",
    fontSize: 22,
    fontWeight: "700",
    marginTop: 22,
    letterSpacing: 0.3,
  },
  statusTxt: {
    color: "#8696A0",
    fontSize: 14,
    marginTop: 7,
    letterSpacing: 0.2,
  },

  // Transcript
  transcriptArea: {
    maxHeight: 170,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  transcriptContent: {
    gap: 6,
    paddingVertical: 4,
  },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 16,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#005C4B",
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#202C33",
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    color: "#E9EDEF",
    fontSize: 14,
    lineHeight: 20,
  },

  // Controls
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: Platform.OS === "ios" ? 52 : 32,
    paddingTop: 16,
    gap: 52,
  },
  endBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#E91429",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#E91429",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 8,
  },
  micBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#25D366",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#25D366",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 10,
  },
  micBtnActive: {
    backgroundColor: "#E91429",
    shadowColor: "#E91429",
  },
  micBtnDisabled: {
    backgroundColor: "#1F2C34",
    shadowOpacity: 0,
    elevation: 0,
  },
});
