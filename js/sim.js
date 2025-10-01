


// Get DOM elements for canvas, controls, color picker, add ball button, and gravity sliders
const canvas = document.getElementById("sim");
const ctx = canvas.getContext("2d");
const toggleBtn = document.getElementById("sim-toggle-btn");
const controls = document.getElementById("sim-controls");
const colorInput = document.getElementById("ball-color");
const addBallBtn = document.getElementById("add-ball");
const gravityXSlider = document.getElementById("gravity-x");
const gravityYSlider = document.getElementById("gravity-y");
const gravityXValue = document.getElementById("gravity-x-value");
const gravityYValue = document.getElementById("gravity-y-value");

// Simulation state
let balls = [];
let draggingBallIdx = null;
let lastMouse = { x: 0, y: 0 };
let animId;

// Gravity vector (updated by sliders)
let gravity = { x: 0, y: 0.3 };

// Ball factory function
function createBall(x, y, color) {
  return {
    x,
    y,
    radius: 20,
    dx: 0,
    dy: 0,
    bounce: 0.7,
    color: color || colorInput.value
  };
}

// Reset simulation to one ball and default state
function resetSimVars() {
  balls = [createBall(300, 200, colorInput.value)];
  draggingBallIdx = null;
  lastMouse = { x: 0, y: 0 };
}

// Add all event listeners for sim controls and canvas
function addSimListeners() {
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
  addBallBtn.addEventListener("click", onAddBall);
  colorInput.addEventListener("input", onColorChange);
  gravityXSlider.addEventListener("input", onGravityChange);
  gravityYSlider.addEventListener("input", onGravityChange);
}
// Remove all event listeners
function removeSimListeners() {
  canvas.removeEventListener("mousedown", onMouseDown);
  canvas.removeEventListener("mousemove", onMouseMove);
  canvas.removeEventListener("mouseup", onMouseUp);
  addBallBtn.removeEventListener("click", onAddBall);
  colorInput.removeEventListener("input", onColorChange);
  gravityXSlider.removeEventListener("input", onGravityChange);
  gravityYSlider.removeEventListener("input", onGravityChange);
}

// Mouse down: start dragging a ball if clicked
function onMouseDown(e) {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  for (let i = balls.length - 1; i >= 0; i--) {
    const ball = balls[i];
    const dist = Math.sqrt((mouseX - ball.x) ** 2 + (mouseY - ball.y) ** 2);
    if (dist <= ball.radius) {
      draggingBallIdx = i;
      lastMouse = { x: mouseX, y: mouseY };
      ball.dx = 0;
      ball.dy = 0;
      break;
    }
  }
}
// Mouse move: drag the selected ball
function onMouseMove(e) {
  if (draggingBallIdx !== null) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const ball = balls[draggingBallIdx];
    ball.x = mouseX;
    ball.y = mouseY;
    ball.dx = mouseX - lastMouse.x;
    ball.dy = mouseY - lastMouse.y;
    lastMouse = { x: mouseX, y: mouseY };
  }
}
// Mouse up: stop dragging
function onMouseUp() {
  draggingBallIdx = null;
}

// Add a new ball at a random position with the selected color
function onAddBall() {
  balls.push(createBall(100 + Math.random() * 400, 100 + Math.random() * 200, colorInput.value));
}

// Color picker change (optional: could update all balls)
function onColorChange() {
  // balls.forEach(ball => ball.color = colorInput.value);
}

// Gravity slider change: update gravity vector and display values
function onGravityChange() {
  gravity.x = parseFloat(gravityXSlider.value);
  gravity.y = parseFloat(gravityYSlider.value);
  gravityXValue.textContent = gravity.x;
  gravityYValue.textContent = gravity.y;
}

// Main simulation loop
function update() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Ball physics and wall collisions
  balls.forEach((ball, idx) => {
    if (draggingBallIdx !== idx) {
      // Apply gravity from sliders
      ball.dx += gravity.x;
      ball.dy += gravity.y;
      // Move ball
      ball.x += ball.dx;
      ball.y += ball.dy;
      // Friction
      ball.dx *= 0.99;
      ball.dy *= 0.99;
      // Bounce off floor
      if (ball.y + ball.radius > canvas.height) {
        ball.y = canvas.height - ball.radius;
        ball.dy *= -ball.bounce;
      }
      // Bounce off ceiling
      if (ball.y - ball.radius < 0) {
        ball.y = ball.radius;
        ball.dy *= -ball.bounce;
      }
      // Bounce off right wall
      if (ball.x + ball.radius > canvas.width) {
        ball.x = canvas.width - ball.radius;
        ball.dx *= -ball.bounce;
      }
      // Bounce off left wall
      if (ball.x - ball.radius < 0) {
        ball.x = ball.radius;
        ball.dx *= -ball.bounce;
      }
    }
  });

  // Ball-ball collisions (elastic)
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      let a = balls[i], b = balls[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      let minDist = a.radius + b.radius;
      if (dist < minDist) {
        // Calculate overlap and normal vector
        let overlap = minDist - dist;
        let nx = dx / dist;
        let ny = dy / dist;
        // Separate balls so they don't overlap
        a.x -= nx * overlap / 2;
        a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2;
        b.y += ny * overlap / 2;
        // Exchange velocities along the collision normal
        let dvx = b.dx - a.dx;
        let dvy = b.dy - a.dy;
        let impact = dvx * nx + dvy * ny;
        if (impact < 0) {
          let bounce = 0.7;
          let impulse = (2 * impact) / 2;
          a.dx += impulse * nx * bounce;
          a.dy += impulse * ny * bounce;
          b.dx -= impulse * nx * bounce;
          b.dy -= impulse * ny * bounce;
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

// Show sim and controls, reset state, and start animation
function showSim() {
  canvas.style.display = "block";
  controls.style.display = "block";
  toggleBtn.innerText = "✕";
  toggleBtn.title = "Close Sim";
  resetSimVars();
  addSimListeners();
  onGravityChange(); // Initialize gravity values
  update();
}

// Hide sim and controls, stop animation
function hideSim() {
  canvas.style.display = "none";
  controls.style.display = "none";
  toggleBtn.innerText = "▶";
  toggleBtn.title = "Open Sim";
  removeSimListeners();
  if (animId) cancelAnimationFrame(animId);
}

// Toggle sim visibility on button click
let simVisible = false;
toggleBtn.addEventListener("click", () => {
  simVisible = !simVisible;
  if (simVisible) {
    showSim();
  } else {
    hideSim();
  }
});

// Hide sim on load
hideSim();
