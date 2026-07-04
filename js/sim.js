// Ball-physics sim (homepage easter egg).
// Uses Pointer Events so it works with both mouse and touch.

const canvas = document.getElementById("sim");
const ctx = canvas.getContext("2d");
const toggleBtn = document.getElementById("sim-toggle-btn");
const controls = document.getElementById("sim-controls");
const colorInput = document.getElementById("ball-color");
const addBallBtn = document.getElementById("add-ball");

const gravityYSlider = document.getElementById("gravity-y");
const gravityYValue = document.getElementById("gravity-y-value");
const bounceSlider = document.getElementById("bounce");
const bounceValue = document.getElementById("bounce-value");

// Simulation state
let balls = [];
let draggingBallIdx = null;
let lastMouse = { x: 0, y: 0 };
let animId;

let gravityY = 0.3;
let bounce = 0.7;

function createBall(x, y, color) {
  return {
    x,
    y,
    radius: 20,
    dx: 0,
    dy: 0,
    color: color || colorInput.value,
  };
}

function resetSimVars() {
  balls = [createBall(canvas.width / 2, canvas.height / 2, colorInput.value)];
  draggingBallIdx = null;
  lastMouse = { x: 0, y: 0 };
}

// Size the canvas to fit small screens (600px max, internal resolution matches)
function sizeCanvas() {
  const w = Math.min(600, window.innerWidth - 40);
  canvas.width = w;
  canvas.height = Math.round(w * 2 / 3);
}

function addSimListeners() {
  canvas.addEventListener("pointerdown", onPointerDown);
  // Move/up on window so a drag released outside the canvas still ends
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  addBallBtn.addEventListener("click", onAddBall);
  gravityYSlider.addEventListener("input", onGravityChange);
  bounceSlider.addEventListener("input", onBounceChange);
}

function removeSimListeners() {
  canvas.removeEventListener("pointerdown", onPointerDown);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  addBallBtn.removeEventListener("click", onAddBall);
  gravityYSlider.removeEventListener("input", onGravityChange);
  bounceSlider.removeEventListener("input", onBounceChange);
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  e.preventDefault();
  const { x, y } = pointerPos(e);
  for (let i = balls.length - 1; i >= 0; i--) {
    const ball = balls[i];
    const dist = Math.hypot(x - ball.x, y - ball.y);
    if (dist <= ball.radius) {
      draggingBallIdx = i;
      lastMouse = { x, y };
      ball.dx = 0;
      ball.dy = 0;
      break;
    }
  }
}

function onPointerMove(e) {
  if (draggingBallIdx === null) return;
  const { x, y } = pointerPos(e);
  const ball = balls[draggingBallIdx];
  ball.x = x;
  ball.y = y;
  ball.dx = x - lastMouse.x;
  ball.dy = y - lastMouse.y;
  lastMouse = { x, y };
}

function onPointerUp() {
  draggingBallIdx = null;
}

function onAddBall() {
  const x = canvas.width * (0.15 + Math.random() * 0.7);
  const y = canvas.height * (0.15 + Math.random() * 0.5);
  balls.push(createBall(x, y, colorInput.value));
}

function onGravityChange() {
  gravityY = parseFloat(gravityYSlider.value);
  gravityYValue.textContent = gravityY;
}

function onBounceChange() {
  bounce = parseFloat(bounceSlider.value);
  bounceValue.textContent = bounce;
}

// Main simulation loop
function update() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Ball physics and wall collisions
  balls.forEach((ball, idx) => {
    if (draggingBallIdx !== idx) {
      ball.dy += gravityY;
      ball.x += ball.dx;
      ball.y += ball.dy;
      // Friction
      ball.dx *= 0.99;
      ball.dy *= 0.99;
      // Walls
      if (ball.y + ball.radius > canvas.height) {
        ball.y = canvas.height - ball.radius;
        ball.dy *= -bounce;
      }
      if (ball.y - ball.radius < 0) {
        ball.y = ball.radius;
        ball.dy *= -bounce;
      }
      if (ball.x + ball.radius > canvas.width) {
        ball.x = canvas.width - ball.radius;
        ball.dx *= -bounce;
      }
      if (ball.x - ball.radius < 0) {
        ball.x = ball.radius;
        ball.dx *= -bounce;
      }
    }
  });

  // Ball-ball collisions (elastic, equal masses)
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const minDist = a.radius + b.radius;
      if (dist < minDist) {
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        // Separate balls so they don't overlap
        a.x -= nx * overlap / 2;
        a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2;
        b.y += ny * overlap / 2;
        // Exchange velocities along the collision normal
        const dvx = b.dx - a.dx;
        const dvy = b.dy - a.dy;
        const impact = dvx * nx + dvy * ny;
        if (impact < 0) {
          a.dx += impact * nx * bounce;
          a.dy += impact * ny * bounce;
          b.dx -= impact * nx * bounce;
          b.dy -= impact * ny * bounce;
        }
      }
    }
  }

  // Draw all balls
  balls.forEach((ball, idx) => {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fillStyle = draggingBallIdx === idx ? "orange" : ball.color;
    ctx.fill();
    ctx.closePath();
  });
  animId = requestAnimationFrame(update);
}

function showSim() {
  sizeCanvas();
  canvas.style.display = "block";
  controls.style.display = "block";
  toggleBtn.innerText = "✕";
  toggleBtn.title = "Close Sim";
  resetSimVars();
  addSimListeners();
  onGravityChange();
  onBounceChange();
  update();
}

function hideSim() {
  canvas.style.display = "none";
  controls.style.display = "none";
  toggleBtn.innerText = "▶";
  toggleBtn.title = "Open Sim";
  removeSimListeners();
  if (animId) cancelAnimationFrame(animId);
}

let simVisible = false;
toggleBtn.addEventListener("click", () => {
  simVisible = !simVisible;
  if (simVisible) {
    showSim();
  } else {
    hideSim();
  }
});

hideSim();
