# ypn-ai-service/voice_session.py
#
# Per-WebSocket session state.
# Tracks conversation history + VAD state machine.
# Destroyed when the WebSocket closes.

import asyncio
import logging
from dataclasses import dataclass, field
from enum import Enum, auto

import webrtcvad

from audio.vad import (
    SILENCE_FRAMES_THRESHOLD,
    create_vad,
    is_speech,
)
from audio.stt import create_recognizer, feed_frame, finalize
from vosk import KaldiRecognizer

logger = logging.getLogger(__name__)

MAX_HISTORY_TURNS = 12  # 12 user + 12 AI turns kept in memory


class TurnState(Enum):
    IDLE      = auto()   # waiting for speech
    SPEAKING  = auto()   # user is speaking
    SILENCE   = auto()   # trailing silence, about to commit
    THINKING  = auto()   # AI is generating
    REPLYING  = auto()   # AI audio is streaming out


@dataclass
class VoiceSession:
    session_id: str

    # VAD + STT — reset per utterance
    vad:        webrtcvad.Vad    = field(default_factory=create_vad)
    recognizer: KaldiRecognizer  = field(default_factory=create_recognizer)

    # VAD state
    state:          TurnState = TurnState.IDLE
    silence_frames: int       = 0

    # Conversation history
    history: list[dict] = field(default_factory=list)

    # Barge-in: set this to cancel active TTS synthesis
    tts_cancel: asyncio.Event = field(default_factory=asyncio.Event)

    # Raw PCM buffer — accumulates 30ms frames to send to Vosk in order
    _pcm_buffer: bytes = b""

    def reset_for_next_utterance(self) -> None:
        """Call after each completed turn to prepare for next utterance."""
        self.recognizer    = create_recognizer()
        self.silence_frames = 0
        self.state          = TurnState.IDLE
        self._pcm_buffer    = b""
        self.tts_cancel.clear()

    def cancel_tts(self) -> None:
        """Signal TTS synthesis to stop (barge-in)."""
        self.tts_cancel.set()

    def feed_pcm(self, raw_pcm: bytes) -> tuple[str | None, bool]:
        """
        Feed arbitrary bytes of raw PCM.
        Internally splits into 30ms frames and runs VAD + STT.

        Returns:
          (partial_transcript | None, utterance_complete: bool)

        utterance_complete = True when 800ms of silence follows speech.
        """
        from audio.vad import FRAME_BYTES

        self._pcm_buffer += raw_pcm
        partial      = None
        complete     = False

        while len(self._pcm_buffer) >= FRAME_BYTES:
            frame            = self._pcm_buffer[:FRAME_BYTES]
            self._pcm_buffer = self._pcm_buffer[FRAME_BYTES:]

            speech = is_speech(self.vad, frame)

            if speech:
                self.silence_frames = 0
                if self.state == TurnState.IDLE:
                    self.state = TurnState.SPEAKING
                    logger.debug(f"[VAD] {self.session_id[:8]} speech started")

                # Feed to Vosk
                partial_text = feed_frame(self.recognizer, frame)
                if partial_text:
                    partial = partial_text

            else:
                if self.state == TurnState.SPEAKING:
                    self.silence_frames += 1
                    if self.silence_frames >= SILENCE_FRAMES_THRESHOLD:
                        self.state = TurnState.THINKING
                        complete   = True
                        logger.debug(
                            f"[VAD] {self.session_id[:8]} "
                            f"silence threshold reached → commit utterance"
                        )

        return partial, complete

    def finalize_transcript(self) -> str:
        return finalize(self.recognizer)

    def add_user_turn(self, text: str) -> None:
        self.history.append({"role": "user", "content": text})
        self._trim_history()

    def add_ai_turn(self, text: str) -> None:
        self.history.append({"role": "assistant", "content": text})
        self._trim_history()

    def _trim_history(self) -> None:
        limit = MAX_HISTORY_TURNS * 2
        if len(self.history) > limit:
            self.history = self.history[-limit:]