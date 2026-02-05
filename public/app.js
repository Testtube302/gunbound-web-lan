import { draw } from './game.js';
import { startMusic, stopMusic, toggleMute, isMuted } from './music.js';

let ws = null;
let myId = null;
let joined = false;
let lastState = null;
let lastShot = null;
let prevPhase = 'lobby';
let matchOverInfo = null;

// --- Sound (WebAudio; no external assets) ---
// Mobile browsers require a user gesture before audio can play; we "unlock" on button clicks.
let audioCtx = null;
function getAudioCtx(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
async function unlockAudio(){
  try {
    const ctx = getAudioCtx();
    if (ctx.state !== 'running') await ctx.resume();
  } catch {
    // ignore
  }
}

function playFireSfx(){
  const ctx = getAudioCtx();
  if (ctx.state !== 'running') return;

  const t0 = ctx.currentTime;

  // "pop" transient
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'square';
  osc.frequency.setValueAtTime(220, t0);
  osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.06);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1800, t0);
  filter.frequency.exponentialRampToValueAtTime(700, t0 + 0.08);

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.10);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t0);
  osc.stop(t0 + 0.12);
}

function playImpactSfx(){
  const ctx = getAudioCtx();
  if (ctx.state !== 'running') return;

  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(120, t0);
  osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.18);

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t0);
  osc.stop(t0 + 0.24);
}

const elStatus = document.getElementById('status');
const elPlayers = document.getElementById('players');
const elName = document.getElementById('name');
const elMatchInfo = document.getElementById('matchInfo');

const btnConnect = document.getElementById('btnConnect');
const btnJoin = document.getElementById('btnJoin');
const btnLeave = document.getElementById('btnLeave');
const btnReady = document.getElementById('btnReady');
const btnUnready = document.getElementById('btnUnready');
const btnFire = document.getElementById('btnFire');

const btnMute = document.getElementById('btnMute');

const elAngle = document.getElementById('angle');
const elPower = document.getElementById('power');
const elAngleVal = document.getElementById('angleVal');
const elPowerVal = document.getElementById('powerVal');

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function setStatus(s){ elStatus.textContent = `Status: ${s}`; }

function renderPlayers(players){
  elPlayers.innerHTML = '';
  for (const p of players){
    const li = document.createElement('li');
    const you = p.id === myId ? ' (you)' : '';
    const ready = p.ready ? ' ✅' : '';
    li.textContent = `${p.name} (${p.id})${you} HP:${p.hp}${ready}`;
    elPlayers.appendChild(li);
  }
}

function send(obj){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function updateUIFromState(s){
  lastState = s;
  renderPlayers(s.players || []);

  const me = (s.players || []).find(p => p.id === myId);
  const inLobby = s.phase === 'lobby';
  const inMatch = s.phase === 'match' || s.phase === 'shot';

  // Music phase transitions
  if (prevPhase === 'lobby' && inMatch) {
    matchOverInfo = null;
    startMusic(getAudioCtx());
  } else if (prevPhase !== 'lobby' && inLobby) {
    stopMusic();
  }
  prevPhase = s.phase;

  btnReady.disabled = !joined || !inLobby;
  btnUnready.disabled = !joined || !inLobby;

  const myTurn = (s.turn === myId) && (s.phase === 'match');
  btnFire.disabled = !joined || !inMatch || !myTurn;

  if (inLobby) elMatchInfo.textContent = 'Match: lobby (ready up)';
  else elMatchInfo.textContent = `Match: ${s.phase} • turn: ${s.turn} • wind: ${s.wind}`;

  draw(ctx, s, lastShot, matchOverInfo);
}

btnConnect.addEventListener('click', async () => {
  await unlockAudio();
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  setStatus('connecting...');
  btnJoin.disabled = true;
  btnLeave.disabled = true;
  btnReady.disabled = true;
  btnUnready.disabled = true;
  btnFire.disabled = true;

  ws.addEventListener('open', () => {
    setStatus('connected (not joined)');
    btnJoin.disabled = false;
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'hello') {
      myId = msg.id;
      return;
    }
    if (msg.type === 'state') {
      updateUIFromState(msg);
      return;
    }
    if (msg.type === 'shot_result') {
      lastShot = msg.result;
      // Patch terrain from shot_result for immediate visual update
      if (lastShot?.terrain && lastState) {
        lastState.terrain = lastShot.terrain;
      }
      // Impact sound for any shot (including opponent), if audio is unlocked.
      if (lastShot?.impact) playImpactSfx();
      draw(ctx, lastState, lastShot, matchOverInfo);
      return;
    }
    if (msg.type === 'match_over') {
      matchOverInfo = { winnerName: msg.winnerName, koName: msg.koName };
      setStatus(`match over — ${msg.winnerName} wins!`);
      draw(ctx, lastState, lastShot, matchOverInfo);
      return;
    }
    if (msg.type === 'error') {
      setStatus(`error: ${msg.message}`);
      return;
    }
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected');
    joined = false;
    btnJoin.disabled = true;
    btnLeave.disabled = true;
    btnReady.disabled = true;
    btnUnready.disabled = true;
    btnFire.disabled = true;
  });
});

btnJoin.addEventListener('click', async () => {
  await unlockAudio();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const name = (elName.value || 'Player').trim();
  send({ type: 'join', name });
  joined = true;
  btnLeave.disabled = false;
  btnJoin.disabled = true;
  setStatus('joined lobby');
});

btnLeave.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send({ type: 'leave' });
  joined = false;
  btnLeave.disabled = true;
  btnJoin.disabled = false;
  btnReady.disabled = true;
  btnUnready.disabled = true;
  btnFire.disabled = true;
  setStatus('connected (not joined)');
});

btnReady.addEventListener('click', async () => {
  await unlockAudio();
  send({ type: 'ready', ready: true });
});
btnUnready.addEventListener('click', async () => {
  await unlockAudio();
  send({ type: 'ready', ready: false });
});

function syncSliders(){
  elAngleVal.textContent = elAngle.value;
  elPowerVal.textContent = Number(elPower.value).toFixed(2);
}

elAngle.addEventListener('input', syncSliders);
elPower.addEventListener('input', syncSliders);
syncSliders();

btnFire.addEventListener('click', async () => {
  await unlockAudio();
  playFireSfx();

  const angleDeg = Number(elAngle.value);
  const power01 = Number(elPower.value);

  // For 1v1, second player shoots leftwards. We mirror angle.
  // This is MVP convenience; later we’ll use tank facing + aiming.
  const me = (lastState?.players || []).find(p => p.id === myId);
  if (me && me.x > (lastState?.world?.width || 1000) / 2) {
    send({ type: 'fire', angleDeg: 180 - angleDeg, power01 });
  } else {
    send({ type: 'fire', angleDeg, power01 });
  }
});

// Mute button
btnMute.textContent = isMuted() ? 'Unmute Music' : 'Mute Music';
btnMute.addEventListener('click', () => {
  const nowMuted = toggleMute();
  btnMute.textContent = nowMuted ? 'Unmute Music' : 'Mute Music';
});

// basic redraw loop
setInterval(() => {
  if (lastState) draw(ctx, lastState, lastShot, matchOverInfo);
}, 200);
