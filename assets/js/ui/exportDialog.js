/** エクスポート用ダイアログ（メモ単体 / 全件 共通） */
import { h, button } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast } from './overlays.js';
import {
  FORMATS, buildFilename, copyText, downloadText, getFormat, serializeNotes,
} from '../core/exporter.js';

/**
 * @param {Store} store
 * @param {Array} notes 出力対象
 * @param {{title?:string, baseName?:string}} options
 */
export async function openExportDialog(store, notes, { title = 'メモを出力', baseName = 'notes' } = {}) {
  // 本文は開いたときに読む作りなので、出す前にそろえておく
  await store.ensureDocs(notes);
  if (notes.some((note) => store.docUnavailable(note))) {
    toast('本文を読み込めなかったので、出力を取りやめました。もう一度お試しください。');
    return null;
  }
  let formatId = store.settings.defaultExportFormat;

  const preview = h('pre', {
    class: 'export-preview',
    style: {
      maxHeight: '220px', overflow: 'auto', fontSize: '.74rem', lineHeight: '1.5',
      background: 'var(--fcc-surface-container-lowest)', padding: '12px',
      borderRadius: 'var(--fcc-radius-s)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      border: '1px solid var(--fcc-outline-variant)', margin: 0,
    },
  });

  const render = () => {
    const text = serializeNotes(notes, formatId, { store });
    preview.textContent = text.length > 4000 ? `${text.slice(0, 4000)}\n…（省略）` : text;
    return text;
  };

  const chips = h('div', { class: 'filter-row' },
    ...FORMATS.map((f) => {
      const chip = h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(f.id === formatId),
        onClick: () => {
          formatId = f.id;
          [...chips.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.format === f.id)));
          render();
        },
        dataset: { format: f.id },
      }, f.label);
      return chip;
    }));

  render();

  const content = h('div', {},
    h('p', { class: 'card__desc' }, `${notes.length} 件のメモを書き出します。形式を選んでください。`),
    chips,
    h('div', { style: { height: '12px' } }),
    preview);

  openDialog({
    title,
    content,
    actions: [
      {
        label: 'コピー',
        className: 'btn btn--text',
        onClick: async () => {
          const ok = await copyText(serializeNotes(notes, formatId, { store }));
          toast(ok ? 'クリップボードにコピーしました' : 'コピーできませんでした');
        },
      },
      {
        label: 'ダウンロード',
        className: 'btn',
        onClick: (close) => {
          const fmt = getFormat(formatId);
          downloadText(
            buildFilename(baseName, fmt.ext),
            serializeNotes(notes, formatId, { store }),
            fmt.mime,
          );
          toast('ファイルを保存しました');
          close();
        },
      },
    ],
  });
}

export function exportButton(label, onClick) {
  return button(label, { className: 'btn btn--tonal', icon: icon('download', { size: 18 }), onClick });
}
