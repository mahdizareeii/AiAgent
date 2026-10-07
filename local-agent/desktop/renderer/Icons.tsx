import type { CSSProperties } from 'react';

type IconName = 'plus' | 'arrow' | 'folder' | 'attach' | 'code' | 'search' | 'spark' | 'settings' | 'check' | 'close' | 'download' | 'stop' | 'external' | 'undo' | 'chevron' | 'chat' | 'shield' | 'monitor';

const paths: Record<IconName, string> = {
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
};

export default function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
