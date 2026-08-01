import { useCallback, useEffect, useRef, useState } from 'react';
import { upsertTranscriptSegment, type TranscriptDisplayMode, type TranscriptSegment } from '../lib/transcriptSegments';

export function useMeetingTranscript() {
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [isInterviewerSpeaking, setIsInterviewerSpeaking] = useState(false);
  const [transcriptDisplayMode, setTranscriptDisplayMode] = useState<TranscriptDisplayMode>('original');
  const [showTranscript, setShowTranscript] = useState(() => {
    const stored = localStorage.getItem('pika_interviewer_transcript');
    return stored !== 'false';
  });
  const speakingTimeoutRef = useRef<number | null>(null);
  /** Stable client id for the in-flight interviewer utterance (AI-style in-place stream). */
  const liveInterviewerSegmentIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.electronAPI?.getTranscriptTranslationSettings?.()
      .then((settings) => {
        if (settings?.displayMode) {
          setTranscriptDisplayMode(settings.displayMode);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem('pika_interviewer_transcript', String(showTranscript));
  }, [showTranscript]);

  useEffect(() => {
    const handleStorage = () => {
      const stored = localStorage.getItem('pika_interviewer_transcript');
      setShowTranscript(stored !== 'false');
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onNativeAudioTranscript) return;

    return window.electronAPI.onNativeAudioTranscript((transcript) => {
      if (transcript.speaker === 'user') {
        if (transcript.final) {
          const normalizedSegmentId =
            transcript.segmentId ||
            `user_${transcript.timestamp || Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          setTranscriptSegments((prev) =>
            upsertTranscriptSegment(prev, {
              final: true,
              text: transcript.text,
              sourceText: transcript.sourceText,
              translatedText: transcript.translatedText,
              segmentId: normalizedSegmentId,
              speaker: 'user',
              speakerLabel: 'Me',
              timestamp: transcript.timestamp,
              translationState: transcript.translationState,
              detectedLanguage: transcript.detectedLanguage,
              revision: transcript.revision,
              isStreaming: false,
            })
          );

          if (transcript.displayMode) {
            setTranscriptDisplayMode(transcript.displayMode);
          }
        }
        return;
      }

      if (transcript.speaker !== 'interviewer') {
        return;
      }

      setIsInterviewerSpeaking(!transcript.final);

      if (transcript.final) {
        const serverSegmentId =
          transcript.segmentId || `legacy_${transcript.timestamp || Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const speakerFromPayload = transcript.speakerLabel?.trim();
        const liveId = liveInterviewerSegmentIdRef.current;
        liveInterviewerSegmentIdRef.current = null;

        setTranscriptSegments((prev) => {
          // Finalize the same bubble that was streaming (keep React key stable).
          if (liveId) {
            const idx = prev.findIndex((s) => s.segmentId === liveId);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                sourceText: (transcript.sourceText || transcript.text || '').trim() || next[idx].sourceText,
                translatedText: transcript.translatedText?.trim() || next[idx].translatedText,
                speakerLabel: speakerFromPayload || next[idx].speakerLabel,
                translationState: transcript.translationState || next[idx].translationState,
                detectedLanguage: transcript.detectedLanguage || next[idx].detectedLanguage,
                revision: transcript.revision ?? next[idx].revision,
                isStreaming: false,
                serverSegmentId,
              };
              return next;
            }
          }

          return upsertTranscriptSegment(prev, {
            final: true,
            text: transcript.text,
            sourceText: transcript.sourceText,
            translatedText: transcript.translatedText,
            segmentId: serverSegmentId,
            speaker: 'interviewer',
            speakerLabel: speakerFromPayload || undefined,
            timestamp: transcript.timestamp,
            translationState: transcript.translationState,
            detectedLanguage: transcript.detectedLanguage,
            revision: transcript.revision,
            isStreaming: false,
          });
        });

        if (transcript.displayMode) {
          setTranscriptDisplayMode(transcript.displayMode);
        }

        if (speakingTimeoutRef.current) {
          window.clearTimeout(speakingTimeoutRef.current);
        }
        speakingTimeoutRef.current = window.setTimeout(() => {
          setIsInterviewerSpeaking(false);
          speakingTimeoutRef.current = null;
        }, 3000);
      } else {
        // Interim: append/update one streaming segment — same pattern as AI token stream.
        if (!liveInterviewerSegmentIdRef.current) {
          liveInterviewerSegmentIdRef.current = `live_interviewer_${Date.now()}`;
        }
        const liveId = liveInterviewerSegmentIdRef.current;
        setTranscriptSegments((prev) =>
          upsertTranscriptSegment(prev, {
            final: false,
            text: transcript.text,
            sourceText: transcript.sourceText || transcript.text,
            segmentId: liveId,
            speaker: 'interviewer',
            speakerLabel: transcript.speakerLabel?.trim() || undefined,
            timestamp: transcript.timestamp,
            translationState: 'skipped',
            detectedLanguage: transcript.detectedLanguage,
            isStreaming: true,
          })
        );
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (speakingTimeoutRef.current) {
        window.clearTimeout(speakingTimeoutRef.current);
      }
    };
  }, []);

  const handleTranslateTranscriptSegment = useCallback(async (segment: TranscriptSegment) => {
    const translateId = segment.serverSegmentId || segment.segmentId;
    try {
      const result = await window.electronAPI.translateTranscriptSegment({
        segmentId: translateId,
        text: segment.sourceText,
        speaker: segment.speakerLabel === 'Me' ? 'user' : 'interviewer',
        speakerLabel: segment.speakerLabel,
        timestamp: segment.timestamp,
      });

      if (!result?.success) {
        setTranscriptSegments((prev) =>
          upsertTranscriptSegment(prev, {
            final: true,
            text: segment.sourceText,
            sourceText: segment.sourceText,
            segmentId: segment.segmentId,
            speakerLabel: segment.speakerLabel,
            timestamp: segment.timestamp,
            translationState: 'error',
            isStreaming: false,
          })
        );
      }
    } catch {
      setTranscriptSegments((prev) =>
        upsertTranscriptSegment(prev, {
          final: true,
          text: segment.sourceText,
          sourceText: segment.sourceText,
          segmentId: segment.segmentId,
          speakerLabel: segment.speakerLabel,
          timestamp: segment.timestamp,
          translationState: 'error',
          isStreaming: false,
        })
      );
    }
  }, []);

  return {
    transcriptSegments,
    isInterviewerSpeaking,
    transcriptDisplayMode,
    setTranscriptDisplayMode,
    showTranscript,
    setShowTranscript,
    handleTranslateTranscriptSegment,
  };
}
