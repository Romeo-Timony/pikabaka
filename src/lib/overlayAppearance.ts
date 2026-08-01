import type React from 'react';

export type OverlayTheme = 'light' | 'dark';

export interface OverlayAppearance {
    shellStyle: React.CSSProperties;
    pillStyle: React.CSSProperties;
    transcriptStyle: React.CSSProperties;
    subtleStyle: React.CSSProperties;
    chipStyle: React.CSSProperties;
    inputStyle: React.CSSProperties;
    controlStyle: React.CSSProperties;
    iconStyle: React.CSSProperties;
    codeBlockStyle: React.CSSProperties;
    codeHeaderStyle: React.CSSProperties;
    dividerStyle: React.CSSProperties;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const mix = (min: number, max: number, value: number) => min + ((max - min) * value);

export const OVERLAY_OPACITY_MIN = 0.35;
export const OVERLAY_OPACITY_MAX = 1;
/** @deprecated Use getDefaultOverlayOpacity() for theme-aware default. */
export const OVERLAY_OPACITY_DEFAULT = 0.65;
export const OVERLAY_OPACITY_DEFAULT_DARK = 0.84;
export const OVERLAY_OPACITY_DEFAULT_LIGHT = 0.78;

/** Returns the correct default opacity based on the currently active theme. */
export const getDefaultOverlayOpacity = (): number =>
    document.documentElement.getAttribute('data-theme') === 'light'
        ? OVERLAY_OPACITY_DEFAULT_LIGHT
        : OVERLAY_OPACITY_DEFAULT_DARK;

export const clampOverlayOpacity = (opacity: number) => clamp(opacity, OVERLAY_OPACITY_MIN, OVERLAY_OPACITY_MAX);

const normalizeOpacity = (opacity: number) =>
    (clampOverlayOpacity(opacity) - OVERLAY_OPACITY_MIN) / (OVERLAY_OPACITY_MAX - OVERLAY_OPACITY_MIN);
const scale = (min: number, max: number, strength: number, ease = 1) =>
    mix(min, max, Math.pow(clamp(strength, 0, 1), ease));

export const getOverlayAppearance = (opacity: number, theme: OverlayTheme): OverlayAppearance => {
    const strength = normalizeOpacity(opacity);
    const surfaceStrength = Math.pow(strength, 1.02);
    const blurStrength = Math.pow(strength, 0.94);

    if (theme === 'light') {
        return {
            shellStyle: {
                // Wide alpha range so the settings slider is visibly different end-to-end
                backgroundColor: `rgba(247, 249, 253, ${scale(0.28, 0.97, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.06, 0.17, surfaceStrength)})`,
                boxShadow: `0 24px 48px rgba(59, 130, 246, ${scale(0.01, 0.08, surfaceStrength)})`,
                backdropFilter: `blur(${scale(4, 17, blurStrength)}px) saturate(132%)`,
                WebkitBackdropFilter: `blur(${scale(4, 17, blurStrength)}px) saturate(132%)`,
            },
            pillStyle: {
                backgroundColor: `rgba(255, 255, 255, ${scale(0.22, 0.96, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.05, 0.155, surfaceStrength)})`,
                boxShadow: `0 12px 28px rgba(59, 130, 246, ${scale(0.01, 0.06, surfaceStrength)})`,
                backdropFilter: `blur(${scale(3, 10, blurStrength)}px) saturate(130%)`,
                WebkitBackdropFilter: `blur(${scale(3, 10, blurStrength)}px) saturate(130%)`,
            },
            transcriptStyle: {
                backgroundColor: 'transparent',
                borderBottomColor: 'transparent',
                backdropFilter: 'none',
                WebkitBackdropFilter: 'none',
            },
            subtleStyle: {
                backgroundColor: `rgba(245, 248, 252, ${scale(0.2, 0.9, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.04, 0.13, surfaceStrength)})`,
            },
            chipStyle: {
                backgroundColor: `rgba(248, 250, 253, ${scale(0.22, 0.92, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.04, 0.13, surfaceStrength)})`,
            },
            inputStyle: {
                backgroundColor: `rgba(255, 255, 255, ${scale(0.3, 0.96, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.05, 0.145, surfaceStrength)})`,
            },
            controlStyle: {
                backgroundColor: `rgba(248, 250, 253, ${scale(0.24, 0.92, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.05, 0.145, surfaceStrength)})`,
            },
            iconStyle: {
                backgroundColor: `rgba(248, 250, 253, ${scale(0.22, 0.88, surfaceStrength)})`,
            },
            codeBlockStyle: {
                backgroundColor: `rgba(242, 246, 252, ${scale(0.28, 0.94, surfaceStrength)})`,
                borderColor: `rgba(59, 130, 246, ${scale(0.05, 0.145, surfaceStrength)})`,
            },
            codeHeaderStyle: {
                backgroundColor: `rgba(234, 240, 249, ${scale(0.3, 0.96, surfaceStrength)})`,
                borderBottomColor: `rgba(59, 130, 246, ${scale(0.05, 0.155, surfaceStrength)})`,
            },
            dividerStyle: {
                backgroundColor: `rgba(59, 130, 246, ${scale(0.05, 0.15, surfaceStrength)})`,
            },
        };
    }

    return {
        shellStyle: {
            // Previous range (0.92–0.975) made the slider look broken — almost no visible change.
            backgroundColor: `rgba(24, 27, 34, ${scale(0.22, 0.96, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.05, 0.15, surfaceStrength)})`,
            boxShadow: `0 24px 48px rgba(0, 0, 0, ${scale(0.04, 0.23, surfaceStrength)})`,
            backdropFilter: `blur(${scale(4, 18, blurStrength)}px) saturate(130%)`,
            WebkitBackdropFilter: `blur(${scale(4, 18, blurStrength)}px) saturate(130%)`,
        },
        pillStyle: {
            backgroundColor: `rgba(27, 30, 37, ${scale(0.18, 0.95, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.05, 0.145, surfaceStrength)})`,
            boxShadow: `0 12px 28px rgba(0, 0, 0, ${scale(0.02, 0.16, surfaceStrength)})`,
            backdropFilter: `blur(${scale(3, 12, blurStrength)}px) saturate(128%)`,
            WebkitBackdropFilter: `blur(${scale(3, 12, blurStrength)}px) saturate(128%)`,
        },
        transcriptStyle: {
            backgroundColor: 'transparent',
            borderBottomColor: 'transparent',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
        },
        subtleStyle: {
            backgroundColor: `rgba(40, 45, 54, ${scale(0.16, 0.88, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.03, 0.085, surfaceStrength)})`,
        },
        chipStyle: {
            backgroundColor: `rgba(50, 56, 66, ${scale(0.18, 0.9, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.03, 0.085, surfaceStrength)})`,
        },
        inputStyle: {
            backgroundColor: `rgba(44, 49, 60, ${scale(0.24, 0.92, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.035, 0.095, surfaceStrength)})`,
        },
        controlStyle: {
            backgroundColor: `rgba(47, 52, 62, ${scale(0.2, 0.89, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.035, 0.095, surfaceStrength)})`,
        },
        iconStyle: {
            backgroundColor: `rgba(50, 56, 66, ${scale(0.18, 0.86, surfaceStrength)})`,
        },
        codeBlockStyle: {
            backgroundColor: `rgba(32, 37, 46, ${scale(0.26, 0.94, surfaceStrength)})`,
            borderColor: `rgba(255, 255, 255, ${scale(0.035, 0.105, surfaceStrength)})`,
        },
        codeHeaderStyle: {
            backgroundColor: `rgba(43, 48, 58, ${scale(0.22, 0.9, surfaceStrength)})`,
            borderBottomColor: `rgba(255, 255, 255, ${scale(0.035, 0.105, surfaceStrength)})`,
        },
        dividerStyle: {
            backgroundColor: `rgba(255, 255, 255, ${scale(0.04, 0.12, surfaceStrength)})`,
        },
    };
};
