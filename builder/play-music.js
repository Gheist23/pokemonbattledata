// The battle music.
//
// Written here rather than fetched, for two reasons. The honest one: a battle theme that sounds
// like one of the games' themes IS one of the games' themes, and that is somebody's copyright --
// so this is an original piece in the idiom rather than a recording of anything. The practical
// one: it is a few kilobytes of code against a megabyte of audio, it starts instantly, and it
// loops without the seam a trimmed MP3 always has.
//
// WHAT IT IS. Eight bars in D minor at 158, in the shape an Elite Four theme takes: a driving
// bass, a fast arpeggio under a sung lead, and -- the part that makes it sound harmonic rather
// than merely fast -- real chords underneath, with sevenths, that MOVE.
//
//     | Dm7 | Bbmaj7 | C | Am7 |   | Dm | Gm7 | A7 | Dm |
//
// The first half falls away (i - VI - VII - v) and the second half turns round and pushes back
// (i - iv - V7 - i). That A7 is the whole trick: its C# is not in D natural minor at all, it
// belongs to the harmonic minor, and it is what makes the last bar feel like an arrival rather
// than simply the next bar. The lead leans on that C# deliberately.
//
// Every voice is derived from the chord of the bar -- the arpeggio literally walks its notes --
// so nothing can drift out of the harmony, and re-voicing or transposing the piece means editing
// one table rather than four.
//
// It is off until somebody asks for it. A page that plays music at you is a page people close,
// and autoplay is blocked without a gesture anyway -- so the AudioContext is not even built until
// the speaker is pressed, which is also what keeps it from holding an audio device open for every
// visitor who never wanted it.
//
// HOW IT STAYS IN TIME. Notes are scheduled AHEAD of the clock, not fired by a timer: a timer in
// a page that is also running a search in a worker and animating sprites will drift, and music
// that drifts is worse than silence. A short interval wakes up, looks at `ctx.currentTime`, and
// schedules every note that falls inside the next window. The sound is always ahead of the ear.

/** Beats a minute. Fast enough to push, slow enough to hear the harmony move. */
const BPM = 158;
/** How far ahead notes are scheduled, and how often the scheduler wakes. */
const AHEAD = 0.3;
const TICK = 60;
/** Eight bars of sixteenths. */
const STEPS = 128;

/** A semitone number to a frequency, with A4 = 69 = 440Hz. */
const hz = (note) => 440 * 2 ** ((note - 69) / 12);

// --- the harmony ------------------------------------------------------------------------------
//
// One chord a bar, as a root and the intervals above it. The sevenths are what keep this from
// sounding like a nursery rhyme: a bare triad is a statement, a seventh is a question.
const MINOR = [0, 3, 7];
const MAJOR = [0, 4, 7];
const MINOR7 = [0, 3, 7, 10];
const MAJOR7 = [0, 4, 7, 11];
const DOM7 = [0, 4, 7, 10];

/** Roots sit low (D2 = 38); the pad voices the same chord two octaves up. */
const CHORDS = [
  { root: 38, shape: MINOR7, name: "Dm7" },
  { root: 34, shape: MAJOR7, name: "Bbmaj7" },
  { root: 36, shape: MAJOR, name: "C" },
  { root: 33, shape: MINOR7, name: "Am7" },
  { root: 38, shape: MINOR, name: "Dm" },
  { root: 31, shape: MINOR7, name: "Gm7" },
  // The harmonic-minor dominant. Its C# is the note that makes the turn-round land.
  { root: 33, shape: DOM7, name: "A7" },
  { root: 38, shape: MINOR, name: "Dm" },
];

/**
 * The lead, as [step, note, length-in-sixteenths].
 *
 * A tune rather than a pattern: it climbs across the first four bars, peaks on the A5 over Am7,
 * and comes down through the turn-round. Bar seven leans on C#5 -- the one note from outside the
 * key -- because that is where the harmony goes too.
 */
const LEAD = [
  // Dm7
  [0, 69, 2], [2, 74, 2], [4, 77, 2], [6, 76, 1], [7, 74, 1],
  [8, 72, 2], [10, 69, 2], [12, 74, 4],
  // Bbmaj7
  [16, 70, 2], [18, 74, 2], [20, 77, 2], [22, 74, 2], [24, 72, 4], [28, 70, 4],
  // C
  [32, 72, 2], [34, 76, 2], [36, 79, 2], [38, 76, 1], [39, 72, 1],
  [40, 74, 2], [42, 76, 2], [44, 79, 4],
  // Am7 -- the peak
  [48, 69, 2], [50, 72, 2], [52, 76, 2], [54, 79, 2], [56, 81, 4], [60, 76, 4],
  // Dm
  [64, 77, 2], [66, 76, 2], [68, 74, 2], [70, 72, 2], [72, 74, 4], [76, 69, 4],
  // Gm7
  [80, 70, 2], [82, 74, 2], [84, 79, 2], [86, 77, 2], [88, 74, 4], [92, 70, 4],
  // A7 -- C# is 73, the leading note
  [96, 73, 2], [98, 76, 2], [100, 79, 2], [102, 76, 2], [104, 81, 4], [108, 79, 2], [110, 76, 2],
  // Dm -- home
  [112, 74, 4], [116, 69, 4], [120, 65, 4], [124, 62, 4],
];

/** The bass figure within a bar: which note of the chord, where, and in which octave. */
const BASS = [
  { at: 0, note: 0, octave: 0 }, { at: 2, note: 0, octave: 0 },
  { at: 4, note: 2, octave: 0 }, { at: 6, note: 0, octave: 1 },
  { at: 8, note: 0, octave: 0 }, { at: 10, note: 0, octave: 0 },
  { at: 12, note: 2, octave: 0 }, { at: 14, note: 3, octave: 0 },
];

export class BattleMusic {
  constructor() {
    this.ctx = null;
    this.timer = 0;
    this.step = 0;
    this.nextAt = 0;
    this.playing = false;
    this.volume = 0.2;
  }

  /** The seconds one sixteenth lasts. */
  get stepLength() {
    return 60 / BPM / 4;
  }

  /** The chord of a given sixteenth, as semitone numbers. */
  chordAt(step) {
    const chord = CHORDS[Math.floor(step / 16) % CHORDS.length];
    return chord.shape.map((interval) => chord.root + interval);
  }

  /** One voice: an oscillator through its own envelope, optionally through a filter. */
  voice(type, frequency, at, length, peak, { detune = 0, cutoff = 0, glide = 0 } = {}) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    // A short slide into the note. Only on the lead, where it reads as expression; on the bass
    // it would read as being out of tune.
    if (glide) {
      osc.frequency.setValueAtTime(frequency * (1 - glide), at);
      osc.frequency.exponentialRampToValueAtTime(frequency, at + 0.03);
    }
    if (detune) osc.detune.setValueAtTime(detune, at);
    // A short attack and a long-ish release: a square wave with a hard edge on both ends is a
    // click, and sixteen of those a bar is a rattle.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.06, length));
    let node = osc.connect(gain);
    if (cutoff) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cutoff, at);
      filter.Q.value = 4;
      node = node.connect(filter);
    }
    node.connect(this.out);
    osc.start(at);
    osc.stop(at + Math.max(0.08, length) + 0.03);
  }

  /** Percussion, as filtered noise. */
  noise(at, length, high, peak) {
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * length));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const band = this.ctx.createBiquadFilter();
    band.type = high ? "highpass" : "bandpass";
    band.frequency.value = high ? 7500 : 1700;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(band).connect(gain).connect(this.out);
    source.start(at);
    source.stop(at + length + 0.02);
  }

  /** Everything that happens on one sixteenth of the loop. */
  schedule(step, at) {
    const inBar = step % 16;
    const notes = this.chordAt(step);
    const sixteenth = this.stepLength;

    // --- bass: the chord's own notes, driving in eighths ---------------------------------------
    for (const hit of BASS) {
      if (hit.at !== inBar) continue;
      const note = notes[Math.min(hit.note, notes.length - 1)] + hit.octave * 12;
      this.voice("triangle", hz(note), at, sixteenth * 1.8, 0.46, { cutoff: 900 });
    }

    // --- the pad: the whole chord, held, quietly. This is what makes it sound harmonic ---------
    if (inBar === 0 || inBar === 8) {
      for (const note of notes) {
        // Voiced up where it will not fight the bass, and soft enough to sit under the lead.
        this.voice("sawtooth", hz(note + 24), at, sixteenth * 7.4, 0.034, { cutoff: 2200 });
      }
    }

    // --- the arpeggio: the chord's notes, one a sixteenth, under the lead -----------------------
    // It literally walks the chord, so it can never disagree with the harmony.
    const walk = [...notes, ...notes.slice(0, -1).reverse()];
    this.voice("square", hz(walk[inBar % walk.length] + 12), at, sixteenth * 0.85, 0.05, { cutoff: 3400 });

    // --- percussion ------------------------------------------------------------------------------
    this.noise(at, 0.02, true, inBar % 4 === 0 ? 0.07 : 0.034);
    if (inBar === 4 || inBar === 12) this.noise(at, 0.12, false, 0.3);
    if (inBar === 0 || inBar === 6 || inBar === 8) this.voice("sine", hz(notes[0] - 12), at, 0.1, 0.95);

    // --- the lead ---------------------------------------------------------------------------------
    for (const [when, note, length] of LEAD) {
      if (when !== step) continue;
      const seconds = sixteenth * length * 0.94;
      // Two squares a few cents apart: one is thin, two is a chorus, and a chorus is what makes
      // a chiptune lead sound like a lead rather than a test tone.
      this.voice("square", hz(note), at, seconds, 0.15, { detune: -7, glide: 0.012, cutoff: 5200 });
      this.voice("square", hz(note), at, seconds, 0.15, { detune: +7, cutoff: 5200 });
      // An octave below, soft, to give it a body.
      this.voice("triangle", hz(note - 12), at, seconds, 0.07);
    }
  }

  /** Wake, look at the clock, and fill the next window. */
  pump() {
    if (!this.ctx) return;
    while (this.nextAt < this.ctx.currentTime + AHEAD) {
      this.schedule(this.step, this.nextAt);
      this.nextAt += this.stepLength;
      this.step = (this.step + 1) % STEPS;
    }
  }

  async start() {
    if (this.playing) return;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        this.out = this.ctx.createGain();
        this.out.gain.value = this.volume;
        this.out.connect(this.ctx.destination);
      }
      // Built on a click, so this resolves; a browser that refuses it simply stays silent rather
      // than throwing into whatever called us.
      await this.ctx.resume();
      this.step = 0;
      this.nextAt = this.ctx.currentTime + 0.08;
      this.playing = true;
      this.timer = setInterval(() => this.pump(), TICK);
      this.pump();
    } catch {
      this.playing = false;
    }
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    if (!this.ctx) return;
    try {
      // Faded rather than cut: silence that arrives in one sample is a pop.
      this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
      const ctx = this.ctx;
      setTimeout(() => {
        try {
          ctx.suspend();
          this.out.gain.value = this.volume;
        } catch { /* already gone */ }
      }, 220);
    } catch { /* nothing to fade */ }
  }

  /** Returns what is actually true afterwards, which is why it waits for `start`. */
  async toggle() {
    if (this.playing) this.stop();
    else await this.start();
    return this.playing;
  }
}
