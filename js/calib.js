// Калибровка под игрока: раскрытая ладонь, кулак, тишина, крик. По замерам переставляет пороги
// кулака, крика и открытого рта в T и запоминает их в браузере. Остальной код читает T как обычно.
import { T } from './config.js?v=785a1ab2';
import { input, head } from './state.js?v=785a1ab2';
import { mic } from './mic.js?v=785a1ab2';
import { sfx } from './audio.js?v=785a1ab2';

const KEY = 'antsiege_calib';
const KEYS = ['fist3', 'screamLevel', 'screamLevelMouth', 'jawOpen', 'jawScream'];
const DEF = Object.fromEntries(KEYS.map(k => [k, structuredClone(T[k])])); // пороги по умолчанию

const $ = s => document.querySelector(s);
const PREP = 1.2; // с на то, чтобы принять позу, — эти кадры не пишем
const hasMic = () => mic.ok || mic.fake != null;

// need — что должно быть в кадре, чтобы замер шёл; take — что пишем в кадре
const STEPS = [
  { text: () => 'Покажите раскрытую ладонь', need: 'hand', dur: 2,
    take: s => input.hands.forEach(h => h.bend != null && s.open.push(h.bend)) },
  { text: () => 'Сожмите кулак', need: 'hand', dur: 2,
    take: s => input.hands.forEach(h => h.bendMax != null && s.fist.push(h.bendMax)) }, // кулак — по самому прямому пальцу
  { text: () => hasMic() ? 'Помолчите' : 'Закройте рот', need: 'face', dur: 2,
    take: s => { s.quietJaw.push(head.jaw); if (hasMic()) s.quietMic.push(mic.level); } },
  { text: () => hasMic() ? 'Крикните, открыв рот' : 'Откройте рот как можно шире', need: 'face', dur: 2.5,
    take: s => { s.screamJaw.push(head.jaw); if (hasMic()) s.screamMic.push(mic.level); } },
];

let run = null, onClose = () => {};
const ui = {};

export function initCalib(close) {
  onClose = close;
  Object.assign(ui, {
    n: $('#calStepN'), text: $('#calText'), bar: $('#calBar'), res: $('#calRes'),
    again: $('#calAgain'), reset: $('#calReset'), done: $('#calDone'),
  });
  ui.again.onclick = openCalib;
  ui.reset.onclick = () => { resetCalib(); showResult(['Пороги по умолчанию']); };
  ui.done.onclick = () => { run = null; onClose(); };
}

export const isCalibrated = () => { try { return !!localStorage.getItem(KEY); } catch { return false; } };

// при загрузке игры: сохранённые пороги поверх стандартных
export function loadCalib() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  Object.assign(T, structuredClone(DEF), saved);
}

function resetCalib() {
  try { localStorage.removeItem(KEY); } catch {}
  Object.assign(T, structuredClone(DEF));
}

export function openCalib() {
  run = { i: 0, t: 0, s: { open: [], fist: [], quietJaw: [], quietMic: [], screamJaw: [], screamMic: [] } };
  ui.res.hidden = true; ui.again.hidden = true; ui.reset.hidden = true;
  ui.done.textContent = 'Отмена';
}

export function updateCalib(dt) {
  if (!run) return;
  const st = STEPS[run.i], seen = st.need === 'hand' ? input.hands.length > 0 : head.seen;
  const was = run.t;
  if (run.t < PREP) run.t += dt;
  else if (seen) { run.t += dt; st.take(run.s); } // пока нужного нет в кадре, замер стоит
  if (was < PREP && run.t >= PREP) sfx.tick(1); // сигнал: замер пошёл

  ui.n.textContent = `${run.i + 1} / ${STEPS.length}`;
  ui.text.textContent = run.t >= PREP && !seen ? (st.need === 'hand' ? 'Поднимите руку в кадр' : 'Не вижу лицо') : st.text();
  ui.bar.style.transform = `scaleX(${Math.max(0, (run.t - PREP) / st.dur)})`;

  if (run.t >= PREP + st.dur) {
    run.t = 0;
    if (++run.i === STEPS.length) finish(run.s);
  }
}

// p-я доля отсортированного ряда (0.5 — медиана); среднее верхней доли — для громкости крика
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
const topMean = (a, share) => { const b = [...a].sort((x, y) => y - x).slice(0, Math.max(1, Math.round(a.length * share))); return b.reduce((s, x) => s + x, 0) / b.length; };
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;

// Пороги ставим между «спокойным» и «активным» замером, с запасом от обоих: рука, которую
// сжали не до конца, всё равно считается кулаком, а расслабленная — нет
function finish(s) {
  run = null;
  const out = {}, lines = [];

  const o = s.open.length > 10 ? pct(s.open, 0.5) : null, c = s.fist.length > 10 ? pct(s.fist, 0.5) : null;
  if (o != null && c != null && o - c >= 0.2) {
    out.fist3 = [r2(c + (o - c) * 0.4), r2(c + (o - c) * 0.65)];
    lines.push(`Руки: готово (кулак ${r2(c)}, ладонь ${r2(o)})`);
  } else lines.push('Руки: кулак и ладонь не различить, пороги прежние');

  if (hasMic()) {
    const q = pct(s.quietMic, 0.5), loud = topMean(s.screamMic, 0.3);
    if (loud > Math.max(q * 3, 0.02)) {
      out.screamLevel = r3(Math.max(q * 3, q + (loud - q) * 0.4));
      out.screamLevelMouth = r3(Math.max(q * 2, q + (loud - q) * 0.15));
      lines.push(`Микрофон: готово (тишина ${r3(q)}, крик ${r3(loud)})`);
    } else lines.push('Микрофон: крик не отличить от тишины, пороги прежние');
  }

  const rest = pct(s.quietJaw, 0.5), wide = pct(s.screamJaw, 0.8);
  if (rest != null && wide != null && wide - rest >= 0.2) {
    out.jawOpen = r2(rest + (wide - rest) * 0.35); out.jawScream = r2(rest + (wide - rest) * 0.7);
    lines.push(`Рот: готово (закрыт ${r2(rest)}, открыт ${r2(wide)})`);
  } else lines.push('Рот: открытый не отличить от закрытого, пороги прежние');

  if (Object.keys(out).length) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    Object.assign(saved, out);
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
    Object.assign(T, out);
    sfx.ready();
  } else sfx.deny();
  showResult(lines);
}

function showResult(lines) {
  ui.n.textContent = ''; ui.text.textContent = 'Готово'; ui.bar.style.transform = 'scaleX(1)';
  ui.res.replaceChildren(...lines.map(l => Object.assign(document.createElement('li'), { textContent: l })));
  ui.res.hidden = false; ui.again.hidden = false; ui.reset.hidden = !isCalibrated();
  ui.done.textContent = 'Готово';
}
