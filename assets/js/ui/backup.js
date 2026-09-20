/**
 * バックアップ（保存・復元）の共通処理。
 *
 * データは端末のブラウザ内にしかないので、バックアップはこのアプリの生命線。
 * アプリバーからいつでも保存でき、最後に保存してからの日数が分かるようにする。
 */
import { h, button } from './dom.js';
import { icon } from './icons.js';
import { openSheet, openDialog, confirmDialog, toast } from './overlays.js';
import { buildFilename, downloadText, readFileAsText, serializeBackup } from '../core/exporter.js';
import { formatDateTime } from '../core/date.js';

/** 最後のバックアップからの経過を、短い日本語にする */
export function backupLabel(status) {
  if (!status.last) return status.notes ? 'まだ保存していません' : 'メモがありません';
  if (status.days === 0) return '今日 保存しました';
  if (status.days === 1) return '昨日 保存しました';
  return `${status.days}日前に保存しました`;
}

/** バックアップを 1 つのファイルに保存する */
export async function saveBackupFile(store) {
  try {
    // 本文は開いたときに読む作りなので、控えを作る前にそろえておく。
    // 読めなかったときは、欠けた控えを作らずにやめる（あとで気づけないため）
    const ready = await store.ensureAllDocs();
    if (!ready) {
      toast('本文を読み込めなかったので、バックアップを取りやめました。もう一度お試しください。');
      return false;
    }
    downloadText(
      buildFilename('forgetting-curve-backup', 'json'),
      serializeBackup(store.exportData()),
      'application/json',
    );
    store.markBackedUp();
    toast('バックアップを保存しました');
    return true;
  } catch (err) {
    console.error('[fcc] バックアップの保存に失敗しました', err);
    toast('バックアップを保存できませんでした');
    return false;
  }
}

/** ファイルを選んで復元する */
export function pickBackupFile(store) {
  const input = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: { display: 'none' },
    onChange: async (e) => {
      const file = e.target.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const raw = JSON.parse(await readFileAsText(file));
        openRestoreDialog(store, raw);
      } catch (err) {
        console.error(err);
        toast('ファイルを読み込めませんでした（JSON 形式ではありません）');
      }
    },
  });
  document.body.appendChild(input);
  input.click();
}

export function openRestoreDialog(store, raw) {
  const count = Array.isArray(raw?.notes) ? raw.notes.length : 0;
  openDialog({
    title: 'バックアップから復元',
    variant: 'alert',
    content: h('div', {},
      h('p', { style: { color: 'var(--fcc-on-surface-variant)' } },
        `${count} 件のメモが見つかりました。復元方法を選んでください。`),
      h('p', { class: 'field__hint' },
        '「置き換え」は今のデータを消して復元します。「追加」は今のデータを残したまま、未登録のメモだけを取り込みます。')),
    actions: [
      { label: 'キャンセル', className: 'btn btn--text', onClick: (close) => close() },
      {
        label: '追加',
        className: 'btn btn--tonal',
        onClick: async (close) => {
          const res = store.importData(raw, 'merge');
          // 保存できたことを確かめてから「できました」と言う
          const saved = await store.flush();
          if (!saved.ok) { toast('復元しましたが、保存できませんでした。空き容量をご確認ください。'); return; }
          toast(`${res.imported} 件を追加しました（重複 ${res.skipped} 件はスキップ）`);
          close();
        },
      },
      {
        label: '置き換え',
        className: 'btn',
        onClick: async (close) => {
          const ok = await confirmDialog({
            title: '置き換えますか？',
            message: '今のメモと復習の記録は削除されます。',
            confirmLabel: '置き換える',
            danger: true,
          });
          if (!ok) return;
          const res = store.importData(raw, 'replace');
          const saved = await store.flush();
          if (!saved.ok) { toast('復元しましたが、保存できませんでした。空き容量をご確認ください。'); return; }
          toast(`${res.imported} 件を復元しました`);
          close();
        },
      },
    ],
  });
}

/** アプリバーから開くバックアップのパネル */
export function openBackupSheet(store) {
  const status = store.backupStatus();
  const content = h('div', {},
    h('h2', { class: 'daypanel__date', style: { marginBottom: '4px' } }, 'バックアップ'),
    h('div', { class: 'backup-status' },
      h('span', {
        class: `backup-status__dot ${status.stale ? 'backup-status__dot--stale' : ''}`,
      }),
      h('div', {},
        h('div', { class: 'backup-status__label' }, backupLabel(status)),
        status.last
          ? h('div', { class: 'field__hint' },
            `${formatDateTime(status.last)}`
            + `${status.changedSince ? '・そのあとに変更があります' : '・そのあと変更はありません'}`)
          : h('div', { class: 'field__hint' }, 'このアプリのデータは、この端末のブラウザ内だけにあります。'))),

    status.stale
      ? h('div', { class: 'banner banner--warning', style: { margin: '12px 0' } },
        h('span', { html: icon('info', { size: 18 }), style: { display: 'flex' } }),
        h('span', { style: { flex: '1' } },
          'ブラウザの履歴を消したり、機種を変えるとメモは失われます。ときどき保存しておくと安心です。'))
      : null,

    h('div', { class: 'note-card__actions', style: { marginTop: '12px' } },
      button('バックアップを保存', {
        className: 'btn',
        icon: icon('download', { size: 18 }),
        onClick: () => saveBackupFile(store),
      }),
      button('復元する', {
        className: 'btn btn--tonal',
        icon: icon('upload', { size: 18 }),
        onClick: () => pickBackupFile(store),
      })),

    h('div', { class: 'field__hint', style: { marginTop: '12px' } },
      `メモ ${status.notes} 件・保存先は「${store.adapter.label ?? store.adapter.id}」。`
      + 'ファイルは JSON 形式で、設定と復習の記録もすべて含まれます。'));

  return openSheet({ title: 'バックアップ', content });
}
