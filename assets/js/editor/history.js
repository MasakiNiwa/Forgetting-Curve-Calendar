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
    /** 直前の入力のカーソル位置と増減。続きの入力かどうかの判定に使う。 */
    this.lastCaret = 0;
    this.lastDelta = 0;
    /** 直前が 1 文字ずつの入力だったか（貼り付けの直後は必ず区切る） */
    this.lastSingle = false;
  }

  /** 初期状態を入れる（履歴には積まない） */
  reset(snapshot) {
    this.past = [];
    this.future = [];
    this.current = { ...snapshot };
    this.lastAt = 0;
    this.lastKind = null;
    this.lastCaret = snapshot?.start ?? 0;
    this.lastDelta = 0;
    this.lastSingle = false;
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
    const delta = snapshot.text.length - this.current.text.length;
    // 続きの入力とみなす条件（どれか外れたら、そこで 1 手を区切る）
    //   - 時間が空いていない
    //   - 直前の入力の続きの位置にいる（カーソルを動かしたら区切る）
    //   - 1 文字ずつの入力（貼り付けや一括削除は、その前後で区切る）
    //   - 入力と削除が入れ替わっていない
    //   - 改行を挟んでいない（行が変わったら区切る）
    const adjacent = snapshot.start === this.lastCaret + delta;
    const sameDirection = this.lastDelta === 0 || Math.sign(this.lastDelta) === Math.sign(delta);
    const newline = delta > 0 && snapshot.text.slice(snapshot.start - delta, snapshot.start).includes('\n');
    const mergeable = coalesce
      && kind === 'input'
      && this.lastKind === 'input'
      && now - this.lastAt < this.coalesceMs
      && Math.abs(delta) === 1
      && this.lastSingle
      && adjacent
      && sameDirection
      && !newline;

    if (!mergeable) {
      this.past.push(this.current);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.current = { ...snapshot };
    this.future = [];
    this.lastAt = now;
    this.lastKind = kind;
    this.lastCaret = snapshot.start;
    this.lastDelta = delta;
    // 改行の直後も、次の入力から新しい 1 手にする
    this.lastSingle = Math.abs(delta) === 1 && !newline;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo() {
    if (!this.past.length) return null;
    this.future.push(this.current);
    this.current = this.past.pop();
    this.lastKind = null;
    this.lastDelta = 0;
    this.lastSingle = false;
    this.lastCaret = this.current.start;
    return { ...this.current };
  }

  redo() {
    if (!this.future.length) return null;
    this.past.push(this.current);
    this.current = this.future.pop();
    this.lastKind = null;
    this.lastDelta = 0;
    this.lastSingle = false;
    this.lastCaret = this.current.start;
    return { ...this.current };
  }
}
