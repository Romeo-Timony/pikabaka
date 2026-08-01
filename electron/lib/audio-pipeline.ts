import { BrowserWindow, systemPreferences } from "electron"
import type { AppState } from "../main"
import { SystemAudioCapture } from "../audio/SystemAudioCapture"
import { MicrophoneCapture } from "../audio/MicrophoneCapture"
import { GoogleSTT } from "../audio/GoogleSTT"
import { RestSTT } from "../audio/RestSTT"
import { DeepgramStreamingSTT } from "../audio/DeepgramStreamingSTT"
import { SonioxStreamingSTT } from "../audio/SonioxStreamingSTT"
import { ElevenLabsStreamingSTT } from "../audio/ElevenLabsStreamingSTT"
import { OpenAIStreamingSTT } from "../audio/OpenAIStreamingSTT"
import {
  TranscriptSpeaker,
  bufferFinalTranscriptChunk,
  emitNativeAudioTranscript,
  emitTranscriptWithTranslation,
  handleSpeakerSpeechEnded,
  isLikelyCrossChannelEcho,
  isMicEchoHoldActive,
  normalizeTranscriptText,
  rememberTranscriptForEchoGuard,
} from "./transcript-assembler"

export type STTProvider = (GoogleSTT | RestSTT | DeepgramStreamingSTT | SonioxStreamingSTT | ElevenLabsStreamingSTT | OpenAIStreamingSTT) & {
  finalize?: () => void;
  setAudioChannelCount?: (count: number) => void;
  notifySpeechEnded?: () => void;
};

async function ensureMacMicrophoneAccess(context: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  try {
    const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Main] macOS microphone permission before ${context}: ${currentStatus}`);

    if (currentStatus === 'granted') {
      return true;
    }

    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log(
      `[Main] macOS microphone permission request during ${context}: ${granted ? 'granted' : 'denied'}`
    );
    return granted;
  } catch (error) {
    console.error(`[Main] Failed to check macOS microphone permission during ${context}:`, error);
    return false;
  }
}

function createGoogleSTTOrFallback(cm: any, speaker: 'interviewer' | 'user'): STTProvider {
  const googlePath = cm.getGoogleServiceAccountPath?.() || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googlePath) {
    console.log(`[Main] Using GoogleSTT for ${speaker}`);
    return new GoogleSTT();
  }

  const openAiKey = cm.getOpenAiSttApiKey?.();
  if (openAiKey) {
    console.warn(`[Main] Google STT credentials missing; falling back to OpenAI STT for ${speaker}`);
    return new OpenAIStreamingSTT(openAiKey);
  }

  console.warn(`[Main] Google STT credentials missing and no OpenAI STT key; using GoogleSTT anyway for ${speaker}`);
  return new GoogleSTT();
}

export function createSTTProvider(appState: AppState, speaker: 'interviewer' | 'user'): STTProvider {
  const state = appState as any;
  const { CredentialsManager } = require('../services/CredentialsManager');
  const cm = CredentialsManager.getInstance();
  const sttProvider = cm.getSttProvider();
  const sttLanguage = cm.getSttLanguage();

  let stt: STTProvider;

  if (sttProvider === 'deepgram') {
    const apiKey = cm.getDeepgramApiKey();
    if (apiKey) {
      console.log(`[Main] Using DeepgramStreamingSTT for ${speaker}`);
      stt = new DeepgramStreamingSTT(apiKey);
    } else {
      console.warn(`[Main] No API key for Deepgram STT, falling back`);
      stt = createGoogleSTTOrFallback(cm, speaker);
    }
  } else if (sttProvider === 'soniox') {
    const apiKey = cm.getSonioxApiKey();
    if (apiKey) {
      console.log(`[Main] Using SonioxStreamingSTT for ${speaker}`);
      stt = new SonioxStreamingSTT(apiKey);
    } else {
      console.warn(`[Main] No API key for Soniox STT, falling back`);
      stt = createGoogleSTTOrFallback(cm, speaker);
    }
  } else if (sttProvider === 'elevenlabs') {
    const apiKey = cm.getElevenLabsApiKey();
    if (apiKey) {
      console.log(`[Main] Using ElevenLabsStreamingSTT for ${speaker}`);
      stt = new ElevenLabsStreamingSTT(apiKey);
    } else {
      console.warn(`[Main] No API key for ElevenLabs STT, falling back`);
      stt = createGoogleSTTOrFallback(cm, speaker);
    }
  } else if (sttProvider === 'openai') {
    const apiKey = cm.getOpenAiSttApiKey();
    if (apiKey) {
      console.log(`[Main] Using OpenAIStreamingSTT (WebSocket+REST fallback) for ${speaker}`);
      stt = new OpenAIStreamingSTT(apiKey);
    } else {
      console.warn(`[Main] No API key for OpenAI STT, falling back`);
      stt = createGoogleSTTOrFallback(cm, speaker);
    }
  } else if (sttProvider === 'groq' || sttProvider === 'azure' || sttProvider === 'ibmwatson') {
    let apiKey: string | undefined;
    let region: string | undefined;
    let modelOverride: string | undefined;

    if (sttProvider === 'groq') {
      apiKey = cm.getGroqSttApiKey();
      modelOverride = cm.getGroqSttModel();
    } else if (sttProvider === 'azure') {
      apiKey = cm.getAzureApiKey();
      region = cm.getAzureRegion();
    } else if (sttProvider === 'ibmwatson') {
      apiKey = cm.getIbmWatsonApiKey();
      region = cm.getIbmWatsonRegion();
    }

    if (apiKey) {
      console.log(`[Main] Using RestSTT (${sttProvider}) for ${speaker}`);
      stt = new RestSTT(sttProvider, apiKey, modelOverride, region);
    } else {
      console.warn(`[Main] No API key for ${sttProvider} STT, falling back`);
      stt = createGoogleSTTOrFallback(cm, speaker);
    }
  } else {
    stt = createGoogleSTTOrFallback(cm, speaker);
  }

  stt.setRecognitionLanguage(sttLanguage);

  stt.on('transcript', (segment: { text: string, isFinal: boolean, confidence: number, detectedLanguage?: string, boundary?: boolean }) => {
    if (!state.isMeetingActive) {
      return;
    }

    const timestamp = Date.now();
    const trimmed = segment.text?.trim();

    // Mark interviewer activity before echo checks so overlapping mic finals see it.
    if (speaker === 'interviewer' && trimmed) {
      state.lastInterviewerTranscriptAt = timestamp;
      state.lastAudioPipelineError = null;
    }

    // Speakers → mic echo: same utterance often lands on both channels.
    // Prefer system/interviewer; drop the echoing mic (or rarer reverse) copy.
    // Also drops garbled mic ASR during/after interviewer (temporal hold).
    if (trimmed && isLikelyCrossChannelEcho(appState, speaker, trimmed, timestamp)) {
      console.log(
        `[Main] Dropping ${speaker} transcript as cross-channel echo: "${trimmed.substring(0, 60)}"`
      );
      if (speaker === 'user') {
        const userBuf = state.transcriptTurnBuffers?.user;
        if (userBuf?.flushTimer) clearTimeout(userBuf.flushTimer);
        if (userBuf) state.transcriptTurnBuffers.user = null;
      }
      return;
    }

    // Boundary-only events (empty text) must not reach intelligence handling
    if (trimmed) {
      state.intelligenceManager.handleTranscript({
        speaker: speaker,
        text: segment.text,
        timestamp,
        final: segment.isFinal,
        confidence: segment.confidence
      });
    }

    const { CredentialsManager } = require('../services/CredentialsManager');
    const displayMode = CredentialsManager.getInstance().getTranscriptTranslationDisplayMode();

    if (segment.isFinal) {
      // Order matters: buffer the text first, then accelerate flushing on boundary
      if (trimmed) {
        bufferFinalTranscriptChunk(appState, speaker, segment.text, timestamp, segment.confidence, segment.detectedLanguage);
        rememberTranscriptForEchoGuard(appState, speaker, trimmed, timestamp);

        // If system audio arrived after a mic echo was buffered, drop the user buffer.
        if (speaker === 'interviewer') {
          const userBuf = state.transcriptTurnBuffers?.user;
          if (userBuf?.text && isLikelyCrossChannelEcho(appState, 'user', userBuf.text, timestamp)) {
            if (userBuf.flushTimer) clearTimeout(userBuf.flushTimer);
            console.log(
              `[Main] Purged buffered user transcript as echo: "${String(userBuf.text).substring(0, 60)}"`
            );
            state.transcriptTurnBuffers.user = null;
          }
        }
      }
      if (segment.boundary) {
        handleSpeakerSpeechEnded(appState, speaker);
      }
    } else if (trimmed) {
      // Track interviewer partials early so mic echo can be matched before the final lands.
      if (speaker === 'interviewer') {
        rememberTranscriptForEchoGuard(appState, speaker, trimmed, timestamp);
      }
      emitNativeAudioTranscript(appState, {
        speaker,
        text: segment.text,
        sourceText: segment.text,
        translatedText: undefined,
        timestamp,
        final: segment.isFinal,
        confidence: segment.confidence,
        displayMode,
        translationState: 'skipped' as const,
        detectedLanguage: segment.detectedLanguage,
      });
    }

  });

  stt.on('error', (err: Error) => {
    console.error(`[Main] STT (${speaker}) Error:`, err);
    state.lastAudioPipelineError = `[${speaker}] ${err.message || 'STT error'}`;
  });

  return stt;
}

export function setupSystemAudioPipeline(appState: AppState): void {
  const state = appState as any;
  try {
    if (!state.systemAudioCapture) {
      state.systemAudioCapture = new SystemAudioCapture();
      state.systemAudioCapture.on('data', (chunk: Buffer) => {
        state.lastSystemAudioChunkAt = Date.now();
        state.googleSTT?.write(chunk);
      });
      state.systemAudioCapture.on('speech_ended', () => {
        state.googleSTT?.notifySpeechEnded?.();
        handleSpeakerSpeechEnded(appState, 'interviewer');
      });
      state.systemAudioCapture.on('error', (err: Error) => {
        console.error('[Main] SystemAudioCapture Error:', err);
        state.lastAudioPipelineError = err.message || 'System audio capture error';
      });
    }

    if (!state.microphoneCapture) {
      state.microphoneCapture = new MicrophoneCapture();
      state.microphoneCapture.on('data', (chunk: Buffer) => {
        // Pause mic→STT while system/interviewer audio is active so speaker bleed
        // is not transcribed as garbled "Me" lines.
        if (isMicEchoHoldActive(appState)) {
          if (!state._micEchoHoldLogged) {
            console.log('[Main] Mic STT paused (echo hold while interviewer/system audio active)');
            state._micEchoHoldLogged = true;
          }
          return;
        }
        if (state._micEchoHoldLogged) {
          console.log('[Main] Mic STT resumed');
          state._micEchoHoldLogged = false;
        }
        state.googleSTT_User?.write(chunk);
      });
      state.microphoneCapture.on('speech_ended', () => {
        state.googleSTT_User?.notifySpeechEnded?.();
        handleSpeakerSpeechEnded(appState, 'user');
      });
      state.microphoneCapture.on('error', (err: Error) => {
        console.error('[Main] MicrophoneCapture Error:', err);
      });
    }

    if (!state.googleSTT) {
      state.googleSTT = createSTTProvider(appState, 'interviewer');
    }

    if (!state.googleSTT_User) {
      state.googleSTT_User = createSTTProvider(appState, 'user');
    }

    const sysRate = state.systemAudioCapture?.getSampleRate() || 48000;
    if (state._verboseLogging) console.log(`[Main] Configuring Interviewer STT to ${sysRate}Hz`);
    state.googleSTT?.setSampleRate(sysRate);
    state.googleSTT?.setAudioChannelCount?.(1);

    const micRate = state.microphoneCapture?.getSampleRate() || 48000;
    if (state._verboseLogging) console.log(`[Main] Configuring User STT to ${micRate}Hz`);
    state.googleSTT_User?.setSampleRate(micRate);
    state.googleSTT_User?.setAudioChannelCount?.(1);

    if (state._verboseLogging) console.log('[Main] Full Audio Pipeline (System + Mic) Initialized (Ready)');

  } catch (err) {
    console.error('[Main] Failed to setup System Audio Pipeline:', err);
  }
}

export async function startAudioTest(appState: AppState, deviceId?: string): Promise<{ fallbackUsed: boolean }> {
  const state = appState as any;
  if (state._audioTestStarting) return { fallbackUsed: false };
  state._audioTestStarting = true;
  try {
    return await _startAudioTestImpl(appState, deviceId);
  } finally {
    state._audioTestStarting = false;
  }
}

export function attachAudioTestListeners(appState: AppState, capture: MicrophoneCapture): void {
  capture.on('data', (chunk: Buffer) => {
    const targets = [
      appState.settingsWindowHelper.getSettingsWindow(),
      appState.getWindowHelper().getLauncherWindow(),
      appState.getWindowHelper().getOverlayWindow(),
    ].filter((win): win is BrowserWindow => !!win && !win.isDestroyed());

    if (targets.length === 0) return;

    let sum = 0;
    const step = 10;
    const len = chunk.length;

    for (let i = 0; i < len; i += 2 * step) {
      const val = chunk.readInt16LE(i);
      sum += val * val;
    }

    const count = len / (2 * step);
    if (count > 0) {
      const rms = Math.sqrt(sum / count);
      const level = Math.min(rms / 10000, 1.0);
      for (const target of targets) {
        target.webContents.send('audio-test-level', level);
      }
    }
  });

  capture.on('error', (err: Error) => {
    console.error('[Main] AudioTest Error:', err);
  });
}

export async function _startAudioTestImpl(appState: AppState, deviceId?: string): Promise<{ fallbackUsed: boolean }> {
  const state = appState as any;
  console.log(`[Main] Starting Audio Test on device: ${deviceId || 'default'}`);
  stopAudioTest(appState);

  if (!(await ensureMacMicrophoneAccess('audio test'))) {
    throw new Error('Microphone access denied. Please allow microphone access in System Settings and try again.');
  }

  try {
    state.audioTestCapture = new MicrophoneCapture(deviceId || undefined);
    attachAudioTestListeners(appState, state.audioTestCapture);
    state.audioTestCapture.start();
    return { fallbackUsed: false };
  } catch (err) {
    console.warn('[Main] Failed to start audio test on preferred device. Falling back to default.', err);
    try { state.audioTestCapture?.stop(); } catch { }
    state.audioTestCapture = null;
    try {
      state.audioTestCapture = new MicrophoneCapture();
      attachAudioTestListeners(appState, state.audioTestCapture);
      state.audioTestCapture.start();
      return { fallbackUsed: true };
    } catch (fallbackErr) {
      console.error('[Main] Failed to start audio test:', fallbackErr);
      throw fallbackErr;
    }
  }
}

export function stopAudioTest(appState: AppState): void {
  const state = appState as any;
  if (state.audioTestCapture) {
    console.log('[Main] Stopping Audio Test');
    state.audioTestCapture.stop();
    state.audioTestCapture = null;
  }
}

export function finalizeMicSTT(appState: AppState): void {
  const state = appState as any;
  if (state.googleSTT_User?.finalize) {
    console.log('[Main] Finalizing STT');
    state.googleSTT_User.finalize();
  }
  handleSpeakerSpeechEnded(appState, 'user');
}

export async function translateTranscriptSegment(appState: AppState, segment: {
  segmentId: string;
  text: string;
  speaker?: TranscriptSpeaker;
  speakerLabel?: string;
  timestamp?: number;
}): Promise<{ success: boolean; error?: string; translatedText?: string }> {
  const text = normalizeTranscriptText(appState, segment.text);
  if (!segment.segmentId || !text) {
    return { success: false, error: 'Missing transcript segment data' };
  }

  return emitTranscriptWithTranslation(appState, {
    speaker: segment.speaker || 'interviewer',
    text,
    timestamp: segment.timestamp ?? Date.now(),
    confidence: 1,
    segmentId: segment.segmentId,
    speakerLabel: segment.speakerLabel,
    forceTranslate: true,
  });
}

export function getNativeAudioStatus(appState: AppState): {
  connected: boolean;
  meetingActive: boolean;
  hasRecentSystemAudioChunk: boolean;
  hasRecentInterviewerTranscript: boolean;
  lastSystemAudioChunkAt: number | null;
  lastInterviewerTranscriptAt: number | null;
  lastError: string | null;
} {
  const state = appState as any;
  const now = Date.now();
  // Native VAD suppresses silence, so gaps between speech are normal — keep a wide window.
  const hasRecentSystemAudioChunk =
    state.lastSystemAudioChunkAt != null && now - state.lastSystemAudioChunkAt < 30_000;
  const hasRecentInterviewerTranscript =
    state.lastInterviewerTranscriptAt != null && now - state.lastInterviewerTranscriptAt < 30_000;

  return {
    connected: state.isMeetingActive && !!state.systemAudioCapture && !!state.googleSTT,
    meetingActive: state.isMeetingActive,
    hasRecentSystemAudioChunk,
    hasRecentInterviewerTranscript,
    lastSystemAudioChunkAt: state.lastSystemAudioChunkAt,
    lastInterviewerTranscriptAt: state.lastInterviewerTranscriptAt,
    lastError: state.lastAudioPipelineError,
  };
}
