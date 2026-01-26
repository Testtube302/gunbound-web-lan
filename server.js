import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0'; // bind all interfaces for LAN

const app = express();
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Room model (MVP1) ----
// One room, supports up to 2 players.
const state = {
  players: new Map(), // id -> { id, name, ready, hp, x, y }
  nextId: 1,
  phase: 'lobby', // lobby|match|shot
  turn: null, // playerId
  wind: 0, // px/s^2 (lateral accel)
  lastResult: null,
};

const WORLD = {
  width: 1000,
  height: 600,
  groundY: 520,
};

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function snapshot() {
  return {
    type: 'state',
    phase: state.phase,
    turn: state.turn,
    wind: state.wind,
    world: WORLD,
    players: Array.from(state.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      ready: !!p.ready,
      hp: p.hp ?? 100,
      x: p.x ?? 0,
      y: p.y ?? 0,
    })),
    lastResult: state.lastResult,
  };
}

function chooseWind() {
  // small-ish wind for MVP (tweak later)
  const min = -120;
  const max = 120;
  return Math.round(min + Math.random() * (max - min));
}

function canHitWithWind(shooterId, windAx) {
  // Brute-force search over (angle,power) using the same physics as simulateShot.
  // Goal: guarantee that for the current turn's wind, at least one hit is possible.
  const shooter = state.players.get(shooterId);
  if (!shooter) return false;

  const targets = Array.from(state.players.values())
    .filter(p => p.id !== shooterId)
    .map(p => ({ id: p.id, x: p.x, y: p.y - 12, r: 18 }));
  if (!targets.length) return false;

  const SPEED_MAX = 900;
  const g = 900;
  const dt = 1 / 60;
  const maxT = 10.0;

  // Match UI behavior:
  // - Left tank uses UI angles 5..85 directly (shooting right)
  // - Right tank's UI angle is mirrored client-side (180-angle), so server sees 95..175
  const primaryTarget = targets[0];
  const shootRight = shooter.x < primaryTarget.x;
  const angleStart = shootRight ? 5 : 95;
  const angleEnd = shootRight ? 85 : 175;

  // Coarse grid; fast enough for a 2-player game.
  for (let angleDeg = angleStart; angleDeg <= angleEnd; angleDeg += 2) {
    const angle = (angleDeg * Math.PI) / 180;
    for (let power01 = 0.2; power01 <= 1.0001; power01 += 0.03) {
      const speed = SPEED_MAX * power01;

      let x = shooter.x;
      let y = shooter.y - 18;
      let vx = Math.cos(angle) * speed;
      let vy = -Math.sin(angle) * speed;

      for (let t = 0; t < maxT; t += dt) {
        vx += windAx * dt;
        vy += g * dt;
        x += vx * dt;
        y += vy * dt;

        if (y >= WORLD.groundY) break;
        if (x < -200 || x > WORLD.width + 200 || y > WORLD.height + 200) break;

        const dx = x - primaryTarget.x;
        const dy = y - primaryTarget.y;
        if (dx * dx + dy * dy <= primaryTarget.r * primaryTarget.r) return true;
      }
    }
  }
  return false;
}

function chooseWindForTurn(shooterId) {
  // Try to keep full wind range, but re-roll until at least one valid hit is possible.
  for (let tries = 0; tries < 60; tries++) {
    const w = chooseWind();
    if (canHitWithWind(shooterId, w)) return w;
  }
  // Fallback: calm day
  return 0;
}

function startMatch() {
  const ps = Array.from(state.players.values());
  if (ps.length !== 2) return;
  state.phase = 'match';
  state.lastResult = null;

  // --- Spawn randomization (replayability) ---
  // We randomize spawn X positions each match.
  // Wind is then chosen for the first turn in a way that guarantees a solution.
  const leftMin = 120;
  const leftMax = 360;
  const rightMin = 640;
  const rightMax = 880;

  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

  let x1 = 160;
  let x2 = 840;
  for (let tries = 0; tries < 80; tries++) {
    const a = randInt(leftMin, leftMax);
    const b = randInt(rightMin, rightMax);
    const dx = b - a;

    // Keep players separated but not extreme.
    if (dx > 260 && dx < 860) {
      x1 = a;
      x2 = b;
      break;
    }
  }

  ps[0].hp = 100;
  ps[1].hp = 100;
  ps[0].x = x1;
  ps[1].x = x2;
  ps[0].y = WORLD.groundY;
  ps[1].y = WORLD.groundY;

  // first turn: first joined player
  state.turn = ps[0].id;

  // Choose wind for the opening turn that still allows at least one valid hit.
  state.wind = chooseWindForTurn(state.turn);
}

function endTurn() {
  const ps = Array.from(state.players.values());
  if (ps.length !== 2) return;
  state.turn = (state.turn === ps[0].id) ? ps[1].id : ps[0].id;
  // Pick wind for the upcoming shooter, guaranteeing at least one possible hit.
  state.wind = chooseWindForTurn(state.turn);
}

function simulateShot(shooterId, angleDeg, power01) {
  // Server-authoritative projectile sim
  // angle in degrees, power01 [0..1]
  const shooter = state.players.get(shooterId);
  if (!shooter) return null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  angleDeg = clamp(angleDeg, 0, 180);
  power01 = clamp(power01, 0.05, 1.0);

  const angle = (angleDeg * Math.PI) / 180;

  // Tunables
  // NOTE: Keep SPEED_MAX + g in sync with startMatch() solvability constraints.
  const SPEED_MAX = 900;       // px/s at power01=1.0
  const speed = SPEED_MAX * power01;
  const g = 900;               // px/s^2
  const windAx = state.wind;   // px/s^2

  let x = shooter.x;
  let y = shooter.y - 18;
  let vx = Math.cos(angle) * speed;
  let vy = -Math.sin(angle) * speed;

  const dt = 1 / 60;
  const maxT = 10.0; // allow longer arcs now that shots can traverse the map
  const path = [];

  // target circles (tanks)
  const targets = Array.from(state.players.values())
    .filter(p => p.id !== shooterId)
    .map(p => ({ id: p.id, x: p.x, y: p.y - 12, r: 18 }));

  let impact = null;
  let hit = null;

  for (let t = 0; t < maxT; t += dt) {
    vx += windAx * dt;
    vy += g * dt;
    x += vx * dt;
    y += vy * dt;

    path.push([Math.round(x), Math.round(y)]);

    // ground hit
    if (y >= WORLD.groundY) {
      impact = { x: Math.round(x), y: WORLD.groundY, kind: 'ground' };
      break;
    }

    // bounds
    if (x < -200 || x > WORLD.width + 200 || y > WORLD.height + 200) {
      impact = { x: Math.round(x), y: Math.round(y), kind: 'out' };
      break;
    }

    // tank hit (circle)
    for (const tg of targets) {
      const dx = x - tg.x;
      const dy = y - tg.y;
      if (dx * dx + dy * dy <= tg.r * tg.r) {
        impact = { x: Math.round(x), y: Math.round(y), kind: 'tank', targetId: tg.id };
        hit = tg.id;
        break;
      }
    }
    if (hit) break;
  }

  // Apply simple damage
  const events = [];
  if (hit) {
    const target = state.players.get(hit);
    if (target) {
      target.hp = Math.max(0, (target.hp ?? 100) - 25);
      events.push({ type: 'damage', targetId: hit, amount: 25, hp: target.hp });
      if (target.hp === 0) events.push({ type: 'ko', targetId: hit });
    }
  }

  return {
    shooterId,
    angleDeg,
    power01,
    wind: state.wind,
    path,
    impact,
    events,
  };
}

wss.on('connection', (ws, req) => {
  const id = `p${state.nextId++}`;
  ws._id = id;

  ws.send(JSON.stringify({ type: 'hello', id, maxPlayers: 2 }));
  ws.send(JSON.stringify(snapshot()));

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const name = String(msg.name || 'Player').slice(0, 32);
      if (!state.players.has(id) && state.players.size >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full (2 players).' }));
        return;
      }
      state.players.set(id, { id, name, ready: false, hp: 100, x: 0, y: 0 });
      // If someone joins mid-match for MVP, reset to lobby
      if (state.players.size !== 2) {
        state.phase = 'lobby';
        state.turn = null;
        state.lastResult = null;
      }
      broadcast(snapshot());
      return;
    }

    if (msg.type === 'leave') {
      state.players.delete(id);
      state.phase = 'lobby';
      state.turn = null;
      state.lastResult = null;
      broadcast(snapshot());
      return;
    }

    if (msg.type === 'ready') {
      const p = state.players.get(id);
      if (!p) return;
      p.ready = !!msg.ready;

      // Auto-start when 2 players and both ready
      const ps = Array.from(state.players.values());
      if (ps.length === 2 && ps.every(x => x.ready)) {
        startMatch();
      }
      broadcast(snapshot());
      return;
    }

    if (msg.type === 'fire') {
      if (state.phase !== 'match') return;
      if (state.turn !== id) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not your turn.' }));
        return;
      }

      state.phase = 'shot';
      const result = simulateShot(id, Number(msg.angleDeg), Number(msg.power01));
      state.lastResult = result;
      // Broadcast immediate result
      broadcast({ type: 'shot_result', result });

      // Progress turn unless someone died
      const ko = (result?.events || []).find(e => e.type === 'ko');
      if (ko) {
        // end match (MVP): back to lobby after KO
        state.phase = 'lobby';
        state.turn = null;
        // clear ready flags
        for (const p of state.players.values()) p.ready = false;
        broadcast({ type: 'match_over', winnerId: id, koId: ko.targetId });
        broadcast(snapshot());
        return;
      }

      // End shot phase and swap turn
      state.phase = 'match';
      endTurn();
      broadcast(snapshot());
      return;
    }
  });

  ws.on('close', () => {
    state.players.delete(id);
    broadcast(snapshot());
  });
});

server.listen(PORT, HOST, () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const infos of Object.values(ifaces)) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) ips.push(info.address);
    }
  }

  console.log(`Gunbound-web-LAN server listening on http://${HOST}:${PORT}`);
  if (ips.length) {
    console.log('LAN URLs (open on phones):');
    for (const ip of ips) console.log(`  http://${ip}:${PORT}/`);
  } else {
    console.log('No LAN IPs detected. Are you connected to Wi-Fi?');
  }
  console.log('WebSocket path: /ws');
});
