import React from 'react';
import RollingTranscript from '../ui/RollingTranscript';
import type { TranscriptDisplayMode, TranscriptSegment } from '../../lib/transcriptSegments';

interface TranscriptPanelProps {
    transcriptSegments: TranscriptSegment[];
    isInterviewerSpeaking: boolean;
    transcriptDisplayMode: TranscriptDisplayMode;
    showTranscript: boolean;
    handleTranslateTranscriptSegment: (segment: TranscriptSegment) => void;
    sttStatus: { label: string; toneClass: string; dotClass: string };
    showSttErrorDetail: boolean;
    nativeAudioHealth: { lastError: string | null };
    appearance: ReturnType<typeof import('../../lib/overlayAppearance').getOverlayAppearance>;
    isLightTheme: boolean;
}

const subtleSurfaceClass = 'overlay-subtle-surface';

const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
    transcriptSegments,
    isInterviewerSpeaking,
    transcriptDisplayMode,
    showTranscript,
    handleTranslateTranscriptSegment,
    sttStatus,
    showSttErrorDetail,
    nativeAudioHealth,
    appearance,
    isLightTheme,
}) => {
    // Same moment AI chat shows bouncing dots: work started, first tokens not on screen yet
    const isAwaitingTranscript =
        sttStatus.label === 'STT listening (no transcript yet)' &&
        !transcriptSegments.some((s) => s.isStreaming);

    const hasTranscriptContent = transcriptSegments.length > 0 || isAwaitingTranscript;
    const placeholderText = 'Transcript will appear here when meeting audio is detected';

    return (
        <div className="flex h-full flex-col overflow-y-auto custom-scrollbar">
            <div className="flex-1">
                {showTranscript && hasTranscriptContent ? (
                    <RollingTranscript
                        segments={transcriptSegments}
                        displayMode={transcriptDisplayMode}
                        isActive={isInterviewerSpeaking}
                        isAwaitingTranscript={isAwaitingTranscript}
                        surfaceStyle={appearance.transcriptStyle}
                        onTranslateSegment={handleTranslateTranscriptSegment}
                    />
                ) : (
                    <div className="px-4 pt-3 pb-2 no-drag">
                        <div
                            className="rounded-2xl px-4 py-6 text-center text-sm text-text-tertiary"
                            style={{
                                // Avoid overlay-transcript-surface / transcriptStyle here: they set
                                // borderBottomColor:transparent, which breaks dashed+radius corners.
                                border: isLightTheme
                                    ? '1px dashed rgba(59, 130, 246, 0.28)'
                                    : '1px dashed rgba(255, 255, 255, 0.22)',
                                backgroundColor: isLightTheme
                                    ? 'rgba(245, 248, 252, 0.45)'
                                    : 'rgba(15, 18, 26, 0.34)',
                            }}
                        >
                            {placeholderText}
                        </div>
                    </div>
                )}
            </div>

            <div className="px-4 pt-2 pb-1 no-drag" aria-live="polite" aria-atomic="true">
                <div
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium border border-border-subtle/70 ${subtleSurfaceClass} ${sttStatus.toneClass}`}
                    style={appearance.subtleStyle}
                >
                    <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${sttStatus.dotClass}`} />
                    <span>{sttStatus.label}</span>
                    {showSttErrorDetail && <span className="opacity-80">- {nativeAudioHealth.lastError}</span>}
                </div>
            </div>
        </div>
    );
};

export default TranscriptPanel;
