// Микрофон для крика: громкость (RMS) и медленно адаптирующийся фон шума
export const mic = { ok: false, level: 0, floor: 0.01, fake: null }; // fake — подмена уровня в тестах

let an = null, buf = null;

export async function initMic(ac) {
  // эхоподавление вычитает звуки игры из динамиков; без автоусиления тихий фон не «раздувается» до крика
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  an = ac.createAnalyser(); an.fftSize = 1024; buf = new Float32Array(an.fftSize);
  ac.createMediaStreamSource(stream).connect(an); // в динамики не подключаем
  mic.ok = true;
}

export function sampleMic() {
  if (mic.fake != null) { mic.level = mic.fake; return; }
  if (!an) return;
  an.getFloatTimeDomainData(buf);
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  mic.level = Math.sqrt(s / buf.length);
  // фон быстро опускается к тишине и медленно поднимается, чтобы крик не стал «фоном»
  mic.floor += (mic.level - mic.floor) * (mic.level < mic.floor ? 0.05 : 0.002);
}
