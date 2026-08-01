/**
 * OpenAIStreamingSTT - WebSocket-first, REST-fallback Speech-to-Text for OpenAI
 *
 * Priority chain (automatic, with audio buffering during transitions):
 *   1. Realtime GA session (gpt-realtime-1.5) + input transcription gpt-4o-transcribe
 *   2. Same session + gpt-4o-mini-transcribe
 *   3. Same session + gpt-live-transcribe
 *   4. REST API → whisper-1 (client VAD flush)
 *
 * GA requires a realtime model in the WebSocket URL. Transcription models belong in
 * session.audio.input.transcription.model — never in ?model=.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import axios from 'axios';
import FormData from 'form-data';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { normalizeLanguageToIso639 } from '../transcript/translationExecutor';

// ─── Constants ────────────────────────────────────────────────────────────────

const REALTIME_WS_BASE = 'wss://api.openai.com/v1/realtime';
/** Required realtime session model for the WebSocket URL / session.model */
const REALTIME_SESSION_MODEL = 'gpt-realtime-1.5';
const REST_ENDPOINT   = 'https://api.openai.com/v1/audio/transcriptions';

/** Input-audio transcription models (NOT valid as ?model= on the WS URL) */
const WS_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-live-transcribe'] as const;
type WsModel = typeof WS_MODELS[number];

/** Max consecutive WebSocket failures before advancing to next model / REST */
const MAX_WS_FAILURES_PER_MODEL = 2;

/** Errors that mean the current WS approach cannot work — skip retries and fall through */
const FATAL_WS_ERROR_PATTERNS = [
    /no longer supported/i,
    /realtime beta/i,
    /not allowed/i,
    /cannot be used as the realtime session model/i,
    /model_not_found/i,
    /does not exist/i,
    /incorrect api key/i,
    /invalid api key/i,
    /authentication/i,
    /must provide a model/i,
    /turn detection is not supported/i,
];

/** Exponential backoff reconnect delays */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 30_000;

/** Keep-alive ping interval (ms) — prevents idle disconnects */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** Rolling audio ring-buffer: sized for worst-case raw INPUT audio (48kHz stereo 16-bit × 30s).
 *  The ring buffer stores PRE-RESAMPLED chunks from write(), not the 24kHz WS output. */
const MAX_RING_BUFFER_BYTES = 48_000 * 2 * 2 * 30; // 5 760 000 bytes (48kHz stereo × 16-bit × 30s)

/** REST safety-net flush interval when in REST fallback mode */
const REST_SAFETY_NET_MS = 10_000;

/** Minimum buffered bytes before attempting a REST upload */
const REST_MIN_UPLOAD_BYTES = 4_000;

/** WebSocket Audio Batching: Number of 24kHz samples to accumulate before sending to prevent rate limits (~250ms) */
const SEND_THRESHOLD_SAMPLES = 6000;

/** Silence RMS threshold — skip REST uploads for silent buffers */
const SILENCE_RMS_THRESHOLD = 50;

/** PCM parameters */
const WS_SAMPLE_RATE      = 24_000; // OpenAI Realtime API requires 24 kHz for pcm16
const REST_SAMPLE_RATE    = 16_000; // whisper-1 REST accepts 16 kHz
const BITS_PER_SAMPLE     = 16;
const NUM_CHANNELS        = 1;

// ─── State ────────────────────────────────────────────────────────────────────

type Mode = 'ws' | 'rest';

// ─── Class ────────────────────────────────────────────────────────────────────

export class OpenAIStreamingSTT extends EventEmitter {
    // Public config
    private apiKey: string;
    private languageKey = 'en';

    // Audio config (set from pipeline)
    private inputSampleRate = 16_000;
    private numChannels     = NUM_CHANNELS;

    // Lifecycle
    private isActive     = false;
    private isConnecting = false;
    private shouldReconnect = false;

    // WebSocket state
    private ws: WebSocket | null = null;
    private wsModelIndex = 0;           // index into WS_MODELS
    private wsFailures   = 0;           // consecutive failures for current WS model
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private connectionTimeoutTimer: NodeJS.Timeout | null = null;
    private sessionSetupTimer: NodeJS.Timeout | null = null;
    private isSessionReady = false;     // set after transcription_session.created

    // Audio batching state
    private pcmAccumulator: Int16Array[] = [];
    private pcmAccumulatorLen = 0;

    // Mode
    private mode: Mode = 'ws';

    // Rolling pre-buffer: holds audio while connecting / transitioning
    // Used to avoid losing speech at the start of a WS session or during fallback
    private ringBuffer: Buffer[] = [];
    private ringBufferBytes = 0;

    // REST fallback state
    private restChunks: Buffer[]   = [];
    private restTotalBytes         = 0;
    private restSafetyTimer: NodeJS.Timeout | null = null;
    private restIsUploading        = false;
    private restFlushPending       = false;

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
        console.log('[OpenAIStreaming] Initialized — GA realtime + input transcription (gpt-4o-transcribe → gpt-4o-mini-transcribe → gpt-live-transcribe → whisper-1 REST)');
    }

    // ─── Public Configuration (STTProvider interface) ─────────────────────────

    public setApiKey(apiKey: string): void {
        this.apiKey = apiKey;
        console.log('[OpenAIStreaming] API key updated');
    }

    public setSampleRate(rate: number): void {
        if (this.inputSampleRate === rate) return;
        this.inputSampleRate = rate;
        console.log(`[OpenAIStreaming] Input sample rate set to ${rate}Hz`);
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        this.numChannels = count;
        console.log(`[OpenAIStreaming] Channel count set to ${count}`);
    }

    public setRecognitionLanguage(key: string): void {
        const prev = this.languageKey;
        this.languageKey = key;
        if (key !== prev && this.isActive && this.mode === 'ws') {
            console.log(`[OpenAIStreaming] Language changed to ${key} — restarting WS session`);
            this._closeWs(true);
            this._connectWs();
        }
    }

    /** No-op — no credential files needed */
    public setCredentials(_path: string): void {}

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    public start(): void {
        if (this.isActive) return;
        console.log('[OpenAIStreaming] Starting...');
        this.isActive       = true;
        this.shouldReconnect = true;
        this.wsModelIndex   = 0;
        this.wsFailures     = 0;
        this.reconnectAttempts = 0;
        this.mode           = 'ws';

        this._connectWs();
    }

    public stop(): void {
        if (!this.isActive) return;
        console.log('[OpenAIStreaming] Stopping...');
        this.isActive        = false;
        this.shouldReconnect = false;

        // Flush any remaining buffered audio to the WS before closing so we
        // don't silently drop up to ~250ms of speech at the end of a session.
        if (this.mode === 'ws' && this.ws?.readyState === WebSocket.OPEN &&
            this.isSessionReady && this.pcmAccumulatorLen > 0) {
            const combined = new Int16Array(this.pcmAccumulatorLen);
            let offset = 0;
            for (const arr of this.pcmAccumulator) {
                combined.set(arr, offset);
                offset += arr.length;
            }
            try {
                this.ws.send(JSON.stringify({
                    type:  'input_audio_buffer.append',
                    audio: Buffer.from(combined.buffer).toString('base64'),
                }));
            } catch { /* ignore — we're closing anyway */ }
        }

        this._clearTimers();
        this._closeWs(false);
        this._stopRestTimer();

        this.restChunks     = [];
        this.restTotalBytes = 0;
        this.ringBuffer     = [];
        this.ringBufferBytes = 0;
        this.pcmAccumulator = [];
        this.pcmAccumulatorLen = 0;
    }

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (this.mode === 'ws') {
            // Always push to ring-buffer while not yet ready (pre-buffer)
            if (!this.isSessionReady) {
                this._ringBufferPush(chunk);
                // Lazy connect only when no socket is already connecting/open.
                if (
                    this.shouldReconnect &&
                    !this.isConnecting &&
                    !this.reconnectTimer &&
                    !this._hasLiveSocket()
                ) {
                    this._connectWs();
                }
                return;
            }
            this._sendWsAudioChunk(chunk);
        } else {
            // REST mode — accumulate for batch upload
            this.restChunks.push(chunk);
            this.restTotalBytes += chunk.length;
        }
    }

    /**
     * Called by Rust native VAD when speech ends.
     * On WebSocket path: server_vad commits turns; flush any pending PCM as a courtesy.
     * On REST fallback path: triggers immediate flush.
     */
    public notifySpeechEnded(): void {
        if (!this.isActive) return;
        if (this.mode === 'rest') {
            console.log('[OpenAIStreaming][REST] Speech ended — flushing buffer');
            this._restFlushAndUpload();
            return;
        }
        this._flushPcmAccumulator();
    }

    // ─── WebSocket Path ───────────────────────────────────────────────────────

    private _hasLiveSocket(): boolean {
        if (!this.ws) return false;
        return this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN;
    }

    private _connectWs(): void {
        if (!this.shouldReconnect) return;
        // Prevent duplicate sockets: write() used to race after ws 'open' cleared isConnecting
        // before session.updated, spawning a second connection that timed out and tore down STT.
        if (this.isConnecting || this._hasLiveSocket()) {
            return;
        }
        this.isConnecting  = true;
        this.isSessionReady = false;

        const transcriptionModel: WsModel = WS_MODELS[this.wsModelIndex] ?? WS_MODELS[0];
        // GA: ?model= must be a realtime model. Transcription models go in session config only.
        const wsUrl = `${REALTIME_WS_BASE}?model=${encodeURIComponent(REALTIME_SESSION_MODEL)}`;
        console.log(`[OpenAIStreaming] Connecting realtime WS (session=${REALTIME_SESSION_MODEL}, transcription=${transcriptionModel}, attempt=${this.reconnectAttempts + 1})...`);

        // GA Realtime: no OpenAI-Beta header (beta interface is retired).
        const ws = new WebSocket(wsUrl, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
            },
        });
        this.ws = ws;

        // 10-second connection timeout to prevent hanging on dropped networks
        this.connectionTimeoutTimer = setTimeout(() => {
            if (this.ws !== ws) return; // superseded
            console.warn(`[OpenAIStreaming] WebSocket connection timed out after 10s (attempt=${this.reconnectAttempts + 1})`);
            ws.removeAllListeners();
            ws.close();
            if (this.ws === ws) this.ws = null;
            this.isConnecting = false;
            this._handleWsClose(1006, Buffer.from('Connection Timeout'));
        }, 10_000);

        ws.on('open', () => {
            if (this.ws !== ws) return;
            if (this.connectionTimeoutTimer) {
                clearTimeout(this.connectionTimeoutTimer);
                this.connectionTimeoutTimer = null;
            }
            console.log(`[OpenAIStreaming] WebSocket open — configuring input transcription (${transcriptionModel})`);
            // Keep isConnecting=true until session.updated so write() cannot open a second socket.
            this.reconnectAttempts = 0;

            // Start 5-second timeout waiting for session.updated
            this.sessionSetupTimer = setTimeout(() => {
                if (this.ws !== ws || this.isSessionReady) return;
                console.warn(`[OpenAIStreaming] Server accepted connection but failed to create session within 5s. Forcing disconnect...`);
                ws.removeAllListeners();
                ws.close();
                if (this.ws === ws) this.ws = null;
                this.isConnecting = false;
                this._handleWsClose(1008, Buffer.from('Session Setup Timeout'));
            }, 5_000);

            const lang = this.languageKey && this.languageKey !== 'auto'
                ? (RECOGNITION_LANGUAGES[this.languageKey]?.iso639 ?? '')
                : '';

            const transcriptionCfg: Record<string, any> = {
                model: transcriptionModel,
            };
            // gpt-live-transcribe uses `languages`; older models accept `language`.
            if (lang) {
                if (transcriptionModel === 'gpt-live-transcribe') {
                    transcriptionCfg.languages = [lang];
                } else {
                    transcriptionCfg.language = lang;
                }
            }

            // Realtime session with input-audio transcription (STT-only: no model speech response).
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: REALTIME_SESSION_MODEL,
                    output_modalities: ['text'],
                    audio: {
                        input: {
                            format: {
                                type: 'audio/pcm',
                                rate: WS_SAMPLE_RATE,
                            },
                            transcription: transcriptionCfg,
                            turn_detection: {
                                type:                'server_vad',
                                // Higher silence gap = fewer mid-sentence cuts on natural pauses.
                                threshold:           0.5,
                                prefix_padding_ms:   300,
                                silence_duration_ms: 900,
                                create_response:     false,
                            },
                        },
                    },
                },
            }));
        });

        ws.on('message', (raw: WebSocket.Data) => {
            if (this.ws !== ws) return;
            try {
                const msg = JSON.parse(raw.toString());
                this._handleWsMessage(msg);
            } catch (err) {
                console.error('[OpenAIStreaming] WS parse error:', err);
            }
        });

        ws.on('error', (err: Error) => {
            if (this.ws !== ws) return;
            console.error(`[OpenAIStreaming] WS error: ${err.message}`);
            // The 'close' event will follow, so we handle reconnect there.
        });

        ws.on('close', (code: number, reason: Buffer) => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.isConnecting = false;
            this._handleWsClose(code, reason);
        });
    }

    private _handleWsClose(code: number, reason: Buffer): void {
        this.isConnecting   = false;
        this.isSessionReady = false;
        this._clearKeepAlive();
        if (this.connectionTimeoutTimer) {
            clearTimeout(this.connectionTimeoutTimer);
            this.connectionTimeoutTimer = null;
        }
        if (this.sessionSetupTimer) {
            clearTimeout(this.sessionSetupTimer);
            this.sessionSetupTimer = null;
        }
        console.log(`[OpenAIStreaming] WS closed (code=${code}, reason=${reason.toString() || 'none'})`);

        if (!this.shouldReconnect) return;

        // Count this as a failure
        this.wsFailures++;

        if (this.wsFailures >= MAX_WS_FAILURES_PER_MODEL) {
            // Advance to next WebSocket model
            this.wsModelIndex++;
            this.wsFailures = 0;

            if (this.wsModelIndex >= WS_MODELS.length) {
                // All WS models exhausted — fall back to REST
                console.warn('[OpenAIStreaming] All WebSocket models failed — falling back to whisper-1 REST');
                this._switchToRest();
            } else {
                const nextModel = WS_MODELS[this.wsModelIndex];
                console.warn(`[OpenAIStreaming] Switching to next WebSocket model: ${nextModel}`);
                this.reconnectAttempts = 0;
                this._scheduleWsReconnect();
            }
        } else {
            // Same model, retry with backoff (e.g. transient network error)
            this._scheduleWsReconnect();
        }
    }

    private _markSessionReady(source: string): void {
        if (this.isSessionReady) return;
        if (this.sessionSetupTimer) {
            clearTimeout(this.sessionSetupTimer);
            this.sessionSetupTimer = null;
        }
        console.log(`[OpenAIStreaming] Session ready (${source}) — flushing ring buffer`);
        this.isSessionReady = true;
        this.isConnecting = false;
        this.wsFailures = 0;
        this._startKeepAlive();
        this._flushRingBuffer();
    }

    private _handleWsMessage(msg: Record<string, any>): void {
        switch (msg.type) {
            // GA: server emits session.created on connect, then session.updated after our session.update.
            case 'session.updated':
                this._markSessionReady(msg.type);
                break;
            case 'session.created':
                // Wait for session.updated after our session.update.
                // Ready immediately only if input transcription is already configured.
                if (msg.session?.audio?.input?.transcription?.model) {
                    this._markSessionReady(msg.type);
                }
                break;

            // GA transcript events
            case 'conversation.item.input_audio_transcription.delta':
            // Legacy beta event names (defensive)
            case 'transcript.text.delta':
                if (msg.delta) {
                    this.emit('transcript', {
                        text:       msg.delta,
                        isFinal:    false,
                        confidence: 1.0,
                    });
                }
                break;

            case 'conversation.item.input_audio_transcription.completed':
            case 'transcript.text.done': {
                const text = msg.transcript ?? msg.text;
                if (text) {
                    console.log(`[OpenAIStreaming] Final: "${String(text).substring(0, 60)}"`);
                    const detected = Array.isArray(msg.languages) && msg.languages[0]?.code
                        ? normalizeLanguageToIso639(msg.languages[0].code)
                        : undefined;
                    this.emit('transcript', {
                        text:       text,
                        isFinal:    true,
                        confidence: 1.0,
                        boundary:   true,
                        detectedLanguage: detected,
                    });
                }
                break;
            }

            case 'input_audio_buffer.speech_started':
                console.log('[OpenAIStreaming] Server VAD: speech started');
                break;
            case 'input_audio_buffer.speech_stopped':
                console.log('[OpenAIStreaming] Server VAD: speech stopped');
                break;
            case 'input_audio_buffer.committed':
                break;

            case 'error': {
                const errMsg = msg.error?.message ?? JSON.stringify(msg);
                const errCode = String(msg.error?.code ?? msg.error?.type ?? '');
                console.error(`[OpenAIStreaming] Server error: ${errMsg}`);
                this.emit('error', new Error(errMsg));
                const fatal = FATAL_WS_ERROR_PATTERNS.some((re) => re.test(errMsg) || re.test(errCode));
                if (fatal) {
                    console.warn('[OpenAIStreaming] Fatal WS error — advancing fallback immediately');
                    this.wsFailures = MAX_WS_FAILURES_PER_MODEL;
                    try { this.ws?.close(); } catch { /* ignore */ }
                }
                break;
            }

            default:
                break;
        }
    }

    private _sendWsAudioChunk(pcmChunk: Buffer): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Downsample if necessary (e.g. 48kHz → 24kHz for Realtime API)
        const pcm16 = this._resamplePcm16(pcmChunk, WS_SAMPLE_RATE);

        const inputS16 = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength / 2);

        this.pcmAccumulator.push(inputS16);
        this.pcmAccumulatorLen += inputS16.length;

        if (this.pcmAccumulatorLen >= SEND_THRESHOLD_SAMPLES) {
            this._flushPcmAccumulator();
        }
    }

    private _flushPcmAccumulator(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pcmAccumulatorLen === 0) return;

        const combined = new Int16Array(this.pcmAccumulatorLen);
        let offset = 0;
        for (const arr of this.pcmAccumulator) {
            combined.set(arr, offset);
            offset += arr.length;
        }
        this.pcmAccumulator = [];
        this.pcmAccumulatorLen = 0;

        try {
            this.ws.send(JSON.stringify({
                type:  'input_audio_buffer.append',
                audio: Buffer.from(combined.buffer).toString('base64'),
            }));
        } catch (err) {
            console.warn('[OpenAIStreaming] WS send failed:', err);
        }
    }

    /** Commit the current input buffer so the transcription model emits a final transcript. */
    private _commitAudioBuffer(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSessionReady) return;
        try {
            this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            console.log('[OpenAIStreaming] Committed audio buffer (client VAD)');
        } catch (err) {
            console.warn('[OpenAIStreaming] WS commit failed:', err);
        }
    }

    private _closeWs(graceful: boolean): void {
        if (!this.ws) return;
        try {
            if (graceful && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'session.close' }));
            }
        } catch { /* ignore */ }
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = null;
        this.isSessionReady = false;
        this.isConnecting = false; // Allow immediate reconnect (e.g. language change)
        this.pcmAccumulator = [];
        this.pcmAccumulatorLen = 0;
        if (this.connectionTimeoutTimer) {
            clearTimeout(this.connectionTimeoutTimer);
            this.connectionTimeoutTimer = null;
        }
        if (this.sessionSetupTimer) {
            clearTimeout(this.sessionSetupTimer);
            this.sessionSetupTimer = null;
        }
    }

    private _scheduleWsReconnect(): void {
        if (!this.shouldReconnect) return;
        const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_MS,
        );
        this.reconnectAttempts++;
        console.log(`[OpenAIStreaming] WS reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect && this.mode === 'ws') {
                this._connectWs();
            }
        }, delay);
    }

    // ─── Keep-alive ───────────────────────────────────────────────────────────

    /** 8 bytes of PCM silence (4 samples × 2 bytes) — safest keepalive for the Realtime API */
    private static readonly KEEPALIVE_AUDIO_B64 = Buffer.alloc(8).toString('base64');

    private _startKeepAlive(): void {
        this._clearKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                    // Send a minimal silent PCM frame to prevent idle disconnects.
                    // An empty string ('') can be rejected by some API versions; 8 zero-bytes is safe.
                    this.ws.send(JSON.stringify({
                        type:  'input_audio_buffer.append',
                        audio: OpenAIStreamingSTT.KEEPALIVE_AUDIO_B64,
                    }));
                } catch { /* ignore */ }
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private _clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private _clearTimers(): void {
        this._clearKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connectionTimeoutTimer) {
            clearTimeout(this.connectionTimeoutTimer);
            this.connectionTimeoutTimer = null;
        }
        if (this.sessionSetupTimer) {
            clearTimeout(this.sessionSetupTimer);
            this.sessionSetupTimer = null;
        }
    }

    // ─── Ring Buffer (pre-buffer during connecting / transitions) ────────────

    private _ringBufferPush(chunk: Buffer): void {
        this.ringBuffer.push(chunk);
        this.ringBufferBytes += chunk.length;

        // Evict oldest chunks when over limit
        while (this.ringBufferBytes > MAX_RING_BUFFER_BYTES && this.ringBuffer.length > 0) {
            const evicted = this.ringBuffer.shift()!;
            this.ringBufferBytes -= evicted.length;
        }
    }

    /** Flush the ring buffer once the session is ready */
    private _flushRingBuffer(): void {
        if (this.ringBuffer.length === 0) return;
        console.log(`[OpenAIStreaming] Flushing ${this.ringBuffer.length} buffered chunks (${this.ringBufferBytes} bytes)`);
        const chunks = this.ringBuffer.splice(0);
        this.ringBufferBytes = 0;
        for (const chunk of chunks) {
            this._sendWsAudioChunk(chunk);
        }
    }

    // ─── REST Fallback Path ───────────────────────────────────────────────────

    private _switchToRest(): void {
        this.mode = 'rest';
        this._clearTimers();
        this._closeWs(false);

        // Transfer ring-buffer contents to the REST accumulator so buffered audio isn't lost
        if (this.ringBuffer.length > 0) {
            console.log(`[OpenAIStreaming][REST] Transferring ${this.ringBufferBytes} ring-buffer bytes to REST accumulator`);
            const chunks = this.ringBuffer.splice(0);
            this.ringBufferBytes = 0;
            for (const chunk of chunks) {
                this.restChunks.push(chunk);
                this.restTotalBytes += chunk.length;
            }
        }

        // Start safety-net timer
        this._startRestTimer();
        console.log('[OpenAIStreaming][REST] Switched to whisper-1 REST fallback');
    }

    private _startRestTimer(): void {
        this._stopRestTimer();
        this.restSafetyTimer = setInterval(() => {
            this._restFlushAndUpload();
        }, REST_SAFETY_NET_MS);
    }

    private _stopRestTimer(): void {
        if (this.restSafetyTimer) {
            clearInterval(this.restSafetyTimer);
            this.restSafetyTimer = null;
        }
    }

    private async _restFlushAndUpload(): Promise<void> {
        if (this.restChunks.length === 0 || this.restTotalBytes < REST_MIN_UPLOAD_BYTES) return;
        if (this.restIsUploading) {
            this.restFlushPending = true;
            return;
        }

        // Reset safety-net timer to prevent double-flush
        this._startRestTimer();

        const chunks = this.restChunks.splice(0);
        this.restTotalBytes = 0;

        const rawPcm = Buffer.concat(chunks);

        // Skip silent buffers
        if (this._isSilent(rawPcm)) {
            if (Math.random() < 0.1) {
                console.log(`[OpenAIStreaming][REST] Skipping silent buffer (${rawPcm.length} bytes)`);
            }
            return;
        }

        // Downsample to 16kHz mono before creating WAV (input may be 48kHz)
        const pcm16k = this._resamplePcm16(rawPcm, REST_SAMPLE_RATE);
        const wavBuffer = this._addWavHeader(pcm16k, REST_SAMPLE_RATE);
        this.restIsUploading = true;

        try {
            const { transcript, detectedLanguage } = await this._restUpload(wavBuffer);
            if (transcript && transcript.trim().length > 0) {
                console.log(`[OpenAIStreaming][REST] Transcript: "${transcript.substring(0, 60)}"${detectedLanguage ? ` [lang=${detectedLanguage}]` : ''}`);
                this.emit('transcript', {
                    text:       transcript.trim(),
                    isFinal:    true,
                    confidence: 1.0,
                    detectedLanguage,
                });
            }
        } catch (err) {
            console.error('[OpenAIStreaming][REST] Upload error:', err);
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        } finally {
            this.restIsUploading = false;
            if (this.restFlushPending) {
                this.restFlushPending = false;
                this._restFlushAndUpload();
            }
        }
    }

    private async _restUpload(wavBuffer: Buffer): Promise<{ transcript: string; detectedLanguage?: string }> {
        const form = new FormData();
        form.append('file', wavBuffer, {
            filename:    'audio.wav',
            contentType: 'audio/wav',
        });
        form.append('model', 'whisper-1');
        // verbose_json surfaces the detected `language` field on the response.
        form.append('response_format', 'verbose_json');

        // Auto-detect mode: omit `language` so Whisper detects natively.
        const lang = this.languageKey && this.languageKey !== 'auto'
            ? (RECOGNITION_LANGUAGES[this.languageKey]?.iso639 ?? '')
            : '';
        if (lang) form.append('language', lang);

        const response = await axios.post(REST_ENDPOINT, form, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                ...form.getHeaders(),
            },
            timeout: 30_000,
        });

        const data = response.data;
        if (typeof data === 'string') return { transcript: data };
        return {
            transcript: data?.text ?? '',
            detectedLanguage: normalizeLanguageToIso639(data?.language),
        };
    }

    // ─── Audio Utilities ──────────────────────────────────────────────────────

    /**
     * Convert raw PCM buffer from the capture pipeline into 16-bit PCM at the given target rate.
     * The pipeline outputs Int16LE PCM, potentially at a higher sample rate (e.g. 48kHz).
     */
    private _resamplePcm16(chunk: Buffer, targetRate: number): Buffer {
        // Safe read from unaligned memory
        const numSamples = chunk.length / 2;
        const inputS16 = new Int16Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            inputS16[i] = chunk.readInt16LE(i * 2);
        }

        if (this.inputSampleRate === targetRate && this.numChannels === 1) {
            return Buffer.from(inputS16.buffer);
        }

        // Mix down multi-channel to mono first, then downsample
        let monoS16: Int16Array;
        if (this.numChannels > 1) {
            const monoLength = Math.floor(inputS16.length / this.numChannels);
            monoS16 = new Int16Array(monoLength);
            for (let i = 0; i < monoLength; i++) {
                let sum = 0;
                for (let c = 0; c < this.numChannels; c++) {
                    sum += inputS16[i * this.numChannels + c];
                }
                monoS16[i] = Math.round(sum / this.numChannels);
            }
        } else {
            monoS16 = inputS16;
        }

        // Downsample
        if (this.inputSampleRate === targetRate) {
            return Buffer.from(monoS16.buffer);
        }

        const factor       = this.inputSampleRate / targetRate;
        const outputLength = Math.floor(monoS16.length / factor);
        const outputS16    = new Int16Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
            outputS16[i] = monoS16[Math.floor(i * factor)];
        }
        return Buffer.from(outputS16.buffer);
    }

    private _isSilent(pcm: Buffer): boolean {
        let sum   = 0;
        let count = 0;
        const step = 20;
        for (let i = 0; i < pcm.length - 1; i += 2 * step) {
            const sample = pcm.readInt16LE(i);
            sum  += sample * sample;
            count++;
        }
        if (count === 0) return true;
        return Math.sqrt(sum / count) < SILENCE_RMS_THRESHOLD;
    }

    /** Build a WAV file header for mono 16-bit PCM at the given sample rate.
     *  The caller is responsible for passing the correct rate that matches `samples`. */
    private _addWavHeader(samples: Buffer, sampleRate: number): Buffer {
        const buf = Buffer.alloc(44 + samples.length);
        buf.write('RIFF', 0);
        buf.writeUInt32LE(36 + samples.length, 4);
        buf.write('WAVE', 8);
        buf.write('fmt ', 12);
        buf.writeUInt32LE(16, 16);
        buf.writeUInt16LE(1, 20);                                                                   // PCM
        buf.writeUInt16LE(NUM_CHANNELS, 22);
        buf.writeUInt32LE(sampleRate, 24);
        buf.writeUInt32LE(sampleRate * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28);
        buf.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32);
        buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
        buf.write('data', 36);
        buf.writeUInt32LE(samples.length, 40);
        samples.copy(buf, 44);
        return buf;
    }
}
