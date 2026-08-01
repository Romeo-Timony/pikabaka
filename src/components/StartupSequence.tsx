import React, { useEffect } from 'react';
import { motion } from 'framer-motion';

interface StartupSequenceProps {
    onComplete: () => void;
}

const StartupSequence: React.FC<StartupSequenceProps> = ({ onComplete }) => {
    useEffect(() => {
        const timer = setTimeout(() => {
            onComplete();
        }, 2200);
        return () => clearTimeout(timer);
    }, [onComplete]);

    return (
        <div className="fixed inset-0 z-overlay bg-[#000000] flex flex-col items-center justify-center overflow-hidden">
            <motion.div
                className="absolute w-96 h-96 bg-white/10 rounded-full blur-[120px]"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1.2 }}
                transition={{ duration: 3, ease: "easeOut" }}
            />

            <motion.p
                className="relative z-10 font-sans text-2xl md:text-3xl tracking-tight text-text-primary"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            >
                Pika
            </motion.p>

            <p
                className="relative z-10 mt-4 font-sans text-base md:text-lg italic tracking-label text-text-secondary opacity-0 animate-fade-in-up"
                style={{
                    animationDelay: 'var(--motion-slow)',
                    animationDuration: 'calc(var(--motion-slow) + var(--motion-base))',
                }}
            >
                Hear. Think. Speak — with an AI in the loop.
            </p>
        </div>
    );
};

export default StartupSequence;
