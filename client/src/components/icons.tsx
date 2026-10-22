import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const MicIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </svg>
);

export const MicOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V5a3 3 0 0 0-5.9-.7" />
    <path d="M19 10v1a7 7 0 0 1-1.2 3.9M5 10v1a7 7 0 0 0 10.7 6M12 18v4" />
    <path d="M3 3l18 18" />
  </svg>
);

export const CamIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="2" y="6" width="13" height="12" rx="3" />
    <path d="M22 9.5 16.5 13l5.5 3.5v-7Z" />
  </svg>
);

export const CamOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M10.7 6H12a3 3 0 0 1 3 3v3.2M15.5 15.5A3 3 0 0 1 12 18H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h.5" />
    <path d="M22 9.5 16.5 13l5.5 3.5v-7ZM3 3l18 18" />
  </svg>
);

export const PhoneOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M10.7 13.4a15.9 15.9 0 0 1-4.1-4.1L4.3 11.6a2 2 0 0 0-.4 2.6l1.5 2.3a2 2 0 0 0 2.6.7l4.7-2.4" />
    <path d="M13.3 10.6a15.9 15.9 0 0 1 4.1 4.1l2.3-2.3a2 2 0 0 0 .4-2.6l-1.5-2.3a2 2 0 0 0-2.6-.7l-4.7 2.4" />
    <path d="M3 3l18 18" opacity="0.55" />
  </svg>
);

export const SpinnerIcon = (p: P) => (
  <svg {...base} {...p} className={`animate-spin ${p.className ?? ''}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

export const GlobeIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
  </svg>
);

export const UsersIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.8 19a6.4 6.4 0 0 1 12.4 0M16.5 5.3a3.2 3.2 0 0 1 0 5.6M18 13.6a6.4 6.4 0 0 1 3.2 4.4" />
  </svg>
);

export const AlertIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

export const ChatIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.4-4.1-1.1L3 20l1.1-5.4A8.5 8.5 0 1 1 21 11.5Z" />
  </svg>
);

export const EyeOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c5.5 0 9 6 9 6a15.6 15.6 0 0 1-3.1 3.7M6.3 7.7A15.8 15.8 0 0 0 3 12s3.5 6 9 6a9.2 9.2 0 0 0 4.2-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </svg>
);

export const ExpandIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" />
  </svg>
);

// ── Social platform navigation ──────────────────────────────────────────────

export const HomeIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3.5 10.5 12 3.8l8.5 6.7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1Z" />
  </svg>
);

export const CompassIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5Z" />
  </svg>
);

export const PlusIcon = (p: P) => (
  <svg {...base} {...p} strokeWidth={2.2}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const VideoIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="2.5" y="6" width="13" height="12" rx="3" />
    <path d="M21.5 9.5 16 13l5.5 3.5v-7Z" />
  </svg>
);

export const WalletIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1" />
    <rect x="3" y="8" width="18" height="11" rx="2.5" />
    <path d="M16.5 13.5h.01" />
  </svg>
);

export const UserIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8.2" r="3.6" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </svg>
);

export const HeartIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 20s-7.5-4.4-7.5-9.5A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 3.1C19.5 15.6 12 20 12 20Z" />
  </svg>
);

export const LockIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
);

export const SettingsIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <svg {...base} {...p} strokeWidth={2.2}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const ArrowLeftIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M19 12H5m6-7-7 7 7 7" />
  </svg>
);

export const FlameIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3s5 4 5 8.5A5 5 0 0 1 7 12c0-1.7.8-3 1.8-4 .3 1 1 1.7 1.9 1.7C12.6 9.7 12 6 12 3Z" />
    <path d="M12 21a5.5 5.5 0 0 0 5.5-5.5c0-1.2-.4-2.3-1-3.2" />
  </svg>
);

export const CommentIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l1.7-3.4A8 8 0 1 1 21 12Z" />
  </svg>
);

/** ISO-3166 alpha-2 → 🇰🇪 (regional indicator symbols). */
export function flagFromCountry(code: string): string {
  const c = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌍';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
