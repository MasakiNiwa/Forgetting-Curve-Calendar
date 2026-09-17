/**
 * インラインSVGアイコン（24x24 / stroke ベース）。
 * 外部フォントに依存せず、オフラインでも確実に表示されるようにしている。
 */
const PATHS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  notes: '<path d="M8 6h12M8 12h12M8 18h8"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  settings: '<path d="M4 7h5M13 7h7M4 12h11M19 12h1M4 17h3M11 17h9"/><circle cx="11" cy="7" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="9" cy="17" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 1 1 3.4 2.6c-.6.2-1 .8-1 1.4v.6"/><path d="M12 17.2h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M4 20.5h4L18.6 9.9a2.2 2.2 0 1 0-3.1-3.1L5 17.4v3.1z"/><path d="M14.5 7.9l3.1 3.1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7M9.5 7V4.6a.6.6 0 0 1 .6-.6h3.8a.6.6 0 0 1 .6.6V7"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  check: '<path d="M5 12.8l4.4 4.4L19 7.6"/>',
  download: '<path d="M12 3.5v11.5M7.5 10.5L12 15l4.5-4.5M4.5 20h15"/>',
  upload: '<path d="M12 20.5V9M7.5 13.5L12 9l4.5 4.5M4.5 4h15"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M5 15.2V5.8A2.8 2.8 0 0 1 7.8 3h7.4"/>',
  back: '<path d="M20 12H4.5M10.5 5.5L4 12l6.5 6.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H11"/>',
  target: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="M20 20l-4.4-4.4"/>',
  tag: '<path d="M3.5 12.4V5.2a1.7 1.7 0 0 1 1.7-1.7h7.2l8.1 8.1a1.7 1.7 0 0 1 0 2.4l-6.6 6.6a1.7 1.7 0 0 1-2.4 0z"/><circle cx="8" cy="8" r="1.4"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 2"/>',
  refresh: '<path d="M20.2 11.6a8.2 8.2 0 1 0-.9 4.6"/><path d="M20.5 5.4v6.2h-6.2"/>',
  branch: '<path d="M6 4v8.2A3.3 3.3 0 0 0 9.3 15.5H18"/><path d="M15 12.5l3.5 3-3.5 3"/>',
  graduate: '<path d="M12 4L2.5 8.6 12 13.2l9.5-4.6L12 4z"/><path d="M6.5 10.8v4.4c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-4.4"/>',
  curve: '<path d="M4 4v16h16"/><path d="M4 7.5c8.5 0 4.5 10.5 16 10.5"/>',
  more: '<circle cx="12" cy="5.2" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.8" r="1.4" fill="currentColor" stroke="none"/>',
  light: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2M12 19.4v2M21.4 12h-2M4.6 12h-2M18.4 5.6L17 7M7 17l-1.4 1.4M18.4 18.4L17 17M7 7L5.6 5.6"/>',
  dark: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.6 8.6 0 1 0 20 14.2z"/>',
  auto: '<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v16.8" /><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/>',
  archive: '<rect x="3" y="4.5" width="18" height="4.5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
  play: '<path d="M7 4.8l12 7.2-12 7.2z"/>',
  skip: '<path d="M5.5 6l7 6-7 6zM17 5.5v13"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4M6.6 7.7A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6"/><path d="M9.9 10.2a3 3 0 0 0 4 4.1"/>',
  note: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.6M9 12h6M9 16h4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  undo: '<path d="M4 8.5h10.5a5.5 5.5 0 0 1 0 11H8"/><path d="M7.5 4.5L3.5 8.5l4 4"/>',
  redo: '<path d="M20 8.5H9.5a5.5 5.5 0 0 0 0 11H16"/><path d="M16.5 4.5l4 4-4 4"/>',
  checkbox: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12.2l2.8 2.8L16.5 9.3"/>',
  indent: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M3 8.5L6 12l-3 3.5z" fill="currentColor" stroke="none"/>',
  outdent: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M6 8.5L3 12l3 3.5z" fill="currentColor" stroke="none"/>',
  replace: '<path d="M4 6h8M4 6l2.5-2.5M4 6l2.5 2.5"/><path d="M20 18h-8M20 18l-2.5-2.5M20 18l-2.5 2.5"/><path d="M15 4.5h2.5A2.5 2.5 0 0 1 20 7v2M9 19.5H6.5A2.5 2.5 0 0 1 4 17v-2"/>',
  save: '<path d="M5.5 4.5h10L19.5 8.5v11h-14z"/><path d="M8.5 4.5v5h7v-5M8.5 19.5v-6h7v6"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  flag: '<path d="M6 21V4M6 4h11l-2 3.5L17 11H6"/>',
  layers: '<path d="M12 3l9 4.5-9 4.5-9-4.5L12 3z"/><path d="M3 12l9 4.5L21 12M3 16.5L12 21l9-4.5"/>',
};

/**
 * @param {keyof PATHS} name
 * @param {{size?:number, className?:string}} options
 * @returns {string} SVG markup
 */
export function icon(name, { size = 24, className = '' } = {}) {
  const body = PATHS[name] || PATHS.info;
  const cls = ['fcc-icon', className].filter(Boolean).join(' ');
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${body}</svg>`;
}

export const iconNames = Object.keys(PATHS);
