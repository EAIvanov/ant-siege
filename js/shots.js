// Скриншоты по ходу игры для экрана результата
const MAX = 9, MAX_W = 1280; // снимок в разрешении кадра, но не шире 1280 px
let list = [], pending = [];

export function resetShots() { list = []; pending = []; }

// kind: 'event' — яркий момент; 'periodic' — для хронологии (вытесняется первым);
// 'attach' — «облепили»: такой снимок один, новый (больше муравьёв) заменяет прежний
export function requestShot(label, delay = 0, kind = 'event') {
  if (pending.length < 4) pending.push({ label, kind, at: performance.now() + delay * 1000 });
}

// вызывать сразу после отрисовки кадра: буфер WebGL ещё не очищен до конца этой JS-задачи,
// поэтому preserveDrawingBuffer (замедляет рендер) не нужен
export function captureDue(canvas, t) {
  const now = performance.now(), due = pending.filter(p => p.at <= now);
  if (!due.length || !canvas.width || !canvas.height) return; // окно свёрнуто — снимем, когда появится
  pending = pending.filter(p => p.at > now);
  const src = grab(canvas);
  for (const p of due) {
    if (p.kind === 'attach') list = list.filter(s => s.kind !== 'attach');
    list.push({ src, label: p.label, kind: p.kind, t });
    if (list.length > MAX) { const i = list.findIndex(s => s.kind === 'periodic'); list.splice(i >= 0 ? i : 0, 1); }
  }
}

function grab(canvas) {
  const c = document.createElement('canvas'), k = Math.min(1, MAX_W / canvas.width);
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

export const shots = () => list;

// ---------- скачивание ----------
const mmss = t => `${Math.floor(t / 60)}-${String(Math.floor(t % 60)).padStart(2, '0')}`;
export const shotName = (s, i) => `муравьиная-осада_${String(i + 1).padStart(2, '0')}_${mmss(s.t)}_${s.label.replace(/[^\p{L}\p{N}]+/gu, '-')}.jpg`;

const toBlob = src => fetch(src).then(r => r.blob());

function save(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function downloadShot(s, i) { save(await toBlob(s.src), shotName(s, i)); }

// все снимки одним ZIP (JSZip из vendor/ грузится только при нажатии; JPEG уже сжат — архив без сжатия).
// Не вышло — по одному файлу
export async function downloadAll() {
  try {
    // UMD-сборка: при подключении как модуль кладёт себя в window.JSZip
    await import('../vendor/jszip/jszip.min.js');
    const JSZip = window.JSZip;
    const zip = new JSZip();
    await Promise.all(list.map(async (s, i) => zip.file(shotName(s, i), await toBlob(s.src))));
    const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    save(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `муравьиная-осада_${stamp}.zip`);
  } catch {
    for (let i = 0; i < list.length; i++) await downloadShot(list[i], i);
  }
}
