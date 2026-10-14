import type { CSSProperties } from 'react';

type IconName = 'brand' | 'plus' | 'arrow' | 'folder' | 'attach' | 'code' | 'search' | 'spark' | 'settings' | 'check' | 'close' | 'download' | 'stop' | 'external' | 'undo' | 'chevron' | 'chat' | 'shield' | 'monitor' | 'sun' | 'moon' | 'plugin' | 'back';

const paths: Record<IconName, string> = {
  brand: 'M8 18V6h9M8 12h7',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  attach: 'm9 15 7-7a3 3 0 0 0-4-4l-8 8a5 5 0 0 0 7 7l8-8',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1 5 5',
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm3 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  stop: 'M6 6h12v12H6Z',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  undo: 'M9 4 3 10l6 6M3 10h10a7 7 0 0 1 7 7v3',
  chevron: 'm8 5 7 7-7 7',
  chat: 'M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Zm-4 9 3 3 5-6',
  monitor: 'M3 4h18v13H3Zm5 17h8m-4-4v4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z',
  plugin: 'M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 1 6 0h5v-6a3 3 0 1 0 0-6V3h-6a3 3 0 1 1-6 0Z',
  back: 'M19 12H5m6-6-6 6 6 6',
};

export default function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    {name === 'brand' ? <><rect x="1.2" y="1.2" width="21.6" height="21.6" rx="6" fill="currentColor" opacity=".12" stroke="currentColor" strokeWidth=".8" /><ellipse cx="12" cy="12" rx="8.7" ry="5.6" transform="rotate(-32 12 12)" stroke="currentColor" strokeWidth=".8" opacity=".76" /><path d="m12 5.5 1.25 5.25L18.5 12l-5.25 1.25L12 18.5l-1.25-5.25L5.5 12l5.25-1.25L12 5.5Z" fill="currentColor" stroke="none" /><circle cx="18.9" cy="6.3" r="1.25" fill="currentColor" stroke="none" /></> : <path d={paths[name]} />}
  </svg>;
}
