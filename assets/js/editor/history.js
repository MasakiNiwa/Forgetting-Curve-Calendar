/**
 * 編集履歴（元に戻す / やり直す）。
 *
 * textarea の標準の履歴は、プログラムから本文を書き換えると壊れてしまう。
 * 置換や一括挿入も 1 回で戻せるようにするため、履歴は自分で持つ。
 *
 * - 記録するのは「本文・選択範囲」の組
 * - 連続した文字入力はまとめる（時間と位置が近ければ 1 手とみなす）
 * - 日本語入力の変換中は記録しない（確定してから 1 手として記録する）
 */
export class EditHistory {
  constructor({ limit = 200, coalesceMs = 600 } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.past = [];
    this.future = [];
    this.current = null;
    this.lastAt = 0;
    this.lastKind = null;
  }

  /** 初期状態を入れる（履歴には積まない） */
  reset(snapshot) {
    this.past = [];
    this.future = [];
    this.current = { ...snapshot };
    this.lastAt = 0;
    this.lastKind = null;
  }

  /**
   * 変更を記録する。
   * @param {{text:string, start:number, end:number}} snapshot 変更後の状態
   * @param {{kind?:string, coalesce?:boolean}} options kind が変わると必ず 1 手を区切る
   */
  push(snapshot, { kind = 'input', coalesce = true } = {}) {
    if (!this.current) { this.reset(snapshot); return; }
    if (this.current.text === snapshot.text) {
      this.current = { ...snapshot };
      return;
    }
    const now = Date.now();
    const mergeable = coalesce
      && kind === 'input'
      && this.lastKind === 'input'
      && now - this.lastAt < this.coalesceMs;

    if (!mergeable) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = { ...snapshot };
    this.future = [];
    this.lastAt = now;
    this.lastKind = kind;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo() {
    if (!this.past.length) return null;
    this.future.push(this.current);
    this.current = this.past.pop();
    this.lastKind = null;
    return { ...this.current };
  }

  redo() {
    if (!this.future.length) return null;
    this.past.push(this.current);
    this.current = this.future.pop();
    this.lastKind = null;
    return { ...this.current };
  }
}
