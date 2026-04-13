// src/screens/VoiceCall.tsx
//
// YPN AI Voice Call
// ─────────────────────────────────────────────────────────────────────────────
// Flow:
//   1. Open WebSocket to /voice on AI service
//   2. Capture mic via expo-audio, stream 16kHz PCM chunks over WS
//   3. Client-side VAD: detect silence → send "VAD_SILENCE" control frame
//   4. Server: Vosk STT → Cohere → Kokoro TTS → stream WAV chunks back
//   5. Client plays WAV chunks via expo-av Audio.Sound
//   6. Barge-in: if user speaks while AI talking → send "INTERRUPT"
//   7. Text transcript + AI reply shown on screen
// ─────────────────────────────────────────────────────────────────────────────

import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
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
  // Replace http(s) with ws(s)
  return base.replace(/^http/, "ws") + "/voice";
})();

const SAMPLE_RATE = 16000;
const RECORDING_INTERVAL_MS = 100; // how often we read audio chunks
const SILENCE_DB_THRESHOLD = -35; // dB below which = silence
const SILENCE_DURATION_MS = 1200; // ms of silence before sending VAD_SILENCE
const SPEECH_DB_THRESHOLD = -28; // dB above which = user speaking (barge-in)

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
  const [errorMsg, setErrorMsg] = useState("");
  const [callDuration, setCallDuration] = useState(0);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const isMountedRef = useRef(true);
  const isAiSpeakingRef = useRef(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  // Accumulate WAV chunks while AI is streaming
  const audioChunksRef = useRef<Uint8Array[]>([]);
  const audioPlaybackActiveRef = useRef(false);

  // Animation for AI speaking indicator
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // ── Animations ────────────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    pulseLoopRef.current?.stop();
    pulseLoopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.18,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoopRef.current.start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseLoopRef.current?.stop();
    Animated.spring(pulseAnim, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [pulseAnim]);

  // ── Audio playback ────────────────────────────────────────────────────────
  const stopCurrentSound = useCallback(async () => {
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch {}
      soundRef.current = null;
    }
    audioChunksRef.current = [];
    audioPlaybackActiveRef.current = false;
  }, []);

  /**
   * Play accumulated WAV bytes using expo-av Audio.Sound.
   * expo-av accepts a data URI with base64 WAV.
   */
  const playWavBytes = useCallback(
    async (wavBytes: Uint8Array) => {
      try {
        await stopCurrentSound();

        // Convert Uint8Array → base64
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < wavBytes.length; i += chunkSize) {
          binary += String.fromCharCode(...wavBytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        const uri = `data:audio/wav;base64,${base64}`;

        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true, volume: 1.0 },
        );
        soundRef.current = sound;

        sound.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            sound.unloadAsync();
            soundRef.current = null;
            audioPlaybackActiveRef.current = false;
            if (isMountedRef.current) {
              isAiSpeakingRef.current = false;
              setCallState("idle");
              stopPulse();
            }
          }
        });
      } catch (e) {
        console.warn("[VoiceCall] playWavBytes error:", e);
        audioPlaybackActiveRef.current = false;
        isAiSpeakingRef.current = false;
        setCallState("idle");
        stopPulse();
      }
    },
    [stopCurrentSound, stopPulse],
  );

  // ── WebSocket setup ────────────────────────────────────────────────────────
  const setupWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const ws = new WebSocket(AI_WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMountedRef.current) return;
      console.log("[VoiceCall] WS connected");
      setCallState("idle");
      setErrorMsg("");
      // Start call duration timer
      durationTimerRef.current = setInterval(() => {
        setCallDuration((d) => d + 1);
      }, 1000);
    };

    ws.onmessage = async (event) => {
      if (!isMountedRef.current) return;

      // Binary = audio chunk from Kokoro TTS
      if (event.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(event.data);
        audioChunksRef.current.push(chunk);
        return;
      }

      // Text = control/data JSON
      try {
        const msg = JSON.parse(event.data as string);

        switch (msg.type) {
          case "transcript":
            // What the user said
            setTranscripts((prev) => [
              ...prev,
              { id: `u_${Date.now()}`, role: "user", text: msg.text },
            ]);
            setTimeout(
              () => scrollRef.current?.scrollToEnd({ animated: true }),
              100,
            );
            break;

          case "reply":
            // AI text reply
            setTranscripts((prev) => [
              ...prev,
              { id: `a_${Date.now()}`, role: "ai", text: msg.text },
            ]);
            setTimeout(
              () => scrollRef.current?.scrollToEnd({ animated: true }),
              100,
            );
            isAiSpeakingRef.current = true;
            setCallState("ai_speaking");
            startPulse();
            break;

          case "audio_start":
            audioChunksRef.current = [];
            audioPlaybackActiveRef.current = true;
            break;

          case "audio_end":
            // All audio chunks received — combine and play
            if (audioChunksRef.current.length > 0) {
              const total = audioChunksRef.current.reduce(
                (acc, c) => acc + c.length,
                0,
              );
              const combined = new Uint8Array(total);
              let offset = 0;
              for (const c of audioChunksRef.current) {
                combined.set(c, offset);
                offset += c.length;
              }
              audioChunksRef.current = [];
              await playWavBytes(combined);
            } else {
              isAiSpeakingRef.current = false;
              setCallState("idle");
              stopPulse();
            }
            break;

          case "error":
            console.warn("[VoiceCall] Server error:", msg.message);
            setErrorMsg(msg.message ?? "Unknown error");
            isAiSpeakingRef.current = false;
            setCallState("error");
            stopPulse();
            break;

          default:
            break;
        }
      } catch (e) {
        console.warn("[VoiceCall] Failed to parse WS message:", e);
      }
    };

    ws.onerror = (e) => {
      console.warn("[VoiceCall] WS error:", e);
      if (isMountedRef.current) {
        setCallState("error");
        setErrorMsg("Connection error. Please try again.");
      }
    };

    ws.onclose = () => {
      console.log("[VoiceCall] WS closed");
    };
  }, [startPulse, stopPulse, playWavBytes]);

  // ── Microphone recording ───────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (muted) return;

    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        setErrorMsg("Microphone permission denied.");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        android: {
          extension: ".pcm",
          outputFormat: Audio.AndroidOutputFormat.PCM_16BIT,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 1,
          bitRate: 256000,
        },
        ios: {
          extension: ".caf",
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 1,
          bitRate: 256000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {},
        isMeteringEnabled: true,
      });

      await recording.startAsync();
      recordingRef.current = recording;

      // Poll metering + send audio chunks
      const pollInterval = setInterval(async () => {
        if (!recordingRef.current || !isMountedRef.current) {
          clearInterval(pollInterval);
          return;
        }

        const status = await recordingRef.current.getStatusAsync();
        if (!status.isRecording) {
          clearInterval(pollInterval);
          return;
        }

        const db = status.metering ?? -160;

        // Barge-in detection: user speaks while AI is talking
        if (isAiSpeakingRef.current && db > SPEECH_DB_THRESHOLD) {
          wsRef.current?.send("INTERRUPT");
          await stopCurrentSound();
          isAiSpeakingRef.current = false;
          setCallState("user_speaking");
          stopPulse();
        }

        // VAD silence detection
        if (db < SILENCE_DB_THRESHOLD) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(async () => {
              // User has been silent — send VAD signal
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                // Stop recording, read file, send PCM, restart recording
                await flushAudioToServer();
              }
              silenceTimerRef.current = null;
            }, SILENCE_DURATION_MS);
          }
        } else {
          // Speech detected — cancel silence timer
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          if (!isAiSpeakingRef.current) {
            setCallState("user_speaking");
          }
        }
      }, RECORDING_INTERVAL_MS);

      // Store interval ref for cleanup
      (recordingRef.current as any)._pollInterval = pollInterval;
    } catch (e) {
      console.warn("[VoiceCall] startRecording error:", e);
    }
  }, [muted, stopCurrentSound, stopPulse]);

  /**
   * Stop recording, read the audio file as PCM bytes,
   * send over WebSocket, then signal VAD_SILENCE.
   */
  const flushAudioToServer = useCallback(async () => {
    if (!recordingRef.current) return;

    const rec = recordingRef.current;
    if ((rec as any)._pollInterval) {
      clearInterval((rec as any)._pollInterval);
    }

    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      recordingRef.current = null;

      if (uri && wsRef.current?.readyState === WebSocket.OPEN) {
        // Read file as base64 then convert to ArrayBuffer
        const response = await fetch(uri);
        const arrayBuffer = await response.arrayBuffer();

        // Send audio bytes
        wsRef.current.send(arrayBuffer);
        // Signal end of speech
        wsRef.current.send("VAD_SILENCE");
      }
    } catch (e) {
      console.warn("[VoiceCall] flushAudioToServer error:", e);
    }

    // Restart recording
    if (isMountedRef.current && !muted) {
      await startRecording();
    }
  }, [muted, startRecording]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    setupWebSocket();

    return () => {
      isMountedRef.current = false;
      // Clean up
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      pulseLoopRef.current?.stop();

      if (recordingRef.current) {
        if ((recordingRef.current as any)._pollInterval) {
          clearInterval((recordingRef.current as any)._pollInterval);
        }
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }

      stopCurrentSound();

      if (wsRef.current) {
        wsRef.current.send("HANGUP");
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // Start mic once connected
  useEffect(() => {
    if (callState === "idle" && !recordingRef.current && !muted) {
      startRecording();
    }
  }, [callState]);

  // ── Mute toggle ────────────────────────────────────────────────────────────
  const handleMute = useCallback(async () => {
    setMuted((m) => {
      const next = !m;
      if (next) {
        // Muting — stop recording
        if (recordingRef.current) {
          if ((recordingRef.current as any)._pollInterval) {
            clearInterval((recordingRef.current as any)._pollInterval);
          }
          recordingRef.current.stopAndUnloadAsync().catch(() => {});
          recordingRef.current = null;
        }
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
      }
      return next;
    });
  }, []);

  // Re-start recording when unmuted
  useEffect(() => {
    if (!muted && callState === "idle" && !recordingRef.current) {
      startRecording();
    }
  }, [muted, callState]);

  // ── Hang up ────────────────────────────────────────────────────────────────
  const handleHangUp = useCallback(async () => {
    if (recordingRef.current) {
      if ((recordingRef.current as any)._pollInterval) {
        clearInterval((recordingRef.current as any)._pollInterval);
      }
      await recordingRef.current.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
    }
    await stopCurrentSound();
    if (wsRef.current) {
      try {
        wsRef.current.send("HANGUP");
      } catch {}
      wsRef.current.close();
      wsRef.current = null;
    }
    router.back();
  }, [router, stopCurrentSound]);

  // ── Format duration ────────────────────────────────────────────────────────
  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  // ── Status label ───────────────────────────────────────────────────────────
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
        return errorMsg || "Error";
    }
  };

  const STATUS_H =
    Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={[s.root, { paddingTop: STATUS_H }]}>
      {/* ── Header ── */}
      <View style={s.header}>
        <Text style={s.headerTitle}>YPN AI</Text>
        <Text style={s.headerDuration}>{formatDuration(callDuration)}</Text>
      </View>

      {/* ── Avatar area ── */}
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
                    : "#333",
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
                    : "rgba(255,255,255,0.04)",
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

      {/* ── Transcript scroll ── */}
      <ScrollView
        ref={scrollRef}
        style={s.transcriptScroll}
        contentContainerStyle={s.transcriptContent}
        showsVerticalScrollIndicator={false}
      >
        {transcripts.length === 0 ? (
          <Text style={s.transcriptPlaceholder}>
            {callState === "connecting"
              ? "Connecting to YPN AI…"
              : "Say something to start the conversation"}
          </Text>
        ) : (
          transcripts.map((t) => (
            <View
              key={t.id}
              style={[
                s.transcriptRow,
                t.role === "user" ? s.transcriptUser : s.transcriptAI,
              ]}
            >
              <View
                style={[
                  s.transcriptBubble,
                  t.role === "user"
                    ? s.transcriptBubbleUser
                    : s.transcriptBubbleAI,
                ]}
              >
                <Text style={s.transcriptLabel}>
                  {t.role === "user" ? "You" : "YPN AI"}
                </Text>
                <Text style={s.transcriptText}>{t.text}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* ── Controls ── */}
      <View style={s.controls}>
        {/* Mute */}
        <TouchableOpacity
          style={[s.controlBtn, muted && s.controlBtnActive]}
          onPress={handleMute}
          activeOpacity={0.8}
        >
          <Ionicons
            name={muted ? "mic-off" : "mic-outline"}
            size={26}
            color={muted ? "#000" : "#fff"}
          />
          <Text style={[s.controlLabel, muted && s.controlLabelActive]}>
            {muted ? "Unmute" : "Mute"}
          </Text>
        </TouchableOpacity>

        {/* Hang up */}
        <TouchableOpacity
          style={s.hangUpBtn}
          onPress={handleHangUp}
          activeOpacity={0.8}
        >
          <Ionicons name="call" size={32} color="#fff" />
        </TouchableOpacity>

        {/* Speaker placeholder — always on for now */}
        <View style={s.controlBtn}>
          <Ionicons name="volume-high-outline" size={26} color="#fff" />
          <Text style={s.controlLabel}>Speaker</Text>
        </View>
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

  header: {
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1F2C34",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  headerDuration: {
    color: "#8696A0",
    fontSize: 13,
    marginTop: 2,
  },

  avatarSection: {
    alignItems: "center",
    paddingTop: 32,
    paddingBottom: 20,
  },
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
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  statusLabel: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  listeningHint: {
    color: "#53BDEB",
    fontSize: 13,
    marginTop: 4,
  },

  transcriptScroll: {
    flex: 1,
    paddingHorizontal: 16,
  },
  transcriptContent: {
    paddingVertical: 12,
    gap: 8,
  },
  transcriptPlaceholder: {
    color: "#3A4A54",
    fontSize: 14,
    textAlign: "center",
    marginTop: 20,
  },
  transcriptRow: {
    flexDirection: "row",
  },
  transcriptUser: {
    justifyContent: "flex-end",
  },
  transcriptAI: {
    justifyContent: "flex-start",
  },
  transcriptBubble: {
    maxWidth: "80%",
    borderRadius: 12,
    padding: 10,
  },
  transcriptBubbleUser: {
    backgroundColor: "#005C4B",
    borderBottomRightRadius: 3,
  },
  transcriptBubbleAI: {
    backgroundColor: "#202C33",
    borderBottomLeftRadius: 3,
  },
  transcriptLabel: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 10,
    fontWeight: "600",
    marginBottom: 3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  transcriptText: {
    color: "#E9EDEF",
    fontSize: 15,
    lineHeight: 21,
  },

  controls: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1F2C34",
    paddingBottom: 40,
    backgroundColor: "#111B21",
  },
  controlBtn: {
    alignItems: "center",
    gap: 6,
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#202C33",
    justifyContent: "center",
  },
  controlBtnActive: {
    backgroundColor: "#fff",
  },
  controlLabel: {
    color: "#8696A0",
    fontSize: 11,
    position: "absolute",
    bottom: -18,
  },
  controlLabelActive: {
    color: "#000",
  },
  hangUpBtn: {
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
