/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#09090b", // fondo de página (zinc-950)
          card: "#18181b", // tarjetas (zinc-900)
          raised: "#27272a", // elementos elevados (zinc-800)
        },
        accent: {
          DEFAULT: "#f43f5e", // rose-500
          strong: "#e11d48", // rose-600
          soft: "#fda4af", // rose-300
        },
        series: {
          entries: "#f43f5e",
          exits: "#6366f1",
        },
        status: {
          good: "#10b981",
          warning: "#f59e0b",
          serious: "#f97316",
          critical: "#ef4444",
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 0 0 1px rgba(255,255,255,0.05), 0 8px 24px -12px rgba(0,0,0,0.6)",
        glow: "0 0 24px -4px rgba(244,63,94,0.45)",
      },
      keyframes: {
        pulseRing: {
          "0%": { transform: "scale(0.9)", opacity: "0.8" },
          "100%": { transform: "scale(1.8)", opacity: "0" },
        },
      },
      animation: {
        "pulse-ring": "pulseRing 1.6s cubic-bezier(0.2,0.6,0.4,1) infinite",
      },
    },
  },
  plugins: [],
};
