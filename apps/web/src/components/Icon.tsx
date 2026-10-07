/** Контурные иконки 24×24 (свои, по сетке дизайн-системы). */
const paths: Record<string, string> = {
  all: 'M4 5h16v11H8l-4 4z',
  cases: 'M8 4h8v3H8zM6 6H5v15h14V6h-1M9 12h6M9 16h4',
  direct: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6',
  channels: 'M4 10v4h3l6 4V6L7 10zM17 9a4 4 0 0 1 0 6',
  service: 'M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5L15 12l-3-3z',
  send: 'M4 12l16-8-6 16-3-7z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  check: 'M5 12l4 4 10-10',
};

export function Icon({ name, size = 22 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name] ?? paths.all} />
    </svg>
  );
}
