import { Howl, Howler } from 'howler';

/**
 * The app's game sounds, played with Howler.js from short CC0 files in `public/sounds`
 * (credited in `public/sounds/CREDITS.md`). Each ships as Ogg with an MP3 fallback.
 *
 * The kiosk sets the master volume from `family_settings.volume`, and mutes everything in
 * quiet hours (spec 005); other screens (setup, the phone) keep the quieter default, as
 * spec 003 asks. Electron allows sound without a first click; in a browser, Howler unlocks
 * audio on the first tap.
 */
export type SoundName =
  | 'tap'
  | 'tick'
  | 'pop'
  | 'coin'
  | 'sad'
  | 'fanfare'
  | 'clink'
  | 'jingle'
  | 'smash'
  | 'whoosh'
  | 'chime'
  | 'chaching'
  | 'drumroll'
  | 'bloop'
  | 'grow'
  | 'fizzle'
  | 'flip';

/** Each sound's level relative to the others, so none drowns the rest out. */
const LEVELS: Record<SoundName, number> = {
  tap: 0.6,
  tick: 0.4,
  pop: 0.9,
  coin: 0.8,
  sad: 0.7,
  fanfare: 0.8,
  clink: 0.5,
  jingle: 0.8,
  smash: 0.9,
  whoosh: 0.6,
  chime: 0.7,
  chaching: 0.8,
  drumroll: 0.7,
  bloop: 0.6,
  grow: 0.7,
  fizzle: 0.6,
  flip: 0.6,
};

/** Master volume away from the kiosk. */
const DEFAULT_MASTER = 0.5;

const howls = new Map<SoundName, Howl>();
Howler.volume(DEFAULT_MASTER);

function howl(name: SoundName): Howl {
  let h = howls.get(name);
  if (!h) {
    h = new Howl({ src: [`/sounds/${name}.ogg`, `/sounds/${name}.mp3`], volume: LEVELS[name] });
    howls.set(name, h);
  }
  return h;
}

function play(name: SoundName, options: { rate?: number; volume?: number } = {}): void {
  const h = howl(name);
  const id = h.play();
  h.rate(options.rate ?? 1, id);
  h.volume(LEVELS[name] * (options.volume ?? 1), id);
}

/** Loads every sound now, so the first claim doesn't wait on a download. */
export function preloadSounds(): void {
  for (const name of Object.keys(LEVELS) as SoundName[]) howl(name);
}

/** The master volume as a percentage (0 is silent), from the family settings. */
export function setVolume(percent: number): void {
  Howler.volume(Math.min(100, Math.max(0, percent)) / 100);
}

/** The phone's mute setting (spec 003), kept per phone; the kiosk's quiet hours (spec 005). */
export function setMuted(muted: boolean): void {
  Howler.mute(muted);
}

export const sound: Record<Exclude<SoundName, 'clink'>, () => void> = {
  tap: () => play('tap'),
  tick: () => play('tick'),
  pop: () => play('pop'),
  coin: () => play('coin'),
  sad: () => play('sad'),
  fanfare: () => play('fanfare'),
  jingle: () => play('jingle'),
  smash: () => play('smash'),
  whoosh: () => play('whoosh'),
  chime: () => play('chime'),
  chaching: () => play('chaching'),
  drumroll: () => play('drumroll'),
  bloop: () => play('bloop'),
  grow: () => play('grow'),
  fizzle: () => play('fizzle'),
  flip: () => play('flip'),
};

/** Spec 005's tick-tock: one a second while a bonus is ending, the tock a little lower. */
export function tickTock(second: number): void {
  play('tick', second % 2 === 0 ? {} : { rate: 0.72 });
}

/** Spec 004's money sounds that need more than a plain play. */
export const moneySound = {
  /** One coin into a jar: `step` (0, 1, 2…) raises the pitch slightly as the jar fills. */
  clink: (step = 0) => play('clink', { rate: 1 + Math.min(step, 30) * 0.015 }),
  /** A jar deleted: the glass smash, quietly. */
  quietSmash: () => play('smash', { volume: 0.4 }),
};
