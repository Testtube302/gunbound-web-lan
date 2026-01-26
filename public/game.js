const tankBlue = new Image();
const tankRed = new Image();
// SVGs live in /public/assets
// (Fallback to simple shapes while images load.)
tankBlue.src = './assets/tank-blue.svg';
tankRed.src = './assets/tank-red.svg';

function drawTank(ctx, p, idx) {
  const img = (idx % 2 === 0) ? tankBlue : tankRed;

  // Anchor tanks so their "treads" sit on ground (p.y is groundY).
  const w = 64;
  const h = 42;
  const x = Math.round(p.x - w / 2);
  const y = Math.round(p.y - h);

  const facingLeft = p.x > 500; // crude MVP facing

  if (img.complete && img.naturalWidth > 0) {
    ctx.save();
    if (facingLeft) {
      ctx.translate(x + w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, y, w, h);
    } else {
      ctx.drawImage(img, x, y, w, h);
    }
    ctx.restore();
  } else {
    // Fallback: circle while sprite loads
    ctx.fillStyle = (idx % 2 === 0) ? '#7aa2ff' : '#ff5c7a';
    ctx.beginPath();
    ctx.arc(p.x, p.y - 12, 18, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function draw(ctx, state, shotResult) {
  const world = state?.world || { width: 1000, height: 600, groundY: 520 };
  ctx.clearRect(0, 0, world.width, world.height);

  // background
  ctx.fillStyle = '#0c0f16';
  ctx.fillRect(0, 0, world.width, world.height);

  // ground
  ctx.fillStyle = '#1f2a3b';
  ctx.fillRect(0, world.groundY, world.width, world.height - world.groundY);

  // wind
  ctx.fillStyle = '#a8b3cc';
  ctx.font = '16px system-ui';
  const wind = state?.wind ?? 0;
  ctx.fillText(`Wind: ${wind}`, 14, 22);

  // players
  const players = state?.players || [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];

    // tank sprite
    drawTank(ctx, p, i);

    // hp
    ctx.fillStyle = '#e7eefc';
    ctx.fillText(`${p.name} HP:${p.hp}`, p.x - 44, p.y - 48);

    // turn indicator
    if (state?.turn === p.id && state?.phase === 'match') {
      ctx.strokeStyle = '#ffcc66';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y - 28, 26, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // last shot path
  const r = shotResult || state?.lastResult;
  if (r?.path?.length) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < r.path.length; i++) {
      const [x, y] = r.path[i];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  if (r?.impact) {
    ctx.fillStyle = '#ff5c7a';
    ctx.beginPath();
    ctx.arc(r.impact.x, r.impact.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}
