/**
 * 「書けるタブ」を 1 つに決めるしくみ。
 *
 * このアプリのデータは 1 つの localStorage のキーに丸ごと入っている。
 * 2 つのタブが同時に書くと、あとから書いた方が相手の変更を丸ごと上書きしたり、
 * 取り消した記録が相手のタブ経由で戻ってきたりする。統合で頑張るより、
 * 「書けるのは 1 つのタブだけ」と決めてしまう方が、データを確実に守れる。
 *
 * やっていること:
 *   - 持ち主は自分の印を localStorage に置き、一定の間隔で更新し続ける（生存確認）
 *   - あとから開いたタブは、持ち主が生きていれば「見るだけ」になる
 *   - 「このタブで編集する」を押すと、持ち主に譲るよう頼み、
 *     相手が保存を終えてから受け取る（返事がなければ、しばらく待って引き継ぐ）
 *   - 印が古くなっていれば（タブが閉じられた等）、そのまま引き継ぐ
 *
 * 「時間で古さを測る」だけだと、閉じてすぐ開き直したときに
 * まだ新しい印が残っていて、自分ひとりなのに「見るだけ」になってしまう。
 * そこで開くときは、まず**返事を待つ**（ping / pong）。
 * 閉じたタブは答えられないので、返事が無ければそのまま引き継ぐ。
 */

/** 持ち主の印を置くキー */
const OWNER_KEY = 'fcc.owner.v1';
/** 譲ってほしいという合図を置くキー */
const REQUEST_KEY = 'fcc.owner.request.v1';
/** 「そこにいますか」と尋ねるキー */
const PING_KEY = 'fcc.owner.ping.v1';
/** 「います」と答えるキー */
const PONG_KEY = 'fcc.owner.pong.v1';
/** 生存確認を更新する間隔 */
export const HEARTBEAT_MS = 4000;
/** これを過ぎた印は「閉じたタブのもの」とみなす */
export const STALE_MS = 12000;
/** 譲ってもらうときに待つ時間 */
export const HANDOVER_MS = 1200;
/** 「そこにいますか」の返事を待つ時間 */
export const PROBE_MS = 350;

export function makeTabId() {
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `t_${Date.now().toString(36)}${rand}`;
}

/**
 * @param {object} options
 * @param {Storage} options.storage localStorage 互換
 * @param {Function} options.now 現在時刻（テスト用）
 */
export class TabLock {
  constructor({ storage, now = () => Date.now(), id = makeTabId() } = {}) {
    this.storage = storage;
    this.now = now;
    this.id = id;
    /** このタブが書いてよいか */
    this.owner = false;
    this.timer = null;
    this.listeners = new Set();
    /** 譲る準備（保存の吐き出しなど）を頼まれたときに呼ぶ */
    this.onRelease = null;
  }

  /* ------------------------------------------------------------ 読み書き */

  read(key) {
    try {
      const raw = this.storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  write(key, value) {
    try {
      if (value === null) this.storage.removeItem(key);
      else this.storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  /** いまの持ち主（生きているものだけ） */
  currentOwner() {
    const record = this.read(OWNER_KEY);
    if (!record || typeof record.id !== 'string') return null;
    if (this.now() - Number(record.at || 0) > STALE_MS) return null;
    return record;
  }

  /* ------------------------------------------------------------ 状態 */

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason) {
    this.listeners.forEach((fn) => fn({ owner: this.owner, reason }));
  }

  setOwner(owner, reason) {
    if (this.owner === owner) return;
    this.owner = owner;
    this.emit(reason);
  }

  /* ------------------------------------------------------------ 取得 */

  /**
   * 開いたときに呼ぶ。持ち主がいなければ持ち主になる。
   * @returns {boolean} 書いてよいか
   */
  claim() {
    const current = this.currentOwner();
    if (current && current.id !== this.id) {
      this.setOwner(false, 'taken');
      return false;
    }
    this.write(OWNER_KEY, { id: this.id, at: this.now() });
    this.setOwner(true, 'claimed');
    return true;
  }

  /**
   * 開いたときに呼ぶ（返事を待ってから決める）。
   *
   * 印が残っていても、答えが返らなければ「閉じたタブのもの」として引き継ぐ。
   * 生きているタブは storage の合図を受けて、すぐに返事を書く。
   */
  async claimWithProbe({ wait = PROBE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const current = this.currentOwner();
    if (!current || current.id === this.id) return this.claim();

    const at = this.now();
    this.write(PING_KEY, { id: this.id, at });
    await sleep(wait);

    const pong = this.read(PONG_KEY);
    const answered = pong && pong.id === current.id && Number(pong.at) >= at;
    if (answered) {
      this.setOwner(false, 'taken');
      return false;
    }
    // 返事が無い＝もう居ない。印を引き継ぐ
    this.write(OWNER_KEY, { id: this.id, at: this.now() });
    this.setOwner(true, 'claimed');
    return true;
  }

  /** 「そこにいますか」に答える */
  answerPing() {
    if (!this.owner) return false;
    return this.write(PONG_KEY, { id: this.id, at: this.now() });
  }

  /** 持ち主であることを知らせ続ける */
  beat() {
    if (!this.owner) return;
    this.write(OWNER_KEY, { id: this.id, at: this.now() });
  }

  /**
   * 持ち主を譲ってもらう。
   * 相手が生きていれば、保存を終える時間を待ってから受け取る。
   */
  async takeOver({ wait = HANDOVER_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const current = this.currentOwner();
    if (!current || current.id === this.id) {
      this.claim();
      return true;
    }
    // 「譲ってください」の合図を置く（相手はこれを見て保存を終え、印を消す）
    this.write(REQUEST_KEY, { id: this.id, at: this.now() });
    await sleep(wait);
    const after = this.currentOwner();
    if (after && after.id !== this.id && after.at > current.at && !this.read(REQUEST_KEY)?.released) {
      // 相手がまだ生きていて譲ってくれない場合でも、こちらを優先する
      // （利用者が「このタブで編集する」と選んだため）
      this.write(OWNER_KEY, { id: this.id, at: this.now() });
      this.write(REQUEST_KEY, null);
      this.setOwner(true, 'forced');
      return true;
    }
    this.write(OWNER_KEY, { id: this.id, at: this.now() });
    this.write(REQUEST_KEY, null);
    this.setOwner(true, 'handover');
    return true;
  }

  /** 持ち主をやめる（他のタブへ譲る／閉じる） */
  async release({ reason = 'released' } = {}) {
    if (!this.owner) return;
    this.owner = false;
    try {
      await this.onRelease?.();
    } catch { /* 保存できなくても、譲ること自体は続ける */ }
    const record = this.read(OWNER_KEY);
    if (record?.id === this.id) this.write(OWNER_KEY, null);
    this.write(REQUEST_KEY, { id: this.id, at: this.now(), released: true });
    this.emit(reason);
  }

  /**
   * 外からの合図を処理する（storage イベントから呼ぶ）。
   * @returns {'release'|'lost'|null} 何が起きたか
   */
  handleSignal(key) {
    if (key === PING_KEY) {
      // 生きているタブだけが答える（答えなければ、相手が引き継ぐ）
      this.answerPing();
      return null;
    }
    if (key === PONG_KEY) return null;
    if (key === REQUEST_KEY) {
      const request = this.read(REQUEST_KEY);
      if (this.owner && request && request.id !== this.id && !request.released) return 'release';
      return null;
    }
    if (key === OWNER_KEY) {
      const record = this.read(OWNER_KEY);
      if (this.owner && record && record.id !== this.id) {
        this.setOwner(false, 'lost');
        return 'lost';
      }
      if (!this.owner && !this.currentOwner()) {
        // 持ち主がいなくなった（閉じられた）。開いているタブが引き継ぐ
        return 'free';
      }
    }
    return null;
  }

  /**
   * 見張りを始める。
   * 返事を待つぶん、ほんの少し（PROBE_MS）かかることがある。
   */
  async start({ probe = true, ...options } = {}) {
    if (probe) await this.claimWithProbe(options);
    else this.claim();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
    return this.owner;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
