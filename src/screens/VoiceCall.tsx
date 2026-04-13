// src/screens/VoiceCall.tsx
//
// YPN AI Voice Call
// ─────────────────────────────────────────────────────────────────────────────
// Uses expo-audio (SDK 54+) — NOT expo-av.
//
// Flow:
//   1. WebSocket connects to /voice on AI service
//   2. expo-audio records mic at 16kHz PCM, sends chunks over WS
//   3. Client VAD: silence → "VAD_SILENCE", speech-during-AI → "INTERRUPT"
//   4. Server: Vosk STT → Cohere → Kokoro TTS → WAV chunks back
//   5. expo-audio plays returned WAV chunks
//   6. Transcript + AI reply shown on screen
// ─────────────────────────────────────────────────────────────────────────────

import { Ionicons } from "@expo/vector-icons";
import {
  AudioModule,
  RecordingPresets,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Platform,
  StatusBar as RNStatusBar,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── Config ─────────────────────────────────────────────────────────────────────
const AI_WS_URL = (() => {
  const base = process.env.EXPO_PUBLIC_AI_URL ?? "";
  return base.replace(/^https/, "wss").replace(/^http/, "ws") + "/voice";
})();

// Silence detection
const SILENCE_DB = -38; // dB below = silence
const SPEECH_DB = -28; // dB above = user speaking (barge-in)
const SILENCE_WAIT_MS = 1200; // ms of silence before VAD_SILENCE
const POLL_MS = 120; // metering poll interval

// ── Types ──────────────────────────────────────────────────────────────────────
type CallState =
  | "connecting"
  | "idle"
  | "user_speaking"
  | "ai_speaking"
  | "error";

type Transcript = {
  id: string;
  role: "user" | "ai";
  text: string;
};

// ── Component ──────────────────────────────────────────────────────────────────
export default function VoiceCallScreen() {
  const router = useRouter();

  const [callState, setCallState] = useState<CallState>("connecting");
  const [muted, setMuted] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [callDuration, setCallDuration] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const isMountedRef = useRef(true);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const isAiSpeakingRef = useRef(false);
  const audioChunksRef = useRef<Uint8Array[]>([]);

  // expo-audio recorder
  const audioRecorder = useAudioRecorder(
    RecordingPresets.HIGH_QUALITY,
    (status) => {
      // metering callback — called every ~100ms when isMeteringEnabled
      handleMetering(status.metering ?? -160);
    },
  );
  const recorderState = useAudioRecorderState(audioRecorder, POLL_MS);

  // expo-audio player — used to play back AI WAV audio
  const player = useAudioPlayer(null);

  // Pulse animation for AI speaking
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // ── Pulse animation ───────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    pulseLoopRef.current?.stop();
    pulseLoopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.18,
          duration: 480,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 480,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoopRef.current.start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseLoopRef.current?.stop();
    Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true }).start();
  }, [pulseAnim]);

  // ── WebSocket ────────────────────────────────────────────────────────────
  const setupWS = useCallback(() => {
    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket(AI_WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current) return;
      setCallState("idle");
      durationTimerRef.current = setInterval(
        () => setCallDuration((d) => d + 1),
        1000,
      );
    };

    ws.onmessage = async (event) => {
      if (!isMountedRef.current) return;

      // Binary = WAV audio chunk
      if (event.data instanceof ArrayBuffer) {
        audioChunksRef.current.push(new Uint8Array(event.data));
        return;
      }

      try {
        const msg = JSON.parse(event.data as string);

        switch (msg.type) {
          case "transcript":
            setTranscripts((p) => [
              ...p,
              { id: `u_${Date.now()}`, role: "user", text: msg.text },
            ]);
            setTimeout(
              () => scrollRef.current?.scrollToEnd({ animated: true }),
              80,
            );
            break;

          case "reply":
            setTranscripts((p) => [
              ...p,
              { id: `a_${Date.now()}`, role: "ai", text: msg.text },
            ]);
            setTimeout(
              () => scrollRef.current?.scrollToEnd({ animated: true }),
              80,
            );
            isAiSpeakingRef.current = true;
            setCallState("ai_speaking");
            startPulse();
            break;

          case "audio_start":
            audioChunksRef.current = [];
            break;

          case "audio_end":
            if (audioChunksRef.current.length > 0) {
              await playAccumulatedAudio();
            } else {
              isAiSpeakingRef.current = false;
              setCallState("idle");
              stopPulse();
            }
            break;

          case "error":
            // Generic message only — no internal details shown
            isAiSpeakingRef.current = false;
            setCallState("error");
            stopPulse();
            break;
        }
      } catch (e) {
        // parse error — ignore
      }
    };

    ws.onerror = () => {
      if (isMountedRef.current) setCallState("error");
    };

    ws.onclose = () => {
      // handled via hangup or unmount
    };
  }, [startPulse, stopPulse]);

  // ── Play accumulated WAV chunks via expo-audio ────────────────────────────
  const playAccumulatedAudio = useCallback(async () => {
    try {
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];

      // Combine chunks into one buffer
      const totalLen = chunks.reduce((a, c) => a + c.length, 0);
      const combined = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        combined.set(c, off);
        off += c.length;
      }

      // Convert to base64 data URI (expo-audio accepts data URIs)
      let binary = "";
      for (let i = 0; i < combined.length; i += 8192) {
        binary += String.fromCharCode(...combined.subarray(i, i + 8192));
      }
      const b64 = btoa(binary);
      const uri = `data:audio/wav;base64,${b64}`;

      // expo-audio: replace source and play
      player.replace({ uri });
      player.play();

      // When playback ends, return to idle
      // expo-audio fires status updates — poll until finished
      const checkDone = setInterval(() => {
        if (!isMountedRef.current) {
          clearInterval(checkDone);
          return;
        }
        if (!player.playing) {
          clearInterval(checkDone);
          isAiSpeakingRef.current = false;
          setCallState("idle");
          stopPulse();
        }
      }, 200);
    } catch (e) {
      isAiSpeakingRef.current = false;
      setCallState("idle");
      stopPulse();
    }
  }, [player, stopPulse]);

  // ── VAD / metering ────────────────────────────────────────────────────────
  const handleMetering = useCallback(
    (db: number) => {
      if (!isMountedRef.current || muted) return;

      // Barge-in: user speaks while AI is talking
      if (isAiSpeakingRef.current && db > SPEECH_DB) {
        wsRef.current?.send("INTERRUPT");
        player.pause();
        isAiSpeakingRef.current = false;
        setCallState("user_speaking");
        stopPulse();
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        return;
      }

      if (db < SILENCE_DB) {
        // Silence
        if (!silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              flushAudio();
            }
          }, SILENCE_WAIT_MS);
        }
      } else {
        // Speech
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        if (!isAiSpeakingRef.current) {
          setCallState("user_speaking");
        }
      }
    },
    [muted, player, stopPulse],
  );

  // ── Flush recorded audio to server ───────────────────────────────────────
  const flushAudio = useCallback(async () => {
    if (!audioRecorder || !wsRef.current) return;

    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;

      if (uri && wsRef.current.readyState === WebSocket.OPEN) {
        const res = await fetch(uri);
        const buf = await res.arrayBuffer();
        wsRef.current.send(buf);
        wsRef.current.send("VAD_SILENCE");
      }
    } catch (e) {
      // recording may not have been active
    }

    // Restart recording
    if (isMountedRef.current && !muted) {
      await startMic();
    }
  }, [audioRecorder, muted]);

  // ── Start microphone ──────────────────────────────────────────────────────
  const startMic = useCallback(async () => {
    if (muted) return;
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        setCallState("error");
        return;
      }

      await AudioModule.setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
    } catch (e) {
      // mic start failed — non-fatal, user can speak again
    }
  }, [audioRecorder, muted]);

  // ── Lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    setupWS();
    return () => {
      isMountedRef.current = false;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pulseLoopRef.current?.stop();
      audioRecorder.stop().catch(() => {});
      player.pause();
      if (wsRef.current) {
        try {
          wsRef.current.send("HANGUP");
        } catch {}
        wsRef.current.close();
      }
    };
  }, []);

  // Start mic once connected
  useEffect(() => {
    if (callState === "idle" && !recorderState.isRecording && !muted) {
      startMic();
    }
  }, [callState]);

  // ── Mute ─────────────────────────────────────────────────────────────────
  const handleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next);
    if (next) {
      await audioRecorder.stop().catch(() => {});
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    }
  }, [muted, audioRecorder]);

  useEffect(() => {
    if (!muted && callState === "idle" && !recorderState.isRecording) {
      startMic();
    }
  }, [muted, callState]);

  // ── Hang up ───────────────────────────────────────────────────────────────
  const handleHangUp = useCallback(async () => {
    await audioRecorder.stop().catch(() => {});
    player.pause();
    if (wsRef.current) {
      try {
        wsRef.current.send("HANGUP");
      } catch {}
      wsRef.current.close();
      wsRef.current = null;
    }
    router.back();
  }, [audioRecorder, player, router]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatDuration = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  const statusLabel = () => {
    switch (callState) {
      case "connecting":
        return "Connecting…";
      case "idle":
        return "Listening…";
      case "user_speaking":
        return "Speaking…";
      case "ai_speaking":
        return "YPN AI is speaking";
      case "error":
        return "Reconnect or hang up";
    }
  };

  const STATUS_H =
    Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={[s.root, { paddingTop: STATUS_H }]}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>YPN AI</Text>
        <Text style={s.headerDuration}>{formatDuration(callDuration)}</Text>
      </View>

      {/* Avatar */}
      <View style={s.avatarSection}>
        <Animated.View
          style={[
            s.avatarRing,
            {
              transform: [{ scale: pulseAnim }],
              borderColor:
                callState === "ai_speaking"
                  ? "#1DB954"
                  : callState === "user_speaking"
                    ? "#53BDEB"
                    : "#2A3942",
            },
          ]}
        >
          <Animated.View
            style={[
              s.avatarRingInner,
              {
                transform: [{ scale: pulseAnim }],
                backgroundColor:
                  callState === "ai_speaking"
                    ? "rgba(29,185,84,0.12)"
                    : "rgba(255,255,255,0.03)",
              },
            ]}
          >
            <Image
              source={require("../../assets/images/YPN.png")}
              style={s.avatar}
            />
          </Animated.View>
        </Animated.View>

        <Text style={s.statusLabel}>{statusLabel()}</Text>

        {callState === "user_speaking" && (
          <Text style={s.listeningHint}>I'm listening…</Text>
        )}
      </View>

      {/* Transcript */}
      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {transcripts.length === 0 ? (
          <Text style={s.placeholder}>
            {callState === "connecting"
              ? "Connecting to YPN AI…"
              : "Say something to start"}
          </Text>
        ) : (
          transcripts.map((t) => (
            <View
              key={t.id}
              style={[
                s.bubbleRow,
                t.role === "user" ? s.bubbleRowUser : s.bubbleRowAI,
              ]}
            >
              <View
                style={[
                  s.bubble,
                  t.role === "user" ? s.bubbleUser : s.bubbleAI,
                ]}
              >
                <Text style={s.bubbleLabel}>
                  {t.role === "user" ? "You" : "YPN AI"}
                </Text>
                <Text style={s.bubbleText}>{t.text}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* Controls */}
      <View style={s.controls}>
        <TouchableOpacity
          style={[s.btn, muted && s.btnActive]}
          onPress={handleMute}
          activeOpacity={0.8}
        >
          <Ionicons
            name={muted ? "mic-off" : "mic-outline"}
            size={26}
            color={muted ? "#000" : "#fff"}
          />
          <Text style={[s.btnLabel, muted && s.btnLabelActive]}>
            {muted ? "Unmute" : "Mute"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.hangUp}
          onPress={handleHangUp}
          activeOpacity={0.8}
        >
          <Ionicons name="call" size={32} color="#fff" />
        </TouchableOpacity>

        <View style={s.btn}>
          <Ionicons name="volume-high-outline" size={26} color="#fff" />
          <Text style={s.btnLabel}>Speaker</Text>
        </View>
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B141A" },

  header: {
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1F2C34",
  },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  headerDuration: { color: "#8696A0", fontSize: 13, marginTop: 2 },

  avatarSection: { alignItems: "center", paddingTop: 32, paddingBottom: 20 },
  avatarRing: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  avatarRingInner: {
    width: 124,
    height: 124,
    borderRadius: 62,
    justifyContent: "center",
    alignItems: "center",
  },
  avatar: { width: 100, height: 100, borderRadius: 50 },
  statusLabel: { color: "#fff", fontSize: 16, fontWeight: "600" },
  listeningHint: { color: "#53BDEB", fontSize: 13, marginTop: 4 },

  scroll: { flex: 1, paddingHorizontal: 16 },
  scrollContent: { paddingVertical: 12, gap: 8 },
  placeholder: {
    color: "#3A4A54",
    fontSize: 14,
    textAlign: "center",
    marginTop: 20,
  },
  bubbleRow: { flexDirection: "row" },
  bubbleRowUser: { justifyContent: "flex-end" },
  bubbleRowAI: { justifyContent: "flex-start" },
  bubble: { maxWidth: "80%", borderRadius: 12, padding: 10 },
  bubbleUser: { backgroundColor: "#005C4B", borderBottomRightRadius: 3 },
  bubbleAI: { backgroundColor: "#202C33", borderBottomLeftRadius: 3 },
  bubbleLabel: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 10,
    fontWeight: "600",
    marginBottom: 3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  bubbleText: { color: "#E9EDEF", fontSize: 15, lineHeight: 21 },

  controls: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 24,
    paddingBottom: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1F2C34",
    backgroundColor: "#111B21",
  },
  btn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#202C33",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
  },
  btnActive: { backgroundColor: "#fff" },
  btnLabel: { color: "#8696A0", fontSize: 10 },
  btnLabelActive: { color: "#000" },
  hangUp: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#E91429",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#E91429",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
});
