/** 記録画面（続けた記録と、これからの負荷） */
import { h, button } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState } from '../components.js';
import { activityHeatmap, monthlyBars, ratingBar } from '../charts.js';
import { startReviewSession } from '../reviewSession.js';
import { focusDate } from './calendar.js';
import { navigate } from '../router.js';
import { RATINGS } from '../../core/curve.js';
import { addDays, formatDuration, todayKey } from '../../core/date.js';

const RATING_ORDER = [RATINGS.known, RATINGS.vague, RATINGS.forgot];

export function renderStats(store) {
  const today = todayKey();
  const st = store.stats();
  const root = h('div', { class: 'page page--narrow' });

  root.appendChild(h('div', { class: 'page__header' },
    h('h1', { class: 'page__title' }, '記録'),
    h('div', { class: 'page__subtitle' }, '思い出してきた軌跡と、これからの予定')));

  if (!st.total) {
    root.appendChild(emptyState({
      iconName: 'data',
      title: 'まだ記録がありません',
      text: 'メモを書いて復習を始めると、ここに軌跡がたまっていきます。',
    }));
    return root;
  }

  /* ---------------- 主要な数字 ---------------- */
  const streak = store.streakDays(today);
  const week = store.recentActivity(7, today);
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'stat-grid' },
      stat(streak, '連続日数', '書いた日も数えます'),
      stat(st.reviewsDone, '思い出した回数'),
      stat(week.written, '今週書いたメモ'),
      stat(st.graduated, '定着したメモ')),
    week.insights ? h('div', { class: 'field__hint', style: { marginTop: '10px' } },
      `そのうち ${week.insights} 件は、読み返して生まれた気づきです。`) : null));

  /* ---------------- 節目 ---------------- */
  const { achieved, next } = store.milestones(today);
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('flag', { size: 18 }), style: { display: 'flex' } }), 'これまでの節目'),
    achieved.length
      ? h('div', { class: 'milestones' },
        ...achieved.slice().reverse().map((m) => h('div', { class: 'milestone' },
          h('span', { class: 'milestone__icon', html: icon(m.icon, { size: 18 }) }),
          h('span', {},
            h('span', { class: 'milestone__label' }, m.label),
            m.desc ? h('span', { class: 'milestone__desc' }, m.desc) : null))))
      : h('div', { class: 'field__hint' }, 'メモを書くと、ここに節目がたまっていきます。'),
    next ? h('div', { class: 'milestone milestone--next' },
      h('span', { class: 'milestone__icon', html: icon(next.icon, { size: 18 }) }),
      h('span', {},
        h('span', { class: 'milestone__label' }, `次の節目：${next.label}`),
        next.desc ? h('span', { class: 'milestone__desc' }, next.desc) : null)) : null));

  /* ---------------- 想起の内訳 ---------------- */
  const bar = ratingBar(st.ratings, RATING_ORDER);
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('target', { size: 18 }), style: { display: 'flex' } }), '想起の内訳'),
    h('div', { class: 'card__desc' }, 'これまでの記録の割合です。'),
    bar || h('div', { class: 'field__hint' }, 'まだ記録がありません。'),
    st.reviewsDone ? h('div', { class: 'field__hint', style: { marginTop: '10px' } },
      `覚えていた割合は ${Math.round((st.ratings.known / st.reviewsDone) * 100)}%。`
      + 'この割合が高すぎるときは間隔を広げ、低いときは狭めると、ちょうど良い負荷になります。') : null));

  /* ---------------- 復習の記録 ---------------- */
  const activity = store.activityByDay(addDays(today, -7 * 16), today);
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('calendar', { size: 18 }), style: { display: 'flex' } }), '直近16週間の記録'),
    h('div', { class: 'card__desc' }, '濃いほど、その日にたくさん思い出しています。'),
    h('div', { class: 'chart-scroll' }, activityHeatmap(activity, { endKey: today, weekStart: store.settings.weekStart })),
    h('div', { class: 'field__hint' },
      `記録のある日 ${activity.size} 日・今日 ${st.doneToday} 回`)));

  /* ---------------- これからの負荷 ---------------- */
  const months = store.upcomingMonths(12, today);
  const peak = months.reduce((a, b) => (b.count > a.count ? b : a), months[0]);
  root.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card__title' },
      h('span', { html: icon('curve', { size: 18 }), style: { display: 'flex' } }), 'これから 12 ヶ月の予定'),
    h('div', { class: 'card__desc' }, '棒をタップすると、その月のカレンダーへ移動します。'),
    monthlyBars(months, {
      onSelect: (bucket) => {
        focusDate(`${bucket.prefix}-01`);
        navigate('calendar');
      },
    }),
    h('div', { class: 'field__hint' },
      peak.count
        ? `いちばん多いのは ${peak.year}年${peak.month + 1}月の ${peak.count} 件。`
        + '偏っているときは、設定の「復習日の分散」を強めると散らばります。'
        : 'この先 12 ヶ月に予定はありません。')));

  /* ---------------- タグ ---------------- */
  const tags = store.tagStats().slice(0, 8);
  if (tags.length) {
    root.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card__title' },
        h('span', { html: icon('tag', { size: 18 }), style: { display: 'flex' } }), 'タグ別'),
      h('table', { class: 'help-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'タグ'), h('th', {}, 'メモ'), h('th', {}, '定着'), h('th', {}, '想起'))),
        h('tbody', {}, ...tags.map((t) => h('tr', {},
          h('td', {}, `#${t.tag}`),
          h('td', {}, String(t.notes)),
          h('td', {}, String(t.graduated)),
          h('td', {}, String(t.reviews))))))));
  }

  /* ---------------- 今日への導線 ---------------- */
  const queue = store.todayQueue(today);
  if (queue.items.length) {
    root.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card__title' }, `今日の復習が ${queue.items.length} 件あります`),
      button('思い出し始める', {
        className: 'btn btn--block',
        icon: icon('play', { size: 18 }),
        onClick: () => startReviewSession(store),
      })));
  }

  root.appendChild(h('div', { class: 'field__hint', style: { textAlign: 'center' } },
    `いちばん先の予定は ${farthest(store) || '—'}`));

  return root;
}

function farthest(store) {
  const dues = store.notes
    .flatMap((n) => n.reviews.filter((r) => r.status === 'pending').map((r) => r.due))
    .sort();
  if (!dues.length) return null;
  const last = dues[dues.length - 1];
  const days = Math.round((new Date(last) - new Date(todayKey())) / 86400000);
  return `${last}（${formatDuration(Math.max(1, days))}後）`;
}

function stat(value, label, hint) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat__value' }, String(value)),
    h('div', { class: 'stat__label' }, label),
    hint ? h('div', { class: 'stat__hint' }, hint) : null);
}
