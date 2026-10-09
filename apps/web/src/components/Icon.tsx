/** Контурные иконки 24×24 (свои, по сетке дизайн-системы). */
const paths: Record<string, string> = {
  all: 'M4 5h16v11H8l-4 4z',
  cases: 'M8 4h8v3H8zM6 6H5v15h14V6h-1M9 12h6M9 16h4',
  direct: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6',
  channels: 'M4 10v4h3l6 4V6L7 10zM17 9a4 4 0 0 1 0 6',
  service: 'M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5L15 12l-3-3z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  send: 'M4 12l16-8-6 16-3-7z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  check: 'M5 12l4 4 10-10',
  phone: 'M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  'mic-off': 'M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18',
  'video-off': 'M3 7h3m4 0h5v5m0 5H3V7M15 10l6-3v10l-6-3M3 3l18 18',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4M12 13V8M9.5 10.5L12 8l2.5 2.5',
  hangup: 'M3 15c5-5 13-5 18 0l-2 3-4-1.5v-2.5a10 10 0 0 0-6 0v2.5L5 18z',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  transcript: 'M6 3h9l4 4v14H6zM15 3v4h4M9 11h7M9 15h7M9 19h4',
  reply: 'M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1',
  attach: 'M20 11.5l-8.3 8.3a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  close: 'M6 6l12 12M18 6L6 18',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-4 3-6 7-6s7 2 7 6M16 3.5a4 4 0 0 1 0 7M18 15c2.5.6 4 2.6 4 6',
  next: 'M5 5l7 7-7 7M13 5l7 7-7 7',
};

export function Icon({ name, size = 22 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name] ?? paths.all} />
    </svg>
  );
}
