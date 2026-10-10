import type { ReactNode } from 'react';

/*
 * Small stroke icons in the SF Symbols spirit: 1.8 px strokes,
 * round caps, drawn on a 24 grid. Inline so there is no
 * icon font to load and nothing to fetch offline.
 */
function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon size={18}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const ShareIcon = () => (
  <Icon>
    <path d="M12 3v12M8 7l4-4 4 4" />
    <path d="M6 11H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1" />
  </Icon>
);

export const PrintIcon = () => (
  <Icon>
    <path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2" />
    <rect x="7" y="14" width="10" height="6" rx="1" />
  </Icon>
);

export const CodeIcon = () => (
  <Icon>
    <path d="m9 8-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12" />
  </Icon>
);

export const LocateIcon = () => (
  <Icon>
    <path d="M20 4 4 10.5l6.5 2.2L12.7 20z" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon size={18}>
    <path d="M20 11a8 8 0 0 0-14.6-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.4L20 16M20 20v-4h-4" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon size={14}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon size={16}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

/** Widen the report panel — corners pull outward. */
export const ExpandIcon = () => (
  <Icon size={18}>
    <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
  </Icon>
);

/** Narrow the report panel back — corners pull inward. */
export const CollapseIcon = () => (
  <Icon size={18}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Icon>
);

/** The product mark. Same drawing as public/favicon.svg. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="zk-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0a84ff" />
          <stop offset="1" stopColor="#5e5ce6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#zk-logo)" />
      <path
        d="M14 38 L24 16 L44 12 L52 30 L40 50 L20 48 Z"
        fill="rgba(255,255,255,.22)"
        stroke="#fff"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <circle cx="34" cy="31" r="5.5" fill="#fff" />
    </svg>
  );
}
