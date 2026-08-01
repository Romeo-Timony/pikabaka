import React from 'react';
import TranscriptPanel from './TranscriptPanel';
import type { TranscriptDisplayMode, TranscriptSegment } from '../../lib/transcriptSegments';
import type { getOverlayAppearance } from '../../lib/overlayAppearance';

interface TranscriptColumnProps {
    transcriptSegments: TranscriptSegment[];
    isInterviewerSpeaking: boolean;
    transcriptDisplayMode: TranscriptDisplayMode;
    showTranscript: boolean;
    handleTranslateTranscriptSegment: (segment: TranscriptSegment) => void;
    sttStatus: { label: string; toneClass: string; dotClass: string };
    showSttErrorDetail: boolean;
    nativeAudioHealth: { lastError: string | null };
    appearance: ReturnType<typeof getOverlayAppearance>;
    isLightTheme: boolean;
}

const TranscriptColumn: React.FC<TranscriptColumnProps> = ({
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
    return (
        <TranscriptPanel
            transcriptSegments={transcriptSegments}
            isInterviewerSpeaking={isInterviewerSpeaking}
            transcriptDisplayMode={transcriptDisplayMode}
            showTranscript={showTranscript}
            handleTranslateTranscriptSegment={handleTranslateTranscriptSegment}
            sttStatus={sttStatus}
            showSttErrorDetail={showSttErrorDetail}
            nativeAudioHealth={nativeAudioHealth}
            appearance={appearance}
            isLightTheme={isLightTheme}
        />
    );
};

export default TranscriptColumn;
