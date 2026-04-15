import AudioRecord from "react-native-audio-record";

type AudioStreamConfig = {
  websocket: WebSocket;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioSource?: number;
};

export class AudioStream {
  private websocket: WebSocket;
  private isStreaming: boolean = false;

  constructor(config: AudioStreamConfig) {
    this.websocket = config.websocket;

    AudioRecord.init({
      sampleRate: config.sampleRate ?? 16000,
      channels: config.channels ?? 1,
      bitsPerSample: config.bitsPerSample ?? 16,
      audioSource: config.audioSource ?? 6,
      wavFile: "stream.wav",
    });
  }

  start() {
    this.isStreaming = true;

    AudioRecord.start();

    AudioRecord.on("data", (data: string) => {
      if (!this.isStreaming) return;
      if (this.websocket.readyState !== 1) return;

      // base64 PCM chunk from native module
      this.websocket.send(
        JSON.stringify({
          type: "audio",
          audio: data,
        }),
      );
    });
  }

  stop() {
    this.isStreaming = false;
    AudioRecord.stop();
  }

  pause() {
    this.isStreaming = false;
    AudioRecord.pause && AudioRecord.pause();
  }

  resume() {
    this.isStreaming = true;
    AudioRecord.resume && AudioRecord.resume();
  }
}
