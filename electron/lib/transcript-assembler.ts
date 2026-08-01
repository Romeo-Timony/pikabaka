import type { AppState } from "../main"
import { CredentialsManager } from "../services/CredentialsManager"
import { isTranscriptTranslationConfigured, isSameLanguage } from "../transcript/translationExecutor"

export type TranscriptSpeaker = 'interviewer' | 'user';

export interface BufferedTranscriptTurn {
  segmentId: string;
  startedAt: number;
  lastUpdatedAt: number;
  confidence: number;
  text: string;
  flushTimer: NodeJS.Timeout | null;
  detectedLanguage?: string;
  revision: number;
}

export interface FlushedTranscriptTurn {
  segmentId: string;
  text: string;
  startedAt: number;
  lastUpdatedAt: number;   // timestamp of last merged chunk
  flushedAt: number;       // Date.now() at flush
  confidence: number;
  detectedLanguage?: string;
  revision: number;        // revision already emitted
  endedSentence: boolean;
  ragFed: boolean;
  sealTimer: NodeJS.Timeout | null;
}

export type TranscriptAssemblerProfile = 'sentence_bias' | 'low_latency' | 'coherent';

export interface TranscriptAssemblerThresholds {
  maxSilenceBeforeNewTurnMs: number;
  sentenceFlushDelayMs: number;
  fragmentFlushDelayMs: number;
  speechEndedSentenceFlushMs: number;
  speechEndedFragmentFlushMs: number;
  /** Minimum word count before a sentence-ending can trigger the shorter flush delay.
   *  Segments with fewer words use fragmentFlushDelayMs even if they end with punctuation. */
  minWordsBeforeSentenceFlush: number;
  maxTurnDurationMs: number;
  /** How long (from lastUpdatedAt) a flushed non-sentence-final turn stays reopenable. */
  reopenWindowMs: number;
}

export const DEFAULT_TRANSCRIPT_ASSEMBLER_PROFILE: TranscriptAssemblerProfile = 'sentence_bias';

const TRANSCRIPT_ASSEMBLER_THRESHOLDS: Record<TranscriptAssemblerProfile, TranscriptAssemblerThresholds> = {
  sentence_bias: {
    maxSilenceBeforeNewTurnMs: 3200,
    sentenceFlushDelayMs: 1350,
    fragmentFlushDelayMs: 2600,
    speechEndedSentenceFlushMs: 260,
    speechEndedFragmentFlushMs: 1100,
    minWordsBeforeSentenceFlush: 18,
    maxTurnDurationMs: 0,
    reopenWindowMs: 6500,
  },
  low_latency: {
    maxSilenceBeforeNewTurnMs: 3200,
    sentenceFlushDelayMs: 1100,
    fragmentFlushDelayMs: 2000,
    speechEndedSentenceFlushMs: 200,
    speechEndedFragmentFlushMs: 700,
    // Avoid flushing mid-thought when STT inserts an early period.
    minWordsBeforeSentenceFlush: 14,
    maxTurnDurationMs: 0,
    reopenWindowMs: 6500,
  },
  coherent: {
    maxSilenceBeforeNewTurnMs: 6000,
    sentenceFlushDelayMs: 2500,
    fragmentFlushDelayMs: 5000,
    speechEndedSentenceFlushMs: 400,
    speechEndedFragmentFlushMs: 1500,
    minWordsBeforeSentenceFlush: 10,
    maxTurnDurationMs: 30000,
    reopenWindowMs: 9500,
  },
};

export function isTranscriptAssemblerProfile(value: unknown): value is TranscriptAssemblerProfile {
  return value === 'sentence_bias' || value === 'low_latency' || value === 'coherent';
}

export function getTranscriptAssemblerThresholds(appState: AppState): TranscriptAssemblerThresholds {
  const profile = isTranscriptAssemblerProfile(appState.transcriptAssemblerProfile)
    ? appState.transcriptAssemblerProfile
    : DEFAULT_TRANSCRIPT_ASSEMBLER_PROFILE;
  return TRANSCRIPT_ASSEMBLER_THRESHOLDS[profile];
}

export function emitNativeAudioTranscript(appState: AppState, payload: any): void {
  const helper = appState.getWindowHelper();
  helper.getLauncherWindow()?.webContents.send('native-audio-transcript', payload);
  helper.getOverlayWindow()?.webContents.send('native-audio-transcript', payload);
}

export function createTranscriptSegmentId(appState: AppState, speaker: TranscriptSpeaker, timestamp: number): string {
  void appState;
  const prefix = speaker === 'user' ? 'user' : 'seg';
  return `${prefix}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTranscriptText(appState: AppState, text: string): string {
  void appState;
  return text.replace(/\s+/g, ' ').trim();
}

/** Window for cross-channel acoustic echo (speakers → mic) suppression. */
const ECHO_GUARD_WINDOW_MS = 15_000;
const ECHO_GUARD_MIN_CHARS = 10;
const ECHO_GUARD_SIMILARITY = 0.62;
/** If this fraction of the shorter utterance's words appear in the longer one, treat as echo. */
const ECHO_GUARD_COVERAGE = 0.75;
const ECHO_GUARD_MAX_ENTRIES = 16;
/** Mute mic STT while loopback audio is flowing (plus brief tail for room echo). */
const MIC_ECHO_HOLD_AFTER_SYSTEM_MS = 1400;
/** Drop mic transcripts shortly after interviewer STT — ASR often garbles speaker bleed. */
const MIC_ECHO_HOLD_AFTER_INTERVIEWER_MS = 2200;

interface EchoGuardEntry {
  normalized: string;
  at: number;
}

function ensureEchoGuard(state: any): Record<TranscriptSpeaker, EchoGuardEntry[]> {
  if (!state.recentTranscriptEchoGuard) {
    state.recentTranscriptEchoGuard = { interviewer: [], user: [] };
  }
  return state.recentTranscriptEchoGuard;
}

export function normalizeForEchoCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similarity for echo detection: Dice + containment + coverage of the shorter side. */
export function transcriptTextSimilarity(a: string, b: string): number {
  const left = normalizeForEchoCompare(a);
  const right = normalizeForEchoCompare(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftWords = left.split(' ').filter(Boolean);
  const rightWords = right.split(' ').filter(Boolean);
  if (!leftWords.length || !rightWords.length) return 0;

  // Substring containment (handles "short mic echo" vs "longer system transcript")
  if (left.includes(right) || right.includes(left)) {
    const shorterChars = Math.min(left.length, right.length);
    const longerChars = Math.max(left.length, right.length);
    if (shorterChars >= ECHO_GUARD_MIN_CHARS) {
      return Math.max(0.9, shorterChars / longerChars);
    }
  }

  const setA = new Set(leftWords);
  let inter = 0;
  for (const w of rightWords) {
    if (setA.has(w)) inter += 1;
  }
  const dice = (2 * inter) / (leftWords.length + rightWords.length);
  const coverage = inter / Math.min(leftWords.length, rightWords.length);
  if (coverage >= ECHO_GUARD_COVERAGE && Math.min(leftWords.length, rightWords.length) >= 4) {
    return Math.max(dice, coverage);
  }
  return dice;
}

/**
 * True while speakers/interviewer are active — mic is hearing the same room audio.
 * Used to pause mic→STT and drop garbled "Me" finals that do not text-match interviewer.
 */
export function isMicEchoHoldActive(appState: AppState, now = Date.now()): boolean {
  const state = appState as any;
  const sysAt = state.lastSystemAudioChunkAt as number | null | undefined;
  if (sysAt != null && now - sysAt < MIC_ECHO_HOLD_AFTER_SYSTEM_MS) return true;

  const intAt = state.lastInterviewerTranscriptAt as number | null | undefined;
  if (intAt != null && now - intAt < MIC_ECHO_HOLD_AFTER_INTERVIEWER_MS) return true;

  const interviewerBuffer = state.transcriptTurnBuffers?.interviewer as BufferedTranscriptTurn | null;
  if (
    interviewerBuffer?.lastUpdatedAt &&
    now - interviewerBuffer.lastUpdatedAt < MIC_ECHO_HOLD_AFTER_INTERVIEWER_MS
  ) {
    return true;
  }

  return false;
}

/**
 * Detect acoustic echo: system audio played on speakers is often re-captured by the mic.
 * Only suppress the microphone (`user`) copy — never drop interviewer/system audio.
 */
export function isLikelyCrossChannelEcho(
  appState: AppState,
  speaker: TranscriptSpeaker,
  text: string,
  now = Date.now()
): boolean {
  if (speaker !== 'user') return false;

  // Temporal gate catches ASR hallucinations of speaker bleed (text won't match).
  if (isMicEchoHoldActive(appState, now)) return true;

  const normalized = normalizeForEchoCompare(text);
  if (normalized.length < ECHO_GUARD_MIN_CHARS) return false;

  const state = appState as any;
  const guard = ensureEchoGuard(state);
  const recent = (guard.interviewer || []).filter((e) => now - e.at <= ECHO_GUARD_WINDOW_MS);
  guard.interviewer = recent;

  const interviewerBuffer = state.transcriptTurnBuffers?.interviewer as BufferedTranscriptTurn | null;
  const interviewerFlushed = state.lastFlushedTranscriptTurns?.interviewer as FlushedTranscriptTurn | null;
  const candidates = [
    ...recent.map((e) => e.normalized),
    interviewerBuffer?.text,
    interviewerFlushed?.text,
  ].filter((t): t is string => !!t && t.trim().length >= ECHO_GUARD_MIN_CHARS);

  for (const candidate of candidates) {
    if (transcriptTextSimilarity(normalized, candidate) >= ECHO_GUARD_SIMILARITY) {
      return true;
    }
  }
  return false;
}

export function rememberTranscriptForEchoGuard(
  appState: AppState,
  speaker: TranscriptSpeaker,
  text: string,
  now = Date.now()
): void {
  const normalized = normalizeForEchoCompare(text);
  if (normalized.length < ECHO_GUARD_MIN_CHARS) return;

  const state = appState as any;
  const guard = ensureEchoGuard(state);
  const list = (guard[speaker] || []).filter((e) => now - e.at <= ECHO_GUARD_WINDOW_MS);
  list.push({ normalized, at: now });
  while (list.length > ECHO_GUARD_MAX_ENTRIES) list.shift();
  guard[speaker] = list;
}

export function endsSentence(appState: AppState, text: string): boolean {
  void appState;
  return /[.!?。！？…]["')\]]?\s*$/.test(text.trim());
}

export function shouldReopenFlushedTurn(
  flushed: Pick<FlushedTranscriptTurn, 'endedSentence' | 'lastUpdatedAt' | 'startedAt'>,
  timestamp: number,
  thresholds: TranscriptAssemblerThresholds
): boolean {
  if (flushed.endedSentence) return false;
  if (thresholds.reopenWindowMs <= 0) return false;
  if (timestamp - flushed.lastUpdatedAt > thresholds.reopenWindowMs) return false;
  if (thresholds.maxTurnDurationMs > 0 && timestamp - flushed.startedAt > thresholds.maxTurnDurationMs) return false;
  return true;
}

export function countTranscriptWords(appState: AppState, text: string): number {
  void appState;
  const cjkMatches = text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const remaining = text.replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g, ' ').trim();
  const wordCount = remaining ? remaining.split(/\s+/).length : 0;
  return cjkCount + wordCount;
}

export function sealFlushedTranscriptTurn(appState: AppState, speaker: TranscriptSpeaker): void {
  const state = appState as any;
  const flushed = state.lastFlushedTranscriptTurns[speaker] as FlushedTranscriptTurn | null;
  if (!flushed) return;
  if (flushed.sealTimer) {
    clearTimeout(flushed.sealTimer);
    flushed.sealTimer = null;
  }
  if (!flushed.ragFed) {
    flushed.ragFed = true;
    if (state.ragManager) {
      state.ragManager.feedLiveTranscript([{
        speaker,
        text: flushed.text,
        timestamp: flushed.startedAt,
      }]);
    }
    if (speaker === 'interviewer') {
      state.knowledgeOrchestrator?.feedInterviewerUtterance?.(flushed.text);
    }
  }
  state.lastFlushedTranscriptTurns[speaker] = null;
}

export function mergeTranscriptText(appState: AppState, existing: string, incoming: string): string {
  const left = normalizeTranscriptText(appState, existing);
  const right = normalizeTranscriptText(appState, incoming);

  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  if (right.startsWith(left)) return right;
  if (left.endsWith(right)) return left;

  const leftWords = left.split(/\s+/);
  const rightWords = right.split(/\s+/);
  const maxOverlap = Math.min(12, leftWords.length, rightWords.length);

  for (let overlap = maxOverlap; overlap >= 3; overlap -= 1) {
    const leftTail = leftWords.slice(-overlap).join(' ').toLowerCase();
    const rightHead = rightWords.slice(0, overlap).join(' ').toLowerCase();
    if (leftTail === rightHead) {
      return `${leftWords.join(' ')} ${rightWords.slice(overlap).join(' ')}`.trim();
    }
  }

  const CJK_EDGE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯　-〿！-～]/;
  if (CJK_EDGE.test(left.slice(-1)) && CJK_EDGE.test(right.charAt(0))) {
    return `${left}${right}`.trim();
  }

  const separator = /[\s([{"'-]$/.test(left) ? '' : ' ';
  return `${left}${separator}${right}`.trim();
}

export function scheduleBufferedTranscriptFlush(appState: AppState, speaker: TranscriptSpeaker, delayMs: number): void {
  const state = appState as any;
  const buffer = state.transcriptTurnBuffers[speaker] as BufferedTranscriptTurn | null;
  if (!buffer) return;
  if (buffer.flushTimer) {
    clearTimeout(buffer.flushTimer);
  }
  buffer.flushTimer = setTimeout(() => {
    void flushBufferedTranscriptTurn(appState, speaker);
  }, delayMs);
}

export function bufferFinalTranscriptChunk(
  appState: AppState,
  speaker: TranscriptSpeaker,
  text: string,
  timestamp: number,
  confidence: number,
  detectedLanguage?: string
): void {
  const state = appState as any;
  const thresholds = getTranscriptAssemblerThresholds(appState);
  const normalizedText = normalizeTranscriptText(appState, text);
  if (!normalizedText) return;

  let buffer = state.transcriptTurnBuffers[speaker] as BufferedTranscriptTurn | null;
  if (buffer && timestamp - buffer.lastUpdatedAt > thresholds.maxSilenceBeforeNewTurnMs) {
    void flushBufferedTranscriptTurn(appState, speaker);
    buffer = null;
  }

  if (buffer && thresholds.maxTurnDurationMs > 0 && timestamp - buffer.startedAt > thresholds.maxTurnDurationMs) {
    void flushBufferedTranscriptTurn(appState, speaker);
    buffer = null;
  }

  if (!buffer) {
    const lf = state.lastFlushedTranscriptTurns[speaker] as FlushedTranscriptTurn | null;
    if (lf && shouldReopenFlushedTurn(lf, timestamp, thresholds)) {
      if (lf.sealTimer) clearTimeout(lf.sealTimer);
      buffer = {
        segmentId: lf.segmentId, startedAt: lf.startedAt, lastUpdatedAt: lf.lastUpdatedAt,
        confidence: lf.confidence, text: lf.text, flushTimer: null,
        detectedLanguage: lf.detectedLanguage, revision: lf.revision + 1,
      };
      state.transcriptTurnBuffers[speaker] = buffer;
      state.lastFlushedTranscriptTurns[speaker] = null;
    } else if (lf) {
      sealFlushedTranscriptTurn(appState, speaker); // superseded: feed RAG now, clear slot
    }
  }

  if (!buffer) {
    buffer = {
      segmentId: createTranscriptSegmentId(appState, speaker, timestamp),
      startedAt: timestamp,
      lastUpdatedAt: timestamp,
      confidence,
      text: normalizedText,
      flushTimer: null,
      detectedLanguage,
      revision: 1,
    };
    state.transcriptTurnBuffers[speaker] = buffer;
  } else {
    buffer.text = mergeTranscriptText(appState, buffer.text, normalizedText);
    buffer.lastUpdatedAt = timestamp;
    buffer.confidence = Math.max(buffer.confidence, confidence);
    if (detectedLanguage) buffer.detectedLanguage = detectedLanguage;
  }

  const wordCount = countTranscriptWords(appState, buffer.text);
  const isSentenceComplete = endsSentence(appState, buffer.text) && wordCount >= thresholds.minWordsBeforeSentenceFlush;
  const flushDelayMs = isSentenceComplete
    ? thresholds.sentenceFlushDelayMs
    : thresholds.fragmentFlushDelayMs;
  scheduleBufferedTranscriptFlush(appState, speaker, flushDelayMs);
}

export function handleSpeakerSpeechEnded(appState: AppState, speaker: TranscriptSpeaker): void {
  const state = appState as any;
  const buffer = state.transcriptTurnBuffers[speaker] as BufferedTranscriptTurn | null;
  if (!buffer) return;
  const thresholds = getTranscriptAssemblerThresholds(appState);
  const wordCount = countTranscriptWords(appState, buffer.text);
  const isSentenceComplete = endsSentence(appState, buffer.text) && wordCount >= thresholds.minWordsBeforeSentenceFlush;
  scheduleBufferedTranscriptFlush(
    appState,
    speaker,
    isSentenceComplete
      ? thresholds.speechEndedSentenceFlushMs
      : thresholds.speechEndedFragmentFlushMs
  );
}

export function resetBufferedTranscriptTurns(appState: AppState): void {
  const state = appState as any;
  for (const speaker of Object.keys(state.transcriptTurnBuffers) as TranscriptSpeaker[]) {
    const buffer = state.transcriptTurnBuffers[speaker] as BufferedTranscriptTurn | null;
    if (buffer?.flushTimer) {
      clearTimeout(buffer.flushTimer);
    }
    state.transcriptTurnBuffers[speaker] = null;
    sealFlushedTranscriptTurn(appState, speaker);
  }
  state.transcriptSegmentRevisions.clear();
  state.recentTranslatedTurns.length = 0;
  state.recentTranscriptEchoGuard = { interviewer: [], user: [] };
}

export async function flushBufferedTranscriptTurn(appState: AppState, speaker: TranscriptSpeaker): Promise<void> {
  const state = appState as any;
  const buffer = state.transcriptTurnBuffers[speaker] as BufferedTranscriptTurn | null;
  if (!buffer) return;

  if (buffer.flushTimer) {
    clearTimeout(buffer.flushTimer);
  }
  state.transcriptTurnBuffers[speaker] = null;

  const text = normalizeTranscriptText(appState, buffer.text);
  if (!text) return;

  const timestamp = buffer.startedAt || Date.now();
  const confidence = buffer.confidence || 0;
  const thresholds = getTranscriptAssemblerThresholds(appState);
  const endedSentence = endsSentence(appState, text);

  state.transcriptSegmentRevisions.set(buffer.segmentId, buffer.revision);

  if (endedSentence) {
    if (state.ragManager) {
      state.ragManager.feedLiveTranscript([{
        speaker,
        text,
        timestamp,
      }]);
    }
    if (speaker === 'interviewer') {
      state.knowledgeOrchestrator?.feedInterviewerUtterance?.(text);
    }
    state.lastFlushedTranscriptTurns[speaker] = null;
  } else {
    const flushed: FlushedTranscriptTurn = {
      segmentId: buffer.segmentId,
      text,
      startedAt: buffer.startedAt,
      lastUpdatedAt: buffer.lastUpdatedAt,
      flushedAt: Date.now(),
      confidence,
      detectedLanguage: buffer.detectedLanguage,
      revision: buffer.revision,
      endedSentence: false,
      ragFed: false,
      sealTimer: null,
    };
    const delay = Math.max(500, thresholds.reopenWindowMs - (Date.now() - buffer.lastUpdatedAt));
    flushed.sealTimer = setTimeout(() => sealFlushedTranscriptTurn(appState, speaker), delay);
    state.lastFlushedTranscriptTurns[speaker] = flushed;
  }

  if (speaker === 'interviewer') {
    await emitTranscriptWithTranslation(appState, {
      speaker,
      text,
      timestamp,
      confidence,
      segmentId: buffer.segmentId,
      detectedLanguage: buffer.detectedLanguage,
      revision: buffer.revision,
    });
    return;
  }

  const displayMode = CredentialsManager.getInstance().getTranscriptTranslationDisplayMode();
  emitNativeAudioTranscript(appState, {
    speaker,
    text,
    sourceText: text,
    translatedText: undefined,
    segmentId: buffer.segmentId,
    timestamp,
    final: true,
    confidence,
    displayMode,
    translationState: 'skipped' as const,
    speakerLabel: 'Me',
    revision: buffer.revision,
  });
}

export async function emitTranscriptWithTranslation(appState: AppState, params: {
  speaker: TranscriptSpeaker;
  text: string;
  timestamp: number;
  confidence: number;
  segmentId: string;
  speakerLabel?: string;
  forceTranslate?: boolean;
  detectedLanguage?: string;
  revision?: number;
}): Promise<{ success: boolean; error?: string; translatedText?: string }> {
  const state = appState as any;
  const { speaker, text, timestamp, confidence, segmentId, speakerLabel, forceTranslate = false, detectedLanguage, revision } = params;
  const { CredentialsManager } = require('../services/CredentialsManager');
  const cm = CredentialsManager.getInstance();
  const displayMode = cm.getTranscriptTranslationDisplayMode();
  const translationEnabled = cm.getTranscriptTranslationEnabled();
  const translationModelRaw = cm.getTranscriptTranslationModel();
  const translationProvider = cm.getTranscriptTranslationProvider();
  const translationPrompt = cm.getTranscriptTranslationPrompt();
  const standardProviders = new Set(['ollama', 'gemini', 'groq', 'openai', 'claude']);
  const oaiCompat = cm.getOpenAICompatibleProviders().find(
    (p: { id: string }) => p.id === translationProvider
  );
  const effectiveTranslationModel =
    translationModelRaw.trim() || (oaiCompat?.preferredModel?.trim() ?? '');
  const shouldTranslate = forceTranslate ? true : translationEnabled;
  const isTranslationConfigured =
    isTranscriptTranslationConfigured(shouldTranslate, effectiveTranslationModel, translationPrompt) &&
    (standardProviders.has(translationProvider) ? true : !!oaiCompat);

  const pendingPayload: {
    speaker: TranscriptSpeaker;
    text: string;
    sourceText: string;
    translatedText?: string;
    segmentId: string;
    timestamp: number;
    final: true;
    confidence: number;
    displayMode: 'original' | 'translated' | 'both';
    translationState: 'pending' | 'skipped';
    speakerLabel?: string;
    revision?: number;
  } = {
    speaker,
    text,
    sourceText: text,
    translatedText: undefined,
    segmentId,
    timestamp,
    final: true,
    confidence,
    displayMode,
    translationState: isTranslationConfigured ? 'pending' as const : 'skipped' as const,
    speakerLabel,
    revision,
  };

  if (!isTranslationConfigured) {
    emitNativeAudioTranscript(
      appState,
      forceTranslate
        ? { ...pendingPayload, translationState: 'error' as const }
        : pendingPayload
    );
    return forceTranslate
      ? { success: false, error: 'Transcript translation is not configured. Set a provider and model first.' }
      : { success: true };
  }

  const targetLanguageKey = cm.getTranscriptTranslationTargetLanguage();
  const sourceLanguageKey = cm.getTranscriptTranslationSourceLanguage();
  const effectiveSource = detectedLanguage || (sourceLanguageKey && sourceLanguageKey !== 'auto' ? sourceLanguageKey : undefined);
  if (effectiveSource && isSameLanguage(effectiveSource, targetLanguageKey)) {
    const translatedPayloadText = displayMode === 'translated' ? text : text;
    emitNativeAudioTranscript(appState, {
      speaker,
      text: translatedPayloadText,
      sourceText: text,
      translatedText: text,
      segmentId,
      timestamp,
      final: true,
      confidence,
      displayMode,
      translationState: 'complete' as const,
      speakerLabel,
      detectedLanguage,
      revision,
    });
    return { success: true, translatedText: text };
  }

  emitNativeAudioTranscript(appState, pendingPayload);

  try {
    const recentTurns = (state.recentTranslatedTurns ?? []) as Array<{ segmentId: string; source: string; translation: string }>;
    const context = recentTurns
      .filter((t) => t.segmentId !== segmentId)
      .slice(-2)
      .map((t) => ({ source: t.source, translation: t.translation }));
    const baseReq = {
      model: effectiveTranslationModel,
      prompt: translationPrompt,
      sourceText: text,
      ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
      sourceLanguageKey,
      targetLanguageKey,
      detectedLanguageKey: detectedLanguage,
      context: context.length > 0 ? context : undefined,
    };
    let translatedText: string;
    if (oaiCompat && !standardProviders.has(translationProvider)) {
      translatedText = await state.processingHelper.getLLMHelper().translateTranscriptText({
        ...baseReq,
        provider: 'openai-compatible',
        openAICompatible: { baseUrl: oaiCompat.baseUrl, apiKey: oaiCompat.apiKey },
      });
    } else {
      translatedText = await state.processingHelper.getLLMHelper().translateTranscriptText({
        ...baseReq,
        provider: translationProvider as 'ollama' | 'gemini' | 'groq' | 'openai' | 'claude',
      });
    }

    if (revision !== undefined && state.transcriptSegmentRevisions.get(segmentId) !== revision) {
      return { success: false, error: 'superseded by newer revision' };
    }

    if (translatedText) {
      const existingIndex = recentTurns.findIndex((t) => t.segmentId === segmentId);
      if (existingIndex >= 0) {
        recentTurns[existingIndex] = { segmentId, source: text, translation: translatedText };
      } else {
        recentTurns.push({ segmentId, source: text, translation: translatedText });
      }
      while (recentTurns.length > 4) {
        recentTurns.shift();
      }
    }

    const translatedPayloadText =
      displayMode === 'translated' ? (translatedText || text) : text;

    emitNativeAudioTranscript(appState, {
      speaker,
      text: translatedPayloadText,
      sourceText: text,
      translatedText: translatedText || undefined,
      segmentId,
      timestamp,
      final: true,
      confidence,
      displayMode,
      translationState: 'complete' as const,
      speakerLabel,
      detectedLanguage,
      revision,
    });
    return { success: true, translatedText: translatedText || undefined };
  } catch (error: any) {
    console.warn('[Main] Transcript translation failed:', error?.message || error);
    if (revision !== undefined && state.transcriptSegmentRevisions.get(segmentId) !== revision) {
      return { success: false, error: 'superseded by newer revision' };
    }
    emitNativeAudioTranscript(appState, {
      speaker,
      text,
      sourceText: text,
      translatedText: undefined,
      segmentId,
      timestamp,
      final: true,
      confidence,
      displayMode,
      translationState: 'error' as const,
      speakerLabel,
      detectedLanguage,
      revision,
    });
    return { success: false, error: error?.message || 'Transcript translation failed' };
  }
}
