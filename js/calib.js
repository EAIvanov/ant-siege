// Калибровка под игрока. Каждый шаг ждёт, пока игра действительно распознает нужное действие, и пишет
// замеры только в эти моменты: раскрытая ладонь, кулак, проверка жеста огня, тишина, крик. По замерам
// переставляет пороги кулака, крика и открытого рта в T и запоминает их в браузере.
import { T } from './config.js?v=7ea3fdf3';
import { input, head, flags } from './state.js?v=7ea3fdf3';
import { mic } from './mic.js?v=7ea3fdf3';
import { sfx } from './audio.js?v=7ea3fdf3';

const KEY = 'antsiege_calib';
const KEYS = ['fist3', 'screamLevel', 'screamLevelMouth', 'jawOpen', 'jawScream'];
const DEF = Object.fromEntries(KEYS.map(k => [k, structuredClone(T[k])])); // пороги по умолчанию

const $ = s => document.querySelector(s);
const hasMic = () => mic.ok || mic.fake != null;
const hands3 = () => input.hands.filter(h => h.bend != null); // 3D-точки руки есть
const med = a => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null;

// check(s) → { ok, hint }: распознано ли действие сейчас и что подсказать; take(s) — замеры, пока ok.
// hold — сколько секунд действие должно быть распознано (в сумме). Пороги распознавания нарочно широкие
// и частью относительные (кулак — от вашей же ладони, крик — от вашей тишины): калибруются как раз узкие
const STEPS = [
  {
    text: () => 'Покажите раскрытую ладонь', hold: 1.2,
    check: () => {
      const hs = hands3();
      if (!hs.length) return { hint: 'Поднимите руку в кадр' };
      return hs.some(h => h.bend > 0.78 && h.pinch > 0.45) ? { ok: true, hint: '✓ Вижу раскрытую ладонь — держите' }
        : { hint: 'Выпрямите и разведите пальцы' };
    },
    take: s => hands3().forEach(h => h.bend > 0.78 && h.pinch > 0.45 && s.open.push(h.bend)),
  },
  {
    text: () => 'Сожмите кулак', hold: 1.2,
    check: s => {
      const hs = hands3(), lim = fistLimit(s);
      if (!hs.length) return { hint: 'Поднимите руку в кадр' };
      return hs.some(h => h.bendMax < lim) ? { ok: true, hint: '✓ Вижу кулак — держите' } : { hint: 'Сожмите сильнее, все четыре пальца' };
    },
    take: s => { const lim = fistLimit(s); hands3().forEach(h => h.bendMax < lim && s.fist.push(h.bendMax)); },
    after: s => applyFist(s), // новые пороги кулака — сразу, чтобы проверка огня шла уже по ним
  },
  {
    // жест огня с новыми порогами: рука была явно раскрыта, затем сжата и удержана — трекинг завёл «кулак огня»
    text: () => 'Проверка огня: раскройте ладонь, затем сожмите кулак', hold: 0.4,
    check: () => {
      const hs = input.hands;
      if (!hs.length) return { hint: 'Поднимите руку в кадр' };
      // только жест, сделанный на этом шаге: кулак с прошлого шага (ладонь → кулак) не в счёт
      if (hs.some(h => h.fist && h.fist.born > run.stepAt && h.fist.age >= T.closeHold)) return { ok: true, hint: '✓ Огонь распознан' };
      if (hs.some(h => h.closed)) return { hint: 'Раскройте ладонь, потом снова сожмите' };
      return { hint: hs.some(h => h.open) ? 'Теперь сожмите кулак' : 'Раскройте ладонь' };
    },
    take: s => { s.fireOk = true; },
  },
  {
    text: () => hasMic() ? 'Помолчите, рот закрыт' : 'Закройте рот', hold: 1.5,
    check: () => !head.seen ? { hint: 'Не вижу лицо' } : head.jaw < 0.3 ? { ok: true, hint: '✓ Тишина' } : { hint: 'Закройте рот' },
    take: s => { s.quietJaw.push(head.jaw); if (hasMic()) s.quietMic.push(mic.level); },
  },
  {
    text: () => hasMic() ? 'Крикните, открыв рот' : 'Откройте рот как можно шире', hold: 1,
    check: s => {
      if (!head.seen) return { hint: 'Не вижу лицо' };
      if (hasMic()) {
        const q = med(s.quietMic) ?? mic.floor;
        return mic.level > Math.max(q * 3, 0.02) ? { ok: true, hint: '✓ Слышу крик — ещё!' } : { hint: 'Громче!' };
      }
      return head.jaw > (med(s.quietJaw) ?? 0) + 0.25 ? { ok: true, hint: '✓ Рот открыт — держите' } : { hint: 'Шире!' };
    },
    take: s => { s.screamJaw.push(head.jaw); if (hasMic()) s.screamMic.push(mic.level); },
  },
];

// кулак — все пальцы заметно согнуты относительно вашей же раскрытой ладони
const fistLimit = s => Math.min(0.75, (med(s.open) ?? 1) - 0.25);

let run = null, onClose = () => {};
const ui = {};

export function initCalib(close) {
  onClose = close;
  Object.assign(ui, {
    n: $('#calStepN'), text: $('#calText'), hint: $('#calHint'), bar: $('#calBar'), res: $('#calRes'),
    again: $('#calAgain'), reset: $('#calReset'), skip: $('#calSkip'), done: $('#calDone'),
  });
  ui.again.onclick = openCalib;
  ui.reset.onclick = () => { resetCalib(); showResult(['Пороги по умолчанию']); };
  ui.skip.onclick = () => run && nextStep();
  ui.done.onclick = () => { if (run?.saved) Object.assign(T, run.saved); run = null; flags.calibOk = false; onClose(); };
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
  lastT = 0;
  run = {
    i: 0, ok: 0, stepAt: performance.now(), // stepAt — когда начался текущий шаг // ok — сколько секунд действие текущего шага распознано
    saved: Object.fromEntries(KEYS.map(k => [k, structuredClone(T[k])])), // вернуть при отмене
    s: { open: [], fist: [], quietJaw: [], quietMic: [], screamJaw: [], screamMic: [], fireOk: false },
  };
  ui.res.hidden = true; ui.again.hidden = true; ui.reset.hidden = true; ui.skip.hidden = false;
  ui.done.textContent = 'Отмена';
}

function nextStep() {
  STEPS[run.i].after?.(run.s);
  run.ok = 0; run.stepAt = performance.now();
  if (++run.i === STEPS.length) finish(run.s);
}

// время удержания — по часам, а не по кадрам: игровой шаг ограничен 0.05 с, и на медленном
// компьютере (или в фоновой вкладке) калибровка тянулась бы дольше
let lastT = 0;
export function updateCalib() {
  if (!run) return;
  const now = performance.now(), dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0; lastT = now;
  const st = STEPS[run.i], { ok, hint } = st.check(run.s);
  flags.calibOk = !!ok; // рендер красит кольцо ладони: поза засчитана
  if (ok) { run.ok += dt; st.take(run.s); }
  ui.n.textContent = `${run.i + 1} / ${STEPS.length}`;
  ui.text.textContent = st.text();
  ui.hint.textContent = hint;
  ui.hint.classList.toggle('ok', !!ok);
  ui.bar.style.transform = `scaleX(${Math.min(1, run.ok / st.hold)})`;
  if (run.ok >= st.hold) { sfx.tick(1); nextStep(); } // шаг засчитан — сигнал и дальше
}

// p-я доля отсортированного ряда (0.5 — медиана); среднее верхней доли — для громкости крика
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
const topMean = (a, share) => { const b = [...a].sort((x, y) => y - x).slice(0, Math.max(1, Math.round(a.length * share))); return b.reduce((s, x) => s + x, 0) / b.length; };
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;

// Пороги кулака — между кулаком и ладонью, с запасом от обоих: сжатая не до конца рука всё равно кулак,
// расслабленная — нет. 1-й порог сравнивается с самым прямым пальцем, 2-й (раскрыта) — со средним сгибом
function applyFist(s) {
  // замеров за удержание столько, сколько кадров: на медленном компьютере мало, но каждый — уже подтверждённая поза
  const o = s.open.length >= 3 ? pct(s.open, 0.5) : null, c = s.fist.length >= 3 ? pct(s.fist, 0.5) : null;
  s.fistRes = o != null && c != null && o - c >= 0.2 ? [r2(c + (o - c) * 0.4), r2(c + (o - c) * 0.65)] : null;
  if (s.fistRes) T.fist3 = s.fistRes;
}

function finish(s) {
  run = null; flags.calibOk = false; ui.skip.hidden = true;
  const out = {}, lines = [];

  if (s.fistRes) {
    out.fist3 = s.fistRes;
    lines.push(`Руки: готово (кулак ${r2(pct(s.fist, 0.5))}, ладонь ${r2(pct(s.open, 0.5))})`);
  } else lines.push('Руки: кулак и ладонь не распознаны, пороги прежние');
  lines.push(s.fireOk ? 'Огонь: жест распознаётся' : 'Огонь: проверка пропущена');

  if (hasMic()) {
    const q = pct(s.quietMic, 0.5), loud = s.screamMic.length ? topMean(s.screamMic, 0.5) : 0;
    if (q != null && loud > Math.max(q * 3, 0.02)) {
      out.screamLevel = r3(Math.max(q * 3, q + (loud - q) * 0.4));
      out.screamLevelMouth = r3(Math.max(q * 2, q + (loud - q) * 0.15));
      lines.push(`Микрофон: готово (тишина ${r3(q)}, крик ${r3(loud)})`);
    } else lines.push('Микрофон: крик не распознан, пороги прежние');
  } else lines.push('Микрофона нет: крик — по открытому рту');

  const rest = pct(s.quietJaw, 0.5), wide = pct(s.screamJaw, 0.8);
  if (rest != null && wide != null && wide - rest >= 0.2) {
    out.jawOpen = r2(rest + (wide - rest) * 0.35); out.jawScream = r2(rest + (wide - rest) * 0.7);
    lines.push(`Рот: готово (закрыт ${r2(rest)}, открыт ${r2(wide)})`);
  } else lines.push('Рот: открытый не распознан, пороги прежние');

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
  ui.n.textContent = ''; ui.text.textContent = 'Готово'; ui.hint.textContent = ''; ui.bar.style.transform = 'scaleX(1)';
  ui.res.replaceChildren(...lines.map(l => Object.assign(document.createElement('li'), { textContent: l })));
  ui.res.hidden = false; ui.again.hidden = false; ui.reset.hidden = !isCalibrated(); ui.skip.hidden = true;
  ui.done.textContent = 'Готово';
}
