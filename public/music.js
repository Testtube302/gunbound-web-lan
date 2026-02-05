// Procedural 8-bit chiptune background music engine
// 4 channels: lead melody, arpeggio, bass, percussion
// 120 BPM, 16-bar loop, pentatonic C minor

let audioCtx = null;
let masterGain = null;
let schedulerInterval = null;
let muted = localStorage.getItem('musicMuted') === '1';
let playing = false;
let nextNoteTime = 0;
let currentStep = 0; // 0..63 (16 bars × 4 beats... we use 16th note resolution: 16 bars × 16 steps = 256)

const BPM = 120;
const STEP_DURATION = 60 / BPM / 4; // sixteenth note duration in seconds
const TOTAL_STEPS = 256; // 16 bars × 16 sixteenth notes
const LOOKAHEAD = 0.1; // schedule 100ms ahead
const SCHEDULE_INTERVAL = 25; // check every 25ms

// C minor pentatonic scale frequencies (multiple octaves)
// C3, Eb3, F3, G3, Bb3, C4, Eb4, F4, G4, Bb4, C5
const SCALE = [
  130.81, 155.56, 174.61, 196.00, 233.08,  // octave 3
  261.63, 311.13, 349.23, 392.00, 466.16,  // octave 4
  523.25, 622.25, 698.46, 784.00, 932.33,  // octave 5
];

// Bass notes (C2, Eb2, F2, G2, Bb2)
const BASS = [65.41, 77.78, 87.31, 98.00, 116.54];

// Lead melody patterns (indices into SCALE array)
// 4 phrases of 4 bars each (64 steps per phrase)
// -1 = rest, values are SCALE indices
const MELODY = [
  // Phrase 1: ascending theme
  5,-1,-1,-1, 7,-1,-1,-1, 8,-1,9,-1, -1,-1,-1,-1,
  5,-1,7,-1, 9,-1,-1,-1, 8,-1,-1,-1, -1,-1,-1,-1,
  10,-1,-1,-1, 9,-1,8,-1, 7,-1,-1,-1, -1,-1,-1,-1,
  5,-1,7,-1, 8,-1,9,-1, 7,-1,-1,-1, -1,-1,-1,-1,
  // Phrase 2: call and response
  9,-1,-1,-1, 8,-1,7,-1, 5,-1,-1,-1, -1,-1,-1,-1,
  7,-1,8,-1, 9,-1,-1,-1, 10,-1,-1,-1, -1,-1,-1,-1,
  9,-1,8,-1, 7,-1,5,-1, -1,-1,-1,-1, -1,-1,-1,-1,
  5,-1,-1,-1, 7,-1,-1,-1, 9,-1,-1,-1, -1,-1,-1,-1,
  // Phrase 3: rhythmic variation
  5,-1,5,-1, 7,-1,-1,-1, 8,-1,8,-1, 9,-1,-1,-1,
  10,-1,9,-1, 8,-1,7,-1, 5,-1,-1,-1, -1,-1,-1,-1,
  7,-1,-1,-1, 9,-1,10,-1, 9,-1,8,-1, 7,-1,-1,-1,
  5,-1,7,-1, -1,-1,9,-1, -1,-1,-1,-1, -1,-1,-1,-1,
  // Phrase 4: resolution
  10,-1,-1,-1, 9,-1,-1,-1, 8,-1,-1,-1, 7,-1,-1,-1,
  5,-1,7,-1, 8,-1,9,-1, 10,-1,-1,-1, -1,-1,-1,-1,
  9,-1,8,-1, 7,-1,5,-1, 7,-1,-1,-1, -1,-1,-1,-1,
  5,-1,-1,-1, -1,-1,-1,-1, 5,-1,-1,-1, -1,-1,-1,-1,
];

// Arpeggio chord patterns (indices into SCALE for chord tones)
// Each bar specifies 3 chord tones to cycle through on sixteenth notes
const ARP_CHORDS = [
  [0,2,4], [0,2,4], [1,3,5], [1,3,5],   // bars 1-4
  [2,4,6], [2,4,6], [0,3,5], [0,3,5],   // bars 5-8
  [0,2,4], [1,3,5], [2,4,6], [0,3,5],   // bars 9-12
  [0,2,4], [1,3,5], [0,3,5], [0,2,4],   // bars 13-16
];

// Bass pattern (index into BASS array per bar)
const BASS_PATTERN = [0, 0, 1, 1, 2, 2, 0, 3, 0, 1, 2, 0, 0, 1, 3, 0];

function createNote(freq, type, startTime, duration, volume, ctx, dest) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  // Envelope: quick attack, sustain, quick release
  const attackEnd = startTime + 0.01;
  const releaseStart = startTime + duration - 0.02;
  const releaseEnd = startTime + duration;

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(volume, attackEnd);
  gain.gain.setValueAtTime(volume, Math.max(attackEnd, releaseStart));
  gain.gain.linearRampToValueAtTime(0.0001, releaseEnd);

  osc.connect(gain);
  gain.connect(dest);

  osc.start(startTime);
  osc.stop(releaseEnd + 0.01);

  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

function createNoise(startTime, duration, volume, ctx, dest) {
  // White noise burst for percussion
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  gain.gain.setValueAtTime(volume, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(dest);

  source.start(startTime);
  source.stop(startTime + duration + 0.01);

  source.onended = () => {
    source.disconnect();
    filter.disconnect();
    gain.disconnect();
  };

  return filter;
}

function scheduleStep(step, time) {
  if (!audioCtx || !masterGain) return;

  const bar = Math.floor(step / 16);
  const beatInBar = Math.floor((step % 16) / 4); // 0-3
  const sixteenth = step % 4;

  // --- Lead melody ---
  const melodyNote = MELODY[step % MELODY.length];
  if (melodyNote >= 0) {
    createNote(SCALE[melodyNote], 'square', time, STEP_DURATION * 3, 0.08, audioCtx, masterGain);
  }

  // --- Arpeggio (every sixteenth note) ---
  const chordTones = ARP_CHORDS[bar % ARP_CHORDS.length];
  const arpIndex = chordTones[step % chordTones.length];
  if (arpIndex < SCALE.length) {
    createNote(SCALE[arpIndex], 'square', time, STEP_DURATION * 0.7, 0.03, audioCtx, masterGain);
  }

  // --- Bass (beats 1 and 3) ---
  if (sixteenth === 0 && (beatInBar === 0 || beatInBar === 2)) {
    const bassNote = BASS[BASS_PATTERN[bar % BASS_PATTERN.length]];
    createNote(bassNote, 'triangle', time, STEP_DURATION * 4, 0.12, audioCtx, masterGain);
  }

  // --- Percussion ---
  if (sixteenth === 0) {
    if (beatInBar === 0 || beatInBar === 2) {
      // Kick drum: low freq noise burst
      const filter = createNoise(time, 0.08, 0.15, audioCtx, masterGain);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(150, time);
      // Also a sine thump
      createNote(55, 'sine', time, 0.08, 0.15, audioCtx, masterGain);
    }
    if (beatInBar === 1 || beatInBar === 3) {
      // Snare: higher freq noise burst
      const filter = createNoise(time, 0.06, 0.08, audioCtx, masterGain);
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(800, time);
    }
  }
}

function scheduler() {
  if (!audioCtx || !playing) return;

  while (nextNoteTime < audioCtx.currentTime + LOOKAHEAD) {
    scheduleStep(currentStep, nextNoteTime);
    nextNoteTime += STEP_DURATION;
    currentStep = (currentStep + 1) % TOTAL_STEPS;
  }
}

export function startMusic(ctx) {
  if (playing) return;

  audioCtx = ctx;
  masterGain = audioCtx.createGain();
  masterGain.gain.value = muted ? 0 : 0.5;
  masterGain.connect(audioCtx.destination);

  playing = true;
  currentStep = 0;
  nextNoteTime = audioCtx.currentTime + 0.05;

  schedulerInterval = setInterval(scheduler, SCHEDULE_INTERVAL);
}

export function stopMusic() {
  playing = false;
  if (schedulerInterval !== null) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (masterGain) {
    try { masterGain.disconnect(); } catch {}
    masterGain = null;
  }
  currentStep = 0;
}

export function toggleMute() {
  muted = !muted;
  localStorage.setItem('musicMuted', muted ? '1' : '0');
  if (masterGain) {
    masterGain.gain.value = muted ? 0 : 0.5;
  }
  return muted;
}

export function isMuted() {
  return muted;
}
