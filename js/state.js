// Общее изменяемое состояние. Модули — синглтоны, так что все видят одни и те же объекты.
import { rand } from './util.js?v=f511fb61';

// экран и пересчёт координат камеры
export const view = { W: 0, H: 0, vw: 0, vh: 0, scale: 1, offX: 0, offY: 0 };

// px/py — прошлая позиция, v — скорость, rx/ry — медленно догоняющая «точка покоя» (для размаха)
export const head = {
  x: 0, y: 0, r: 90, seen: false, lostFor: 99,
  px: 0, py: 0, vx: 0, vy: 0, rx: 0, ry: 0, shake: 0,
  // ориентация: R — текущая 3×3, Rrest — сглаженная «точка покоя», w — угловая скорость
  R: null, Rrest: null, w: 0,
  pPos: 0, pRot: 0, // составляющие для отладочной строки
  jaw: 0, mouth: { x: 0, y: 0 }, // насколько открыт рот и где он (для крика)
};

// руки: {palm:{x,y}, tips:[{x,y}], pts:[], r, vx, vy, tv, size, closed, fist}
// fires — жесты «огненный шар», распознанные трекингом и ещё не обработанные игрой
export const input = { hands: [], prevHands: [], fires: [] };

// calib — идёт калибровка: трекинг есть, игры нет; paused — лица нет в кадре, мир стоит
export const flags = { running: false, over: false, calib: false, paused: false };

export const G = {}; // игровая сессия
export function resetGame() {
  Object.assign(G, {
    t: 0, life: 100, kills: 0, pts: 0, wave: 1, ants: [], bonuses: [], parts: [],
    spawnAcc: 0, bonusIn: rand(6, 10), fx: { slow: 0, shield: 0, fear: 0, lull: 0 }, trauma: 0, freeze: 0, lowWarned: false,
    combo: 0, comboT: 0, comboTier: 0, comboBest: 0, // серия: сколько подряд, сколько ещё ждёт, ступень множителя
    pops: [], hits: [], // вспышки на месте убитых; края экрана, откуда вцепился муравей
    // суперсила 0..1 — общий запас для тряски, крика и огня; using — её тратили в этом кадре
    power: 0, powerWas: false, att: 0, using: false, attShot: 0,
    bossCalled: false, bossQueue: 0, bossIn: 0, // гиганты этой волны: вызваны ли, сколько ещё выйдет
    invT: 0, invDur: 1, // негатив на видео: сколько осталось и полная длительность
    screamT: 0, screamLock: false, blastT: 0, blastK: 0, // крик: длительность, ждём тишины после импульса, волна
    quietT: 0, sWaves: [], sWaveAcc: 0, // тишина после крика; волны изо рта, пока кричат
    fireballs: [], blasts: [], // огненные шары в полёте и их взрывы
    cdBeep: 0, started: false, // отсчёт 3-2-1: последний озвученный номер; прозвучало ли «ВПЕРЁД!»
    cdZero: 0, cdZeroLabel: '', // сколько ещё показывать «0» после начала волны и подпись к нему
  });
  input.fires.length = 0;
}
export const score = () => G.pts + Math.floor(G.t);
