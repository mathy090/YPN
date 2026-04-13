// src/utils/voiceCall.ts
//
// Continuous voice call manager.
//
// Audio flow:
//   Mic (expo-av) → raw PCM 16kHz mono int16
//               → base64-encode
//               → WebSocket /voice as { type:"audio_chunk", data: "<b64>" }
//
// TTS flow:
//   WebSocket tts_chunk frames (base64 raw PCM 22050Hz mono int16)
//               → decode
//               → write to a rolling Audio.Sound queue
//               → play sequentially
//
// Barge-in:
//   VAD on server detects user speech while AI is replying
//   → client sends { type:"barge_in" }
//   → server kills Piper subprocess, sends tts_end
//   → client flushes playback queue

import { Audio } from "expo-av";

// ── Config ─────────────────────────────────────────────────────────────────────
const WS_URL = `${(process.env.EXPO_PUBLIC_AI_URL ?? "")
  .replace(/^https/, "wss")
  .replace(/^http/, "ws")}/voice`;

// 30ms recording intervals — matches FRAME_DURATION_MS on backend
const RECORDING_INTERVAL_MS = 30;

// PCM config that matches Vosk's requirements
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: ".pcm",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: 256_000,
  },
  ios: {
    extension: ".caf",
    audioQuality: Audio.IOSAudioQuality.MIN,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: 256_000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type VoiceEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "partial"; text: string }
  | { type: "transcript"; text: string }
  | { type: "thinking" }
  | { type: "tts_start"; sampleRate: number }
  | { type: "tts_end" }
  | { type: "error"; message: string };

export type VoiceListener = (event: VoiceEvent) => void;

// ── Helper: build a data URI from raw PCM bytes for expo-av ──────────────────

function buildWavHeader(numSamples: number, sampleRate = 22_050): ArrayBuffer {
  // 16-bit mono WAV header — 44 bytes
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const dataLen = numSamples * 2; // int16

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true); // file size - 8
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true); // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  return buf;
}

function pcmToWavUri(b64pcm: string, sampleRate = 22_050): string {
  const pcmBin = atob(b64pcm);
  const pcmBytes = new Uint8Array(pcmBin.length);
  for (let i = 0; i < pcmBin.length; i++) {
    pcmBytes[i] = pcmBin.charCodeAt(i);
  }

  const header = buildWavHeader(pcmBytes.length / 2, sampleRate);
  const wav = new Uint8Array(header.byteLength + pcmBytes.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcmBytes, header.byteLength);

  // Build base64 WAV data URI
  let binary = "";
  for (let i = 0; i < wav.byteLength; i++) {
    binary += String.fromCharCode(wav[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

// ── VoiceCallManager ──────────────────────────────────────────────────────────

export class VoiceCallManager {
  private ws: WebSocket | null = null;
  private recording: Audio.Recording | null = null;
  private listener: VoiceListener;
  private ttsQueue: string[] = []; // base64 PCM chunks
  private isPlaying: boolean = false;
  private ttsAborted: boolean = false;
  private ttsSampleRate = 22_050;

  constructor(listener: VoiceListener) {
    this.listener = listener;
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== "granted") {
      this.listener({ type: "error", message: "Microphone permission denied" });
      return;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    });

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      // Server will send { type:"ready" } — wait for that before starting mic
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data as string);

        switch (msg.type) {
          case "ready":
            this.listener({ type: "connected" });
            await this._startMic();
            break;

          case "partial":
            this.listener({ type: "partial", text: msg.text });
            break;

          case "transcript":
            this.listener({ type: "transcript", text: msg.text });
            break;

          case "thinking":
            this.listener({ type: "thinking" });
            break;

          case "tts_start":
            this.ttsSampleRate = msg.sample_rate ?? 22_050;
            this.ttsAborted = false;
            this.ttsQueue = [];
            this.listener({
              type: "tts_start",
              sampleRate: this.ttsSampleRate,
            });
            // Send barge-in if user has been speaking (VAD already flagged it)
            // The backend handles this server-side via the audio stream,
            // but we expose the method so the UI can also trigger it.
            break;

          case "tts_chunk":
            if (!this.ttsAborted) {
              this.ttsQueue.push(msg.data);
              if (!this.isPlaying) {
                this._drainTTS();
              }
            }
            break;

          case "tts_end":
            this.listener({ type: "tts_end" });
            break;

          case "error":
            this.listener({ type: "error", message: msg.message });
            break;
        }
      } catch {
        // Non-JSON or malformed — ignore
      }
    };

    this.ws.onerror = () => {
      this.listener({ type: "error", message: "Connection error" });
    };

    this.ws.onclose = () => {
      this.listener({ type: "disconnected" });
    };
  }

  // ── Barge-in (UI button or programmatic) ─────────────────────────────────

  bargeIn(): void {
    this.ttsAborted = true;
    this.ttsQueue = [];
    this._sendJson({ type: "barge_in" });
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    await this._stopMic();
    if (this.ws) {
      this._sendJson({ type: "end_call" });
      this.ws.close();
      this.ws = null;
    }
    this.ttsQueue = [];
    this.isPlaying = false;
    this.ttsAborted = true;
  }

  // ── Internal: start microphone ────────────────────────────────────────────

  private async _startMic(): Promise<void> {
    if (this.recording) return;

    const { recording } = await Audio.Recording.createAsync(
      RECORDING_OPTIONS,
      undefined,
      RECORDING_INTERVAL_MS,
    );
    this.recording = recording;

    // Read PCM data periodically and send over WebSocket
    // expo-av doesn't give us raw PCM callbacks directly, so we poll the
    // recorded file in chunks every RECORDING_INTERVAL_MS.
    // A more optimal solution would use expo-audio (SDK 52+) with raw PCM
    // callbacks, but this works across Expo SDK versions.
    this._pollMicLoop();
  }

  private _lastBytesSent = 0;

  private async _pollMicLoop(): Promise<void> {
    while (this.recording && this.ws?.readyState === WebSocket.OPEN) {
      await new Promise<void>((r) => setTimeout(r, RECORDING_INTERVAL_MS));

      const uri = this.recording?.getURI();
      if (!uri) continue;

      try {
        const resp = await fetch(uri);
        const buf = await resp.arrayBuffer();
        const allBytes = new Uint8Array(buf);

        if (allBytes.length > this._lastBytesSent) {
          const newBytes = allBytes.slice(this._lastBytesSent);
          this._lastBytesSent = allBytes.length;

          // Encode and send new PCM bytes
          let binary = "";
          for (let i = 0; i < newBytes.length; i++) {
            binary += String.fromCharCode(newBytes[i]);
          }
          this._sendJson({
            type: "audio_chunk",
            data: btoa(binary),
          });
        }
      } catch {
        // File not ready yet — skip
      }
    }
  }

  // ── Internal: stop microphone ─────────────────────────────────────────────

  private async _stopMic(): Promise<void> {
    if (!this.recording) return;
    try {
      await this.recording.stopAndUnloadAsync();
    } catch {}
    this.recording = null;
    this._lastBytesSent = 0;
  }

  // ── Internal: drain TTS playback queue ───────────────────────────────────

  private async _drainTTS(): Promise<void> {
    this.isPlaying = true;

    while (this.ttsQueue.length > 0 && !this.ttsAborted) {
      const b64chunk = this.ttsQueue.shift()!;

      try {
        const wavUri = pcmToWavUri(b64chunk, this.ttsSampleRate);
        const { sound } = await Audio.Sound.createAsync(
          { uri: wavUri },
          { shouldPlay: true, volume: 1.0 },
        );

        await new Promise<void>((resolve) => {
          sound.setOnPlaybackStatusUpdate((status) => {
            if (!status.isLoaded) return;
            if (status.didJustFinish || this.ttsAborted) {
              sound.unloadAsync().catch(() => {});
              resolve();
            }
          });
        });
      } catch (err) {
        console.warn("[VoiceCall] TTS playback error:", err);
      }
    }

    this.isPlaying = false;
  }

  // ── Internal: send JSON frame ─────────────────────────────────────────────

  private _sendJson(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
