import type { Config } from "tailwindcss";

// S2 Signal palette — terminal-meets-premium-SaaS, themed via CSS variables.
//
// Every scale below resolves to an RGB triplet variable defined in
// globals.css, with light values under :root (the DEFAULT) and dark values
// under .dark. Component class names never change between themes.
//
// "ink-*"  surface/text scale (950 = app bg … 50 = primary text)
// "neon-*" accent — SingleStore purple, used sparingly
// amber/red/sky/violet — only the shades components actually use are themed
// so semantic colors keep AA contrast on both backgrounds.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const scale = (prefix: string, steps: number[]) =>
  Object.fromEntries(steps.map((s) => [s, v(`${prefix}-${s}`)]));

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: scale("ink", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        neon: scale("neon", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        amber: scale("amber", [200, 300, 400, 500]),
        red: scale("red", [200, 300, 400, 500]),
        sky: scale("sky", [400, 500]),
        violet: scale("violet", [300, 400, 500]),
        signal: {
          hiring: "#10b981", // emerald — engineering hiring
          oss: "#8b5cf6",    // violet — OSS / GitHub activity
          ma: "#d97706",     // amber — M&A
          funding: "#0284c7", // sky — funding rounds
          ai: "#db2777",     // pink — AI tooling spend / mentions
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-jetbrains)", "JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        "cursor-blink": {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.4s ease-out forwards",
        "pulse-dot": "pulse-dot 2s ease-in-out infinite",
        "cursor-blink": "cursor-blink 1.1s steps(1) infinite",
      },
      boxShadow: {
        glow: "0 0 24px -6px rgba(168, 85, 247, 0.45)",
        "glow-sm": "0 0 12px -3px rgba(168, 85, 247, 0.4)",
      },
    },
  },
  plugins: [],
};

export default config;
