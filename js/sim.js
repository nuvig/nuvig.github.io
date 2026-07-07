// Neon ball-physics playground (homepage easter egg).
// Fullscreen canvas with glowing balls, motion trails, gravity modes,
// pointer gravity wells, collision sparks and shockwave blasts.
// Uses Pointer Events so it works with both mouse and touch.

const canvas = document.getElementById("sim");
const ctx = canvas.getContext("2d");
const toggleBtn = document.getElementById("sim-toggle-btn");
const controls = document.getElementById("sim-controls");
const addBallBtn = document.getElementById("add-ball");
const blastBtn = document.getElementById("blast");
const clearBtn = document.getElementById("clear-balls");
const ballCountEl = document.getElementById("ball-count");
const modeBtns = Array.from(document.querySelectorAll("#sim-controls .mode-btn"));

const gravitySlider = document.getElementById("gravity-y");
const bounceSlider = document.getElementById("bounce");
const trailsSlider = document.getElementById("trails");

const MAX_BALLS = 240;
const MAX_SPARKS = 400;

// Simulation state
let balls = [];
let sparks = [];
let rings = [];
let draggingBall = null;
let pointer = { x: 0, y: 0, down: false, wellActive: false };
let animId = null;

let mode = "gravity"; // gravity | orbit | repel | zerog
let gravity = 0.25;
let bounce = 0.85;
let trailFade = 0.75; // 0 = no trails, higher = longer trails
let spawnHue = Math.random() * 360;
let viewW = 0;
let viewH = 0;

function nextHue() {
  spawnHue = (spawnHue + 12) % 360;
  return spawnHue + (Math.random() * 20 - 10);
}

function createBall(x, y, dx, dy) {
  const radius = 8 + Math.random() * 14;
  return { x, y, dx, dy, radius, hue: nextHue() };
}

function addBall(ball) {
  balls.push(ball);
  if (balls.length > MAX_BALLS) balls.splice(0, balls.length - MAX_BALLS);
}

// Spawn a radial burst of balls, tangential in orbit mode so they circle the well
function spawnBurst(x, y, count) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const speed = 2 + Math.random() * 4;
    let dx = Math.cos(angle) * speed;
    let dy = Math.sin(angle) * speed;
    if (mode === "orbit") {
      const cx = viewW / 2, cy = viewH / 2;
      const toC = Math.atan2(cy - y, cx - x);
      dx = Math.cos(toC + Math.PI / 2) * (4 + Math.random() * 3);
      dy = Math.sin(toC + Math.PI / 2) * (4 + Math.random() * 3);
    }
    addBall(createBall(x, y, dx, dy));
  }
}

function spawnSparks(x, y, hue, count, speed) {
  for (let i = 0; i < count; i++) {
    if (sparks.length >= MAX_SPARKS) return;
    const angle = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random());
    sparks.push({
      x, y, hue,
      dx: Math.cos(angle) * s,
      dy: Math.sin(angle) * s,
      life: 1,
    });
  }
}

// Shockwave: expanding ring plus an outward impulse on every ball
function blast(x, y) {
  rings.push({ x, y, r: 10, alpha: 1 });
  balls.forEach((ball) => {
    const dx = ball.x - x;
    const dy = ball.y - y;
    const dist = Math.hypot(dx, dy) || 1;
    const kick = Math.min(18, 900 / dist);
    ball.dx += (dx / dist) * kick;
    ball.dy += (dy / dist) * kick;
  });
  spawnSparks(x, y, spawnHue, 24, 8);
}

function resetSimVars() {
  balls = [];
  sparks = [];
  rings = [];
  draggingBall = null;
  const cx = viewW / 2, cy = viewH / 2;
  spawnBurst(cx, cy, 12);
}

// Fullscreen, devicePixelRatio-aware canvas
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintBackdrop(1);
}

function paintBackdrop(alpha) {
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(4, 7, 15, ${alpha})`;
  ctx.fillRect(0, 0, viewW, viewH);
}

function setMode(next) {
  mode = next;
  modeBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
}

function addSimListeners() {
  canvas.addEventListener("pointerdown", onPointerDown);
  // Move/up on window so a drag released outside the canvas still ends
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", sizeCanvas);
  window.addEventListener("keydown", onKeyDown);
  addBallBtn.addEventListener("click", onAddBalls);
  blastBtn.addEventListener("click", onBlastBtn);
  clearBtn.addEventListener("click", resetSimVars);
  modeBtns.forEach((btn) => btn.addEventListener("click", onModeClick));
  gravitySlider.addEventListener("input", onSliderChange);
  bounceSlider.addEventListener("input", onSliderChange);
  trailsSlider.addEventListener("input", onSliderChange);
}

function removeSimListeners() {
  canvas.removeEventListener("pointerdown", onPointerDown);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("resize", sizeCanvas);
  window.removeEventListener("keydown", onKeyDown);
  addBallBtn.removeEventListener("click", onAddBalls);
  blastBtn.removeEventListener("click", onBlastBtn);
  clearBtn.removeEventListener("click", resetSimVars);
  modeBtns.forEach((btn) => btn.removeEventListener("click", onModeClick));
  gravitySlider.removeEventListener("input", onSliderChange);
  bounceSlider.removeEventListener("input", onSliderChange);
  trailsSlider.removeEventListener("input", onSliderChange);
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  e.preventDefault();
  const { x, y } = pointerPos(e);
  pointer.x = x;
  pointer.y = y;
  pointer.down = true;

  for (let i = balls.length - 1; i >= 0; i--) {
    const ball = balls[i];
    if (Math.hypot(x - ball.x, y - ball.y) <= ball.radius + 6) {
      draggingBall = ball;
      ball.dx = 0;
      ball.dy = 0;
      return;
    }
  }

  // Empty space: bend space in orbit/repel, burst balls otherwise
  if (mode === "orbit" || mode === "repel") {
    pointer.wellActive = true;
  } else {
    spawnBurst(x, y, 6);
  }
}

function onPointerMove(e) {
  const { x, y } = pointerPos(e);
  if (draggingBall) {
    draggingBall.dx = x - pointer.x;
    draggingBall.dy = y - pointer.y;
    draggingBall.x = x;
    draggingBall.y = y;
  }
  pointer.x = x;
  pointer.y = y;
}

function onPointerUp() {
  draggingBall = null;
  pointer.down = false;
  pointer.wellActive = false;
}

function onKeyDown(e) {
  if (e.key === "Escape") setSimVisible(false);
  if (e.key === " " && !e.repeat) {
    e.preventDefault();
    blast(viewW / 2, viewH / 2);
  }
}

function onModeClick(e) {
  setMode(e.currentTarget.dataset.mode);
}

function onAddBalls() {
  spawnBurst(
    viewW * (0.2 + Math.random() * 0.6),
    viewH * (0.2 + Math.random() * 0.5),
    10
  );
}

function onBlastBtn() {
  blast(viewW / 2, viewH / 2);
}

function onSliderChange() {
  gravity = parseFloat(gravitySlider.value);
  bounce = parseFloat(bounceSlider.value);
  trailFade = parseFloat(trailsSlider.value);
}

function applyForces(ball) {
  if (mode === "gravity") {
    ball.dy += gravity;
    ball.dx *= 0.995;
    ball.dy *= 0.995;
  } else if (mode === "orbit") {
    // Attract toward the held pointer, or the screen center when idle
    const wx = pointer.wellActive ? pointer.x : viewW / 2;
    const wy = pointer.wellActive ? pointer.y : viewH / 2;
    const dx = wx - ball.x;
    const dy = wy - ball.y;
    const dist = Math.max(Math.hypot(dx, dy), 40);
    const pull = gravity * 3000 / (dist * dist) + 0.02;
    ball.dx += (dx / dist) * pull;
    ball.dy += (dy / dist) * pull;
    ball.dx *= 0.999;
    ball.dy *= 0.999;
  } else if (mode === "repel") {
    if (pointer.wellActive) {
      const dx = ball.x - pointer.x;
      const dy = ball.y - pointer.y;
      const dist = Math.max(Math.hypot(dx, dy), 30);
      const push = gravity * 4000 / (dist * dist);
      ball.dx += (dx / dist) * push;
      ball.dy += (dy / dist) * push;
    }
    ball.dx *= 0.998;
    ball.dy *= 0.998;
  }
  // zerog: pure drift, no drag
}

function wallCollisions(ball) {
  let hit = 0;
  if (ball.y + ball.radius > viewH) {
    ball.y = viewH - ball.radius;
    hit = Math.abs(ball.dy);
    ball.dy *= -bounce;
  } else if (ball.y - ball.radius < 0) {
    ball.y = ball.radius;
    hit = Math.abs(ball.dy);
    ball.dy *= -bounce;
  }
  if (ball.x + ball.radius > viewW) {
    ball.x = viewW - ball.radius;
    hit = Math.max(hit, Math.abs(ball.dx));
    ball.dx *= -bounce;
  } else if (ball.x - ball.radius < 0) {
    ball.x = ball.radius;
    hit = Math.max(hit, Math.abs(ball.dx));
    ball.dx *= -bounce;
  }
  if (hit > 7) spawnSparks(ball.x, ball.y, ball.hue, 4, hit * 0.4);
}

// Ball-ball collisions: impulse weighted by mass (∝ radius²), sparks on hard hits
function ballCollisions() {
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDist = a.radius + b.radius;
      if (Math.abs(dx) > minDist || Math.abs(dy) > minDist) continue;
      const dist = Math.hypot(dx, dy) || 0.01;
      if (dist >= minDist) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minDist - dist;
      a.x -= nx * overlap / 2;
      a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2;
      b.y += ny * overlap / 2;

      const vn = (b.dx - a.dx) * nx + (b.dy - a.dy) * ny;
      if (vn < 0) {
        const ma = a.radius * a.radius;
        const mb = b.radius * b.radius;
        const impulse = (-(1 + bounce) * vn) / (1 / ma + 1 / mb);
        a.dx -= (impulse / ma) * nx;
        a.dy -= (impulse / ma) * ny;
        b.dx += (impulse / mb) * nx;
        b.dy += (impulse / mb) * ny;
        if (-vn > 6) {
          spawnSparks(
            a.x + nx * a.radius,
            a.y + ny * a.radius,
            (a.hue + b.hue) / 2,
            5,
            -vn * 0.35
          );
        }
      }
    }
  }
}

function drawBall(ball) {
  const glow = ctx.createRadialGradient(
    ball.x, ball.y, 0,
    ball.x, ball.y, ball.radius * 2.4
  );
  glow.addColorStop(0, `hsla(${ball.hue}, 100%, 78%, 1)`);
  glow.addColorStop(0.35, `hsla(${ball.hue}, 100%, 55%, 0.85)`);
  glow.addColorStop(1, `hsla(${ball.hue}, 100%, 50%, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius * 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawWell() {
  if (!pointer.wellActive) return;
  const pulse = 14 + Math.sin(performance.now() / 120) * 4;
  ctx.strokeStyle = mode === "repel" ? "rgba(255,90,90,0.8)" : "rgba(120,180,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pointer.x, pointer.y, pulse, 0, Math.PI * 2);
  ctx.stroke();
}

// Main simulation loop
function update() {
  paintBackdrop(1 - trailFade);
  ctx.globalCompositeOperation = "lighter";

  balls.forEach((ball) => {
    if (ball === draggingBall) return;
    applyForces(ball);
    ball.x += ball.dx;
    ball.y += ball.dy;
    wallCollisions(ball);
  });
  ballCollisions();

  balls.forEach(drawBall);

  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.dx;
    s.y += s.dy;
    s.dx *= 0.94;
    s.dy *= 0.94;
    s.life -= 0.03;
    if (s.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    ctx.fillStyle = `hsla(${s.hue}, 100%, 70%, ${s.life})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2 * s.life + 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i];
    ring.r += 14;
    ring.alpha -= 0.035;
    if (ring.alpha <= 0) {
      rings.splice(i, 1);
      continue;
    }
    ctx.strokeStyle = `rgba(180, 220, 255, ${ring.alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawWell();
  ctx.globalCompositeOperation = "source-over";

  ballCountEl.textContent = `${balls.length} balls`;
  animId = requestAnimationFrame(update);
}

function showSim() {
  canvas.style.display = "block";
  controls.style.display = "block";
  toggleBtn.innerText = "✕";
  toggleBtn.title = "Close Sim";
  sizeCanvas();
  resetSimVars();
  addSimListeners();
  onSliderChange();
  setMode(mode);
  update();
}

function hideSim() {
  canvas.style.display = "none";
  controls.style.display = "none";
  toggleBtn.innerText = "▶";
  toggleBtn.title = "Open Sim";
  removeSimListeners();
  if (animId) cancelAnimationFrame(animId);
  animId = null;
}

let simVisible = false;
function setSimVisible(visible) {
  if (visible === simVisible) return;
  simVisible = visible;
  if (simVisible) {
    showSim();
  } else {
    hideSim();
  }
}

toggleBtn.addEventListener("click", () => setSimVisible(!simVisible));

hideSim();
