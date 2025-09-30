
const canvas = document.getElementById("sim");
const ctx = canvas.getContext("2d");
const toggleBtn = document.getElementById("sim-toggle-btn");

let ball, dragging, lastMouse, animId;

function resetSimVars() {
  ball = {
    x: 300,
    y: 200,
    radius: 20,
    dx: 0,
    dy: 0,
    gravity: 0.3,
    bounce: 0.7
  };
  dragging = false;
  lastMouse = { x: 0, y: 0 };
}

function addSimListeners() {
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
}
function removeSimListeners() {
  canvas.removeEventListener("mousedown", onMouseDown);
  canvas.removeEventListener("mousemove", onMouseMove);
  canvas.removeEventListener("mouseup", onMouseUp);
}

function onMouseDown(e) {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const dist = Math.sqrt((mouseX - ball.x) ** 2 + (mouseY - ball.y) ** 2);
  if (dist <= ball.radius) {
    dragging = true;
    lastMouse = { x: mouseX, y: mouseY };
    ball.dx = 0;
    ball.dy = 0;
  }
}
function onMouseMove(e) {
  if (dragging) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    ball.x = mouseX;
    ball.y = mouseY;
    ball.dx = mouseX - lastMouse.x;
    ball.dy = mouseY - lastMouse.y;
    lastMouse = { x: mouseX, y: mouseY };
  }
}
function onMouseUp() {
  dragging = false;
}

function update() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!dragging) {
    ball.dy += ball.gravity;
    ball.x += ball.dx;
    ball.y += ball.dy;
    ball.dx *= 0.99;
    ball.dy *= 0.99;
    if (ball.y + ball.radius > canvas.height) {
      ball.y = canvas.height - ball.radius;
      ball.dy *= -ball.bounce;
    }
    if (ball.y - ball.radius < 0) {
      ball.y = ball.radius;
      ball.dy *= -ball.bounce;
    }
    if (ball.x + ball.radius > canvas.width) {
      ball.x = canvas.width - ball.radius;
      ball.dx *= -ball.bounce;
    }
    if (ball.x - ball.radius < 0) {
      ball.x = ball.radius;
      ball.dx *= -ball.bounce;
    }
  }
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  ctx.fillStyle = dragging ? "orange" : "lime";
  ctx.fill();
  ctx.closePath();
  animId = requestAnimationFrame(update);
}

function showSim() {
  canvas.style.display = "block";
  toggleBtn.innerText = "✕";
  toggleBtn.title = "Close Sim";
  resetSimVars();
  addSimListeners();
  update();
}

function hideSim() {
  canvas.style.display = "none";
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

// Hide sim on load
hideSim();
