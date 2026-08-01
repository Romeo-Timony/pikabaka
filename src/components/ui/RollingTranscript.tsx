import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Languages, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TranscriptDisplayMode, TranscriptSegment } from '../../lib/transcriptSegments';

interface TranscriptNotesProps {
    segments: TranscriptSegment[];
    /** @deprecated Live text streams into segments; ignored when present on segments. */
    partialText?: string;
    displayMode?: TranscriptDisplayMode;
    isActive?: boolean;
    /** System audio is active but STT has not produced text yet — show AI-style waiting dots. */
    isAwaitingTranscript?: boolean;
    surfaceStyle?: React.CSSProperties;
    partialSpeakerLabel?: string;
    onTranslateSegment?: (segment: TranscriptSegment) => void;
}

/** Same bouncing ellipsis as AI chat `isProcessing` state. */
function TypingDots({ className = 'bg-slate-400' }: { className?: string }) {
    return (
        <div className="flex justify-start" aria-label="Waiting for transcript" aria-live="polite">
            <div className="px-1 py-1 flex gap-1.5">
                <div className={`w-2 h-2 rounded-full animate-bounce ${className}`} style={{ animationDelay: '0ms' }} />
                <div className={`w-2 h-2 rounded-full animate-bounce ${className}`} style={{ animationDelay: '150ms' }} />
                <div className={`w-2 h-2 rounded-full animate-bounce ${className}`} style={{ animationDelay: '300ms' }} />
            </div>
        </div>
    );
}

const AVATAR_PALETTE = [
    'bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/35',
    'bg-emerald-500/25 text-emerald-100 ring-1 ring-emerald-400/35',
    'bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/35',
    'bg-rose-500/25 text-rose-100 ring-1 ring-rose-400/35',
    'bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/35',
    'bg-cyan-500/25 text-cyan-100 ring-1 ring-cyan-400/35',
];

function paletteIndexForLabel(label: string): number {
    let h = 0;
    for (let i = 0; i < label.length; i++) {
        h = (h << 5) - h + label.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h) % AVATAR_PALETTE.length;
}

function avatarAbbrev(label: string): string {
    const u = label.trim();
    if (!u) return '?';
    if (/^me$/i.test(u)) return 'M';
    const userNum = /^user\s*(\d+)$/i.exec(u);
    if (userNum) return `U${userNum[1]}`;
    const sNum = /^s(\d+)$/i.exec(u);
    if (sNum) return `S${sNum[1]}`;
    if (u.length <= 4) return u.toUpperCase();
    return u.slice(0, 2).toUpperCase();
}

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
    });
}

function SpeakerAvatar({
    label,
    pulsing,
}: {
    label: string;
    pulsing?: boolean;
}) {
    const idx = paletteIndexForLabel(label);
    const ring = pulsing ? ' ring-2 ring-emerald-400/60' : '';
    return (
        <div
            className={[
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none tracking-tight',
                AVATAR_PALETTE[idx],
                ring,
            ].join(' ')}
            aria-hidden="true"
        >
            {avatarAbbrev(label)}
        </div>
    );
}

/**
 * Reveal STT text left-to-right like AI token streaming.
 * STT often delivers large interim chunks at once — we type them out gradually.
 */
function useLeftToRightReveal(target: string, enabled: boolean): string {
    const [revealed, setRevealed] = useState(() => (enabled ? '' : target));
    const revealedRef = useRef(enabled ? '' : target);
    const targetRef = useRef(target);
    targetRef.current = target;

    useEffect(() => {
        if (!enabled) {
            revealedRef.current = target;
            setRevealed(target);
            return;
        }

        let rafId = 0;
        let lastTs = performance.now();

        const tick = (now: number) => {
            const nextTarget = targetRef.current;
            let current = revealedRef.current;

            // Hypothesis revised — keep shared prefix, continue from there
            if (!nextTarget.startsWith(current)) {
                let i = 0;
                const limit = Math.min(current.length, nextTarget.length);
                while (i < limit && current[i] === nextTarget[i]) i += 1;
                current = nextTarget.slice(0, i);
            }

            if (current.length < nextTarget.length) {
                const dt = Math.min(48, now - lastTs);
                lastTs = now;
                const behind = nextTarget.length - current.length;
                // Adaptive speed: stay snappy when far behind, natural when close
                const charsPerSec = behind > 48 ? 140 : behind > 20 ? 90 : 55;
                const step = Math.max(1, Math.round((dt / 1000) * charsPerSec));
                current = nextTarget.slice(0, Math.min(nextTarget.length, current.length + step));
                revealedRef.current = current;
                setRevealed(current);
            } else {
                lastTs = now;
            }

            const stillBehind =
                revealedRef.current.length < targetRef.current.length ||
                !targetRef.current.startsWith(revealedRef.current);
            if (stillBehind) {
                rafId = requestAnimationFrame(tick);
            }
        };

        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, [target, enabled]);

    return enabled ? revealed : target;
}

/** Match AI assistant message body: waiting dots → then markdown stream + caret. */
function StreamingTranscriptText({
    text,
    isStreaming,
    onRevealProgress,
}: {
    text: string;
    isStreaming?: boolean;
    onRevealProgress?: () => void;
}) {
    // Hold AI-style dots briefly after STT text arrives, then reveal LTR
    const [revealEnabled, setRevealEnabled] = useState(!isStreaming);
    const armedForUtteranceRef = useRef(false);

    useEffect(() => {
        if (!isStreaming) {
            armedForUtteranceRef.current = false;
            setRevealEnabled(true);
            return;
        }

        if (!text.trim()) {
            armedForUtteranceRef.current = false;
            setRevealEnabled(false);
            return;
        }

        if (armedForUtteranceRef.current) {
            setRevealEnabled(true);
            return;
        }

        setRevealEnabled(false);
        const timer = window.setTimeout(() => {
            armedForUtteranceRef.current = true;
            setRevealEnabled(true);
        }, 220);
        return () => window.clearTimeout(timer);
    }, [isStreaming, text]);

    const displayed = useLeftToRightReveal(revealEnabled ? text : '', !!isStreaming && revealEnabled);

    useEffect(() => {
        onRevealProgress?.();
    }, [displayed, onRevealProgress]);

    // Like AI chat: bouncing dots while waiting / before first visible characters
    if (isStreaming && displayed.length === 0) {
        return <TypingDots />;
    }

    return (
        <div className="markdown-content text-[14px] leading-6 overlay-text-primary font-normal">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
                    strong: ({ node, ...props }: any) => <strong className="font-bold opacity-100 overlay-text-strong" {...props} />,
                    em: ({ node, ...props }: any) => <em className="italic opacity-90 overlay-text-secondary" {...props} />,
                    ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                    ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                    li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                }}
            >
                {displayed}
            </ReactMarkdown>
            {isStreaming && displayed.length > 0 && (
                <span
                    className="inline-block w-0.5 h-4 bg-text-secondary ml-0.5 align-middle animate-pulse"
                    aria-hidden="true"
                />
            )}
        </div>
    );
}

const TranscriptNotes: React.FC<TranscriptNotesProps> = ({
    segments,
    isActive = false,
    isAwaitingTranscript = false,
    surfaceStyle,
    onTranslateSegment,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const userScrolledRef = useRef(false);
    const scrollRafRef = useRef<number | null>(null);
    const [userScrolled, setUserScrolled] = useState(false);

    const hasLiveStreamingSegment = segments.some((s) => s.isStreaming);
    const showWaitingBubble = isAwaitingTranscript && !hasLiveStreamingSegment;
    const hasContent = segments.length > 0 || showWaitingBubble;

    const contentSignature = segments.reduce(
        (acc, s) => acc + s.sourceText.length + (s.translatedText?.length ?? 0) + (s.isStreaming ? 1 : 0), 0);

    const pinToBottom = useCallback(() => {
        if (userScrolledRef.current) return;
        if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            const el = containerRef.current;
            if (!el || userScrolledRef.current) return;
            el.scrollTop = el.scrollHeight;
        });
    }, []);

    // Keep pinned to bottom without scrollIntoView — that scrolls ancestor windows and
    // stacks smooth animations on every STT partial token, which jerks the whole overlay.
    useEffect(() => {
        pinToBottom();
        return () => {
            if (scrollRafRef.current != null) {
                cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = null;
            }
        };
    }, [segments.length, contentSignature, userScrolled, showWaitingBubble, pinToBottom]);

    const handleScroll = () => {
        const el = containerRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        userScrolledRef.current = !atBottom;
        setUserScrolled(!atBottom);
    };

    if (!hasContent) return null;

    return (
        <div className="px-4 pt-2 pb-1 no-drag">
            <div
                ref={containerRef}
                onScroll={handleScroll}
                aria-live="polite"
                aria-label="Meeting transcript"
                className="w-full min-h-[80px] max-h-[280px] overflow-y-auto"
                style={{ overflowAnchor: 'none' }}
            >
                <div className="space-y-3 pr-0.5">
                    {segments.map((seg) => {
                        const hasTranslation =
                            !!seg.translatedText && seg.translatedText.trim() !== '' && seg.translatedText !== seg.sourceText;
                        const isTranslationPending = seg.translationState === 'pending';
                        const showTranslation = hasTranslation;
                        const streaming = !!seg.isStreaming;

                        return (
                            <div key={seg.segmentId} className="flex items-start gap-2.5">
                                <SpeakerAvatar label={seg.speakerLabel} pulsing={streaming && isActive} />
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                                                {seg.speakerLabel}
                                            </span>
                                            {streaming && (
                                                <span className="inline-flex items-center gap-1 text-[9px] text-text-tertiary">
                                                    <span className="w-1 h-1 bg-state-success rounded-full animate-pulse" />
                                                    Live
                                                </span>
                                            )}
                                            {seg.detectedLanguage && !streaming && (
                                                <span
                                                    className="rounded-sm border border-border-subtle px-1 py-0 text-[9px] font-mono uppercase tracking-wider text-text-tertiary"
                                                    title={`Detected language: ${seg.detectedLanguage}`}
                                                >
                                                    {seg.detectedLanguage}
                                                </span>
                                            )}
                                            <time
                                                className="text-[9px] tabular-nums text-text-tertiary"
                                                dateTime={new Date(seg.timestamp).toISOString()}
                                            >
                                                {formatTime(seg.timestamp)}
                                            </time>
                                        </div>
                                        {onTranslateSegment && !streaming && (
                                            <button
                                                type="button"
                                                onClick={() => onTranslateSegment(seg)}
                                                disabled={isTranslationPending}
                                                className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary disabled:cursor-wait disabled:opacity-70"
                                            >
                                                {isTranslationPending ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                                ) : (
                                                    <Languages className="h-3 w-3" aria-hidden="true" />
                                                )}
                                                <span>{hasTranslation ? 'Retranslate' : 'Translate'}</span>
                                            </button>
                                        )}
                                    </div>
                                    <div
                                        className="rounded-2xl border border-border-subtle px-4 py-2.5 shadow-sm overlay-transcript-surface"
                                        style={surfaceStyle}
                                    >
                                        <StreamingTranscriptText
                                            text={seg.sourceText}
                                            isStreaming={streaming}
                                            onRevealProgress={pinToBottom}
                                        />
                                        {showTranslation && (
                                            <>
                                                <div className="my-2.5 h-px bg-border-subtle/60" />
                                                <div className="flex gap-2">
                                                    <Globe
                                                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-state-info"
                                                        strokeWidth={2}
                                                        aria-hidden="true"
                                                    />
                                                    <p className="overlay-text-secondary min-w-0 flex-1 text-[12px] italic leading-[1.55] whitespace-pre-wrap break-words">
                                                        {seg.translatedText}
                                                    </p>
                                                </div>
                                            </>
                                        )}
                                        {!showTranslation && isTranslationPending && (
                                            <div className="mt-2 flex items-center gap-2 text-[11px] text-text-tertiary">
                                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                                <span>Translating...</span>
                                            </div>
                                        )}
                                        {seg.translationState === 'error' && !showTranslation && (
                                            <div className="mt-2 text-[11px] text-amber-300">
                                                Translation failed. Try again.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    {showWaitingBubble && (
                        <div className="flex items-start gap-2.5">
                            <SpeakerAvatar label="Interviewer" pulsing={isActive || isAwaitingTranscript} />
                            <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                                        Interviewer
                                    </span>
                                    <span className="inline-flex items-center gap-1 text-[9px] text-text-tertiary">
                                        <span className="w-1 h-1 bg-state-success rounded-full animate-pulse" />
                                        Live
                                    </span>
                                </div>
                                <div
                                    className="rounded-2xl border border-border-subtle px-4 py-2.5 shadow-sm overlay-transcript-surface"
                                    style={surfaceStyle}
                                >
                                    <TypingDots />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {userScrolled && (
                <button
                    type="button"
                    aria-label="Scroll to latest"
                    onClick={() => {
                        userScrolledRef.current = false;
                        setUserScrolled(false);
                        const el = containerRef.current;
                        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                    }}
                    className="mt-1 ml-auto flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
                >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path
                            d="M5 2v6M2 6l3 3 3-3"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Jump to latest
                </button>
            )}
        </div>
    );
};

export default TranscriptNotes;
