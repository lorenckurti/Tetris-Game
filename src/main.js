import * as BABYLON from '@babylonjs/core';
import { Client } from "@colyseus/sdk";

let COLS = 10, ROWS = 20;
let CELL = 1.05;
let currentThemeKey = localStorage.getItem('tetris.theme') || null;
const COLORS_HEX = {
  I: '#1DD1E8', O: '#F5C842', T: '#B44FD4',
  S: '#3DD65C', Z: '#E84040', J: '#3B82F6', L: '#F5813A'
};
const GARBAGE_COLOR = '#9AA1AD';
const PIECES = {
  I: [[0,0,0,0],
      [1,1,1,1],
      [0,0,0,0],
      [0,0,0,0]],
  O: [[1,1],
      [1,1]],
  T: [[0,1,0],
      [1,1,1],
      [0,0,0]],
  S: [[0,1,1],
      [1,1,0],
      [0,0,0]],
  Z: [[1,1,0],
      [0,1,1],
      [0,0,0]],
  J: [[1,0,0],
      [1,1,1],
      [0,0,0]],
  L: [[0,0,1],
      [1,1,1],
      [0,0,0]]
};

let engine, scene, camera;
let boardMeshes = [], pieceMeshes = [], ghostMeshes = [], stageMeshes = [];
let board, piece, nextPiece, score, lines, level, gameOver, paused, dropInterval;
let garbageSent = 0;
let lastDrop = 0;
let running = false;
let materials = {};
let dynamicMaterials = {};
function getStored(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null || v === undefined ? fallback : v;
  } catch (_) { return fallback; }
}
function setStored(key, value) {
  try { window.localStorage.setItem(key, value); } catch (_) {}
}
let speedSetting = Math.min(5, Math.max(1, parseInt(getStored('tetris.speed', '3'), 10) || 3));
let showGhost = getStored('tetris.ghost', '1') !== '0';
let blockStyle = getStored('tetris.blockStyle', '3d');
let soundOn = getStored('tetris.sound', '1') !== '0';
let musicOn = getStored('tetris.music', '0') === '1';
let audioCtx = null, musicTimer = null, musicStep = 0;
let finalCircle = false;
let musicTempoMs = 260;
function baseDropInterval(lvl) {
  const s = Math.min(5, Math.max(1, speedSetting || 3));
  return Math.max(80, Math.floor((1000 - (lvl - 1) * 90) * (3 / s)));
}
function ensureAudio() {
  if (!soundOn && !musicOn) return null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (_) { return null; }
}
function beep(freq, durMs, type, vol, delayMs) {
  if (!soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const t = ctx.currentTime + (delayMs || 0) / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol || 0.03, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (durMs || 80) / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (durMs || 80) / 1000 + 0.02);
  } catch (_) {}
}
function sfx(name) {
  if (!soundOn) return;
  if (name === 'move') beep(220, 40, 'square', 0.02);
  else if (name === 'rotate') beep(330, 50, 'square', 0.025);
  else if (name === 'lock') beep(140, 70, 'triangle', 0.04);
  else if (name === 'clear') { beep(523, 90, 'square', 0.035); beep(784, 120, 'square', 0.035, 90); }
  else if (name === 'level') { beep(392, 90, 'square', 0.035); beep(523, 90, 'square', 0.035, 90); beep(659, 140, 'square', 0.035, 180); }
  else if (name === 'over') { beep(330, 150, 'sawtooth', 0.04); beep(220, 200, 'sawtooth', 0.04, 150); beep(140, 300, 'sawtooth', 0.04, 300); }
}
function startMusic() {
  stopMusic();
  if (!musicOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const bass = [110, 110, 130.81, 98];
  musicStep = 0;
  musicTimer = setInterval(() => {
    if (!musicOn) { stopMusic(); return; }
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = bass[musicStep % bass.length];
      gain.gain.setValueAtTime(0.025, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    } catch (_) {}
    musicStep++;
  }, musicTempoMs);
}
function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}

function setFinalCircle(on) {
  if (on === finalCircle) return;
  finalCircle = on;
  musicTempoMs = on ? 165 : 260;
  try {
    if (document.body && document.body.classList) {
      document.body.classList.toggle('final-circle', on);
    }
  } catch (_) {}
  if (musicOn && audioCtx && musicTimer) startMusic();
}

function hexToColor3(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return new BABYLON.Color3(r,g,b);
}

function hexToColor4(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return new BABYLON.Color4(r,g,b, alpha !== undefined ? alpha : 1);
}

function lighten(hex, amount) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const nr = Math.min(255, Math.round(r + (255 - r) * amount));
  const ng = Math.min(255, Math.round(g + (255 - g) * amount));
  const nb = Math.min(255, Math.round(b + (255 - b) * amount));
  return '#' + nr.toString(16).padStart(2,'0') + ng.toString(16).padStart(2,'0') + nb.toString(16).padStart(2,'0');
}

function darken(hex, amount) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const nr = Math.max(0, Math.round(r * (1 - amount)));
  const ng = Math.max(0, Math.round(g * (1 - amount)));
  const nb = Math.max(0, Math.round(b * (1 - amount)));
  return '#' + nr.toString(16).padStart(2,'0') + ng.toString(16).padStart(2,'0') + nb.toString(16).padStart(2,'0');
}

function getFaceColors(hex) {
  const top = lighten(hex, 0.45);
  const bottom = darken(hex, 0.6);
  const front = hex;
  const back = darken(hex, 0.2);
  const right = lighten(hex, 0.15);
  const left = darken(hex, 0.15);
  return {
    top: hexToColor4(top),
    bottom: hexToColor4(bottom),
    front: hexToColor4(front),
    back: hexToColor4(back),
    right: hexToColor4(right),
    left: hexToColor4(left)
  };
}

function initBabylon() {
  const canvas = document.getElementById('renderCanvas') || document.getElementById('tetris-canvas') || document.querySelector('canvas');
  if (!canvas) return;
  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.08, 1);

  // Camera
  const cx = (COLS * CELL) / 2 - CELL/2;
  const cy = -(ROWS * CELL) / 2 + CELL/2;
  // Front-facing view: camera sits on +Z in front of the board with a slight
  // downward tilt so cube fronts read clearly with a hint of tops.
  camera = new BABYLON.ArcRotateCamera("cam", Math.PI/2, Math.PI/2 - 0.18, 28, new BABYLON.Vector3(cx, cy, 0), scene);
  camera.lowerRadiusLimit = 28;
  camera.upperRadiusLimit = 28;
  camera.lowerBetaLimit = 0.35;
  camera.upperBetaLimit = Math.PI - 0.35;
  camera.panningSensibility = 0;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");

  // Lighting - dramatic, polished setup
  const ambient = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0,1,0), scene);
  ambient.intensity = 0.65;
  ambient.diffuse = new BABYLON.Color3(0.9, 0.92, 0.95);
  ambient.groundColor = new BABYLON.Color3(0.15, 0.18, 0.25);

  const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-0.4,-0.5,1), scene);
  dir.intensity = 1.2;
  dir.diffuse = new BABYLON.Color3(1, 0.97, 0.92);
  dir.specular = new BABYLON.Color3(0.5, 0.5, 0.6);

  const pt = new BABYLON.PointLight("pt", new BABYLON.Vector3(cx, cy, -8), scene);
  pt.intensity = 0.5;
  pt.diffuse = new BABYLON.Color3(0.7, 0.9, 1);

  const fill = new BABYLON.PointLight("fill", new BABYLON.Vector3(cx + 5, -ROWS * CELL / 2 + 3, 8), scene);
  fill.intensity = 0.4;
  fill.diffuse = new BABYLON.Color3(0.4, 0.6, 1);

  const rim = new BABYLON.PointLight("rim", new BABYLON.Vector3(cx, cy + ROWS * CELL / 2, -6), scene);
  rim.intensity = 0.35;
  rim.diffuse = new BABYLON.Color3(0.5, 0.7, 1);

  // Pre-build materials for polished blocks
  Object.entries(COLORS_HEX).forEach(([k,hex]) => {
    const col = hexToColor3(hex);
    const mat = new BABYLON.StandardMaterial("mat_"+k, scene);
    mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
    mat.diffuseIntensity = 1.4;
    mat.specularColor = new BABYLON.Color3(1, 1, 1);
    mat.specularPower = 64;
    mat.specularIntensity = 1.0;
    mat.emissiveColor = col.scale(0.06);
    materials[k] = mat;
  });

  // Ghost material (transparent)
  const ghostMat = new BABYLON.StandardMaterial("ghost", scene);
  ghostMat.diffuseColor = new BABYLON.Color3(1,1,1);
  ghostMat.alpha = 0.15;
  ghostMat.wireframe = false;
  ghostMat.specularColor = new BABYLON.Color3(1,1,1);
  ghostMat.specularPower = 64;
  ghostMat.diffuseIntensity = 1.2;
  ghostMat.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.8);
  materials['ghost'] = ghostMat;

  // Grid floor / border lines
  drawBorder();
  fitCamera();

  engine.runRenderLoop(() => {
    if (running && !paused && !gameOver) {
      const now = performance.now();
      if (now - lastDrop > dropInterval) { moveDown(); lastDrop = now; }
    }
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => engine.resize()).observe(canvas.parentElement || canvas);
  }
}

function drawBorder() {
  clearMeshes(stageMeshes);
  const w = COLS * CELL, h = ROWS * CELL;
  const cx = w/2 - CELL/2, cy = -h/2 + CELL/2;

  // Atmospheric floor for depth
  const floorMat = new BABYLON.StandardMaterial("floorMat", scene);
  floorMat.diffuseColor = new BABYLON.Color3(0.03, 0.04, 0.07);
  floorMat.specularColor = new BABYLON.Color3(0.08, 0.1, 0.15);
  const floor = BABYLON.MeshBuilder.CreateGround("floor", {width: w + 6, height: h + 6}, scene);
  floor.position = new BABYLON.Vector3(cx, cy, -0.5);
  floor.material = floorMat;
  floor.infiniteDistance = true;
  stageMeshes.push(floor);

  // Subtle inner grid lines
  const gridLines = [];
  for (let c = 0; c <= COLS; c++) {
    const x = (c - COLS/2) * CELL;
    gridLines.push(new BABYLON.Vector3(x, CELL/2, 0.005), new BABYLON.Vector3(x, -h + CELL/2, 0.005));
  }
  for (let r = 0; r <= ROWS; r++) {
    const y = -r * CELL + CELL/2;
    gridLines.push(new BABYLON.Vector3(-CELL/2, y, 0.005), new BABYLON.Vector3(w - CELL/2, y, 0.005));
  }
  // Remove border duplicates
  const gridMesh = BABYLON.MeshBuilder.CreateLines("grid", {points: gridLines}, scene);
  gridMesh.color = new BABYLON.Color3(0.08, 0.12, 0.18);
  gridMesh.alpha = 0.5;
  gridMesh.infiniteDistance = true;
  stageMeshes.push(gridMesh);

  // Glowing border lines
  const lines = [
    [new BABYLON.Vector3(-CELL/2, CELL/2, 0.01), new BABYLON.Vector3(w-CELL/2, CELL/2, 0.01)],
    [new BABYLON.Vector3(-CELL/2, -h+CELL/2, 0.01), new BABYLON.Vector3(w-CELL/2, -h+CELL/2, 0.01)],
    [new BABYLON.Vector3(-CELL/2, CELL/2, 0.01), new BABYLON.Vector3(-CELL/2, -h+CELL/2, 0.01)],
    [new BABYLON.Vector3(w-CELL/2, CELL/2, 0.01), new BABYLON.Vector3(w-CELL/2, -h+CELL/2, 0.01)],
  ];
  lines.forEach((pts, i) => {
    const ls = BABYLON.MeshBuilder.CreateLines("border"+i, {points: pts}, scene);
    ls.color = new BABYLON.Color3(0.25, 0.45, 0.7);
    ls.alpha = 0.9;
    stageMeshes.push(ls);
  });
}

function fitCamera() {
  if (!camera || !scene) return;
  const w = COLS * CELL, h = ROWS * CELL;
  const need = Math.max(28, h * 1.35, w * 2.4);
  camera.radius = need;
  camera.lowerRadiusLimit = need;
  camera.upperRadiusLimit = need;
  camera.target = new BABYLON.Vector3(w / 2 - CELL / 2, -h / 2 + CELL / 2, 0);
}

function rebuildStage() {
  if (!scene) return;
  drawBorder();
  fitCamera();
  if (typeof board !== 'undefined' && board) {
    board = emptyBoard();
    redrawBoard();
    if (piece) {
      piece.x = Math.max(0, Math.min(piece.x, COLS - piece.shape[0].length));
      piece.y = Math.max(0, piece.y);
      if (!valid(piece.shape, piece.x, piece.y)) {
        piece.x = Math.floor(COLS / 2) - Math.floor(piece.shape[0].length / 2);
        piece.y = 0;
      }
      redrawPiece();
    }
  }
}

function meshPos(col, row) {
  return new BABYLON.Vector3(col * CELL, -row * CELL, 0);
}

function makeCube(col, row, matKey, alpha, hexColor) {
   const size = CELL * 0.88;
   const faceColors = hexColor ? getFaceColors(hexColor) : null;
   const box = BABYLON.MeshBuilder.CreateBox("b", {
     size,
     faceColors: faceColors ? [faceColors.right, faceColors.left, faceColors.top, faceColors.bottom, faceColors.front, faceColors.back] : undefined
   }, scene);
   box.position = meshPos(col, row);

   if (alpha !== undefined && alpha < 1) {
     box.material = materials['ghost'];
     box.visibility = 1;
   } else if (hexColor) {
     const colorKey = Object.entries(COLORS_HEX).find(([k,h]) => h === hexColor);
     const matKey = colorKey ? colorKey[0] : null;
     if (matKey && materials[matKey]) {
       box.material = materials[matKey];
     }
   }
   return box;
}

function clearMeshes(arr) {
  arr.forEach(m => m && m.dispose());
  arr.length = 0;
}

function redrawBoard() {
   clearMeshes(boardMeshes);
   for (let r = 0; r < ROWS; r++) {
     for (let c = 0; c < COLS; c++) {
       if (board[r][c]) {
         const m = makeCube(c, r, null, 1, board[r][c]);
         boardMeshes.push(m);
       }
     }
   }
}

function getMaterialByColor(hex) {
  for (const [k,h] of Object.entries(COLORS_HEX)) if (h === hex) return materials[k];
  if (dynamicMaterials[hex]) return dynamicMaterials[hex];
  const col = hexToColor3(hex);
  const mat = new BABYLON.StandardMaterial("dyn", scene);
  mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
  mat.diffuseIntensity = 1.4;
  mat.specularColor = new BABYLON.Color3(1, 1, 1);
  mat.specularPower = 64;
  mat.specularIntensity = 1.0;
  mat.emissiveColor = col.scale(0.06);
  dynamicMaterials[hex] = mat;
  return mat;
}

function redrawPiece() {
  clearMeshes(pieceMeshes);
  clearMeshes(ghostMeshes);
  if (!piece) return;

  // ghost
  const gy = ghostRow();
  if (showGhost && gy !== piece.y) {
    for (let r = 0; r < piece.shape.length; r++)
      for (let c = 0; c < piece.shape[r].length; c++)
        if (piece.shape[r][c]) {
          const m = makeCube(piece.x+c, gy+r, 'ghost', 0.13);
          ghostMeshes.push(m);
        }
  }

  // active piece
  for (let r = 0; r < piece.shape.length; r++)
    for (let c = 0; c < piece.shape[r].length; c++)
      if (piece.shape[r][c]) {
        const m = makeCube(piece.x+c, piece.y+r, null, 1, piece.color);
        pieceMeshes.push(m);
      }
}

//  Games Logic 
function emptyBoard() { return Array.from({length:ROWS}, ()=>Array(COLS).fill(0)); }

function randomPiece() {
  const keys = Object.keys(PIECES);
  const k = keys[Math.floor(Math.random()*keys.length)];
  const shape = PIECES[k].map(r=>[...r]);
  return { shape, color: COLORS_HEX[k], x: Math.floor(COLS/2)-Math.floor(shape[0].length/2), y: 0 };
}

function rotate(shape) {
  const N=shape.length, M=shape[0].length;
  const out = Array.from({length:M},()=>Array(N).fill(0));
  for(let r=0;r<N;r++) for(let c=0;c<M;c++) out[c][N-1-r]=shape[r][c];
  return out;
}

function valid(s, px, py) {
  for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++) {
    if(!s[r][c]) continue;
    const nx=px+c, ny=py+r;
    if(nx<0||nx>=COLS||ny>=ROWS) return false;
    if(ny>=0 && board[ny][nx]) return false;
  }
  return true;
}

function ghostRow() {
  let gy = piece.y;
  while(valid(piece.shape, piece.x, gy+1)) gy++;
  return gy;
}

function applyGarbage(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (!board || !running || gameOver) return;
  const incoming = rows
    .filter((row) => Array.isArray(row) && row.length === COLS && row.every((cell) => cell === 0 || cell === 1))
    .map((row) => {
      const normalized = [];
      for (let c = 0; c < COLS; c++) {
        normalized.push(row[c] ? GARBAGE_COLOR : 0);
      }
      return normalized;
    });
  if (incoming.length === 0) return;

  let toppedOut = false;
  for (const garbageRow of incoming) {
    const discarded = board.shift();
    if (discarded && discarded.some((cell) => cell)) toppedOut = true;
    board.push(garbageRow);
  }
  if (piece) {
    piece.y = Math.max(0, piece.y - incoming.length);
  }
  redrawBoard();
  if (toppedOut || (piece && !valid(piece.shape, piece.x, piece.y))) {
    endGame();
    return;
  }
  redrawPiece();
  const statusEl = document.getElementById('status');
  if (statusEl && !paused) statusEl.textContent = `⚠ +${incoming.length} garbage line${incoming.length > 1 ? 's' : ''}!`;
}

function lock() {
  for(let r=0;r<piece.shape.length;r++) for(let c=0;c<piece.shape[r].length;c++)
    if(piece.shape[r][c]) board[piece.y+r][piece.x+c] = piece.color;

  // clear lines
  let cleared = 0;
  for(let r=ROWS-1;r>=0;r--) {
    if(board[r].every(c=>c)) { board.splice(r,1); board.unshift(Array(COLS).fill(0)); cleared++; r++; }
  }
  const pts=[0,100,300,500,800];
  const clearMultiplier = cleared === 2 ? 2 : 1;
  score += (pts[cleared]||0)*level*clearMultiplier;
  lines += cleared;
  const oldLevel = level;
  level = Math.floor(lines/10)+1;
  dropInterval = baseDropInterval(level);
  if (cleared > 0) sfx('clear');
  else sfx('lock');
  if (level > oldLevel) sfx('level');
  updateUI();
  sendScoreUpdate();
  sendAttack(cleared);
  redrawBoard();

  piece = nextPiece;
  nextPiece = randomPiece();
  if(!valid(piece.shape,piece.x,piece.y)) { endGame(); return; }
  drawNext();
  redrawPiece();
}

function moveDown() {
  if(valid(piece.shape,piece.x,piece.y+1)) { piece.y++; redrawPiece(); }
  else lock();
}

function startGame() {
  if (isMultiplayer && !multiplayerRoundActive) {
    showLobbyPanel();
    renderLobby();
    return;
  }
  const ovEl = document.getElementById('overlay'); if (ovEl) ovEl.style.display = 'none';
  const savedCols = parseInt(getStored('tetris.cols', '10'), 10);
  if ([8, 10, 12].includes(savedCols) && savedCols !== COLS) {
    COLS = savedCols;
    CELL = savedCols <= 8 ? 1.2 : savedCols >= 12 ? 0.9 : 1.05;
  }
  if (isMultiplayer) {
    COLS = 10;
    CELL = 1.05;
  }
  if (!engine) initBabylon();
  else rebuildStage();
  clearMeshes(boardMeshes); clearMeshes(pieceMeshes); clearMeshes(ghostMeshes);
  board = emptyBoard();
  score = 0; lines = 0; level = 1; garbageSent = 0; gameOver = false; paused = false;
  if (currentThemeKey) applyTheme(currentThemeKey);
  applyBlockStyle(blockStyle);
  dropInterval = baseDropInterval(1); lastDrop = performance.now();
  piece = randomPiece(); nextPiece = randomPiece();
  running = true;
  ensureAudio();
  if (musicOn) startMusic(); else stopMusic();
  updateUI(); drawNext(); redrawBoard(); redrawPiece();
  const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'good luck!';
  const startBtn = document.getElementById('startBtn2') || document.getElementById('start-button'); if (startBtn) startBtn.textContent = 'RESTART';
}
window.startGame = startGame;

function endGame() {
  if (!gameOver) notifyDead();
  gameOver = true; running = false;
  stopMusic();
  sfx('over');
  updateSpectatorView();
  if (isMultiplayer && multiplayerRoundActive) {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Waiting for final results...';
    return;
  }
  const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'game over — score: '+score;
  showGameOverScreen();
}

const PERSONAL_BEST_KEY = 'tetris.personalBest';
const PERSONAL_BEST_LEVEL_KEY = 'tetris.personalBestLevel';
const PERSONAL_BEST_LINES_KEY = 'tetris.personalBestLines';

function readInt(key) {
  try {
    return Number.parseInt(window.localStorage.getItem(key) || '0', 10) || 0;
  } catch (_) { return 0; }
}

function updatePersonalBest(finalScore, finalLevel, finalLines) {
  const previousBest = readInt(PERSONAL_BEST_KEY);
  const previousLevel = readInt(PERSONAL_BEST_LEVEL_KEY);
  const previousLines = readInt(PERSONAL_BEST_LINES_KEY);

  const best = Math.max(previousBest, finalScore);
  const bestLevel = Math.max(previousLevel, finalLevel || 0);
  const bestLines = Math.max(previousLines, finalLines || 0);
  const isNewRecord = finalScore > previousBest;
  if (finalScore > previousBest) setStored(PERSONAL_BEST_KEY, String(best));
  if ((finalLevel || 0) > previousLevel) setStored(PERSONAL_BEST_LEVEL_KEY, String(bestLevel));
  if ((finalLines || 0) > previousLines) setStored(PERSONAL_BEST_LINES_KEY, String(bestLines));

  const homeScore = document.getElementById('home-score-value');
  if (homeScore) homeScore.textContent = best;
  return { best, bestLevel, bestLines, isNewRecord };
}

function ordinal(n) {
  const suffixes = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function myPlacement(leaderboard) {
  if (!Array.isArray(leaderboard) || leaderboard.length === 0) return 0;
  const byId = leaderboard.findIndex((e) => e && e.id && e.id === mySessionId);
  if (byId >= 0) return byId + 1;
  return leaderboard.filter((e) => e && e.score > score).length + 1;
}

function showGameOverScreen({ isWinner = false, winnerName = '', leaderboard = [] } = {}) {
  const { best, isNewRecord } = updatePersonalBest(score, level, lines);
  const rankLabels = ['1ST', '2ND', '3RD', '4TH'];
  const rankings = leaderboard.map((entry, index) => {
    const winner = index === 0;
    return `<li class="game-over-rank${winner ? ' game-over-rank-winner' : ''}">
      <span class="game-over-rank-position">${winner ? '♛ 1ST' : (rankLabels[index] || `${index + 1}TH`)}</span>
      <span class="game-over-rank-name">${escapeHtml(entry.name)}</span>
      <span class="game-over-rank-score">${entry.score}</span>
    </li>`;
  }).join('');
  const multiplayerResults = leaderboard.length
    ? `<section class="game-over-leaderboard"><div class="game-over-section-title">FINAL STANDINGS</div><ol>${rankings}</ol></section>`
    : '';
  const statsGrid = (placement) => `
    <div class="game-over-stats">
      <div><span>PLACEMENT</span><strong>${placement}</strong></div>
      <div><span>LINES CLEARED</span><strong>${lines}</strong></div>
      <div><span>LEVEL REACHED</span><strong>${level}</strong></div>
      <div><span>GARBAGE SENT</span><strong>${garbageSent}</strong></div>
    </div>`;
  const actions = `
    <div class="game-over-actions">
      <button class="game-over-play" onclick="playAgain()">PLAY AGAIN</button>
      <button class="game-over-menu" onclick="returnToDashboard()">MAIN MENU</button>
    </div>`;
  const bestBox = `
    <div class="game-over-best ${isNewRecord ? 'game-over-new-record' : ''}">
      <span>${isNewRecord ? '★ NEW PERSONAL BEST' : 'PERSONAL BEST'}</span><strong>${best}</strong>
    </div>`;
  const ov = document.getElementById('overlay');
  if (!ov) return;

  if (leaderboard.length) {
    if (isWinner) {
      ov.innerHTML = `<section class="game-over-card game-over-card-winner" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
        <div class="game-over-eyebrow">👑 CHAMPION OF THE ROUND</div>
        <h2 id="game-over-title">♛ VICTORY ROYALE</h2>
        <div class="game-over-score"><span>FINAL SCORE</span><strong>${score}</strong></div>
        ${bestBox}
        ${statsGrid('1ST')}
        ${multiplayerResults}
        ${actions}
      </section>`;
    } else {
      const place = ordinal(Math.max(1, myPlacement(leaderboard)));
      ov.innerHTML = `<section class="game-over-card" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
        <div class="game-over-eyebrow">ROUND COMPLETE</div>
        <h2 id="game-over-title">ELIMINATED — YOU PLACED ${place}</h2>
        <p class="game-over-result">👑 ${escapeHtml(winnerName || 'Someone')} takes the crown</p>
        <div class="game-over-score"><span>FINAL SCORE</span><strong>${score}</strong></div>
        ${bestBox}
        ${statsGrid(place)}
        ${multiplayerResults}
        ${actions}
      </section>`;
    }
    ov.classList.add('active');
    ov.style.display = 'flex';
    return;
  }

  const title = 'GAME OVER';
  ov.innerHTML = `<section class="game-over-card" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
    <div class="game-over-eyebrow">ROUND COMPLETE</div>
    <h2 id="game-over-title">${title}</h2>
    <div class="game-over-score"><span>FINAL SCORE</span><strong>${score}</strong></div>
    ${bestBox}
    <div class="game-over-stats">
      <div><span>LINES</span><strong>${lines}</strong></div>
      <div><span>LEVEL</span><strong>${level}</strong></div>
    </div>
    ${actions}
  </section>`;
  ov.classList.add('active');
  ov.style.display = 'flex';
}

function playAgain() {
   const overlay = document.getElementById('overlay');
   if (overlay) overlay.style.display = 'none';

   if (isMultiplayer) {
     showLobbyPanel();
     if (room) room.send('player_ready', { ready: true });
     renderLobby();
     return;
   }

   showGameScreen();
   startGame();
}
window.playAgain = playAgain;

function updateUI() {
  const sv = document.getElementById('scoreVal') || document.getElementById('score-val'); if (sv) sv.textContent = score;
  const lv = document.getElementById('levelVal') || document.getElementById('level-val'); if (lv) lv.textContent = level;
  const ln = document.getElementById('linesVal') || document.getElementById('lines-val'); if (ln) ln.textContent = lines;
}

function drawNext() {
  const cv = document.getElementById('nextCanvas') || document.getElementById('next-piece-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const S = 18;
  ctx.clearRect(0,0,90,90);
  const s = nextPiece.shape;
  const ox = Math.floor((4-s[0].length)/2)*S + 9;
  const oy = Math.floor((4-s.length)/2)*S + 9;
  for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++) {
    if(s[r][c]) {
      ctx.fillStyle = nextPiece.color;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(ox+c*S+1, oy+r*S+1, S-2, S-2, 3);
        ctx.fill();
      } else {
        ctx.fillRect(ox+c*S+1, oy+r*S+1, S-2, S-2);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(ox+c*S+2, oy+r*S+2, S-4, 4);
    }
  }
}

document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && t.closest) {
    if (t.closest('input, select, textarea')) return;
    if ((e.key === ' ' || e.key === 'Enter') && t.closest('button')) return;
  }
  if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp',' '].includes(e.key)) e.preventDefault();
  if (!running || !piece) return;
  if (e.key==='p'||e.key==='P') {
    paused = !paused;
    const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = paused ? 'paused' : 'good luck!';
    if (!paused) lastDrop = performance.now();
    return;
  }
  if (paused || gameOver) return;
  if (e.key==='ArrowLeft') { if(valid(piece.shape,piece.x-1,piece.y)){piece.x--;redrawPiece(); sendPlayerAction('left'); sfx('move');} }
  else if (e.key==='ArrowRight') { if(valid(piece.shape,piece.x+1,piece.y)){piece.x++;redrawPiece(); sendPlayerAction('right'); sfx('move');} }
  else if (e.key==='ArrowDown') { moveDown(); lastDrop=performance.now(); sendPlayerAction('down'); }
  else if (e.key==='ArrowUp') { const r=rotate(piece.shape); if(valid(r,piece.x,piece.y)){piece.shape=r;redrawPiece(); sendPlayerAction('rotate'); sfx('rotate');} }
  else if (e.key===' ') { while(valid(piece.shape,piece.x,piece.y+1)) piece.y++; lock(); redrawPiece(); lastDrop = performance.now(); sendPlayerAction('drop'); }
});

function showHomeDashboard() {
  stopMusic();
  const best = updatePersonalBest(0, 0, 0).best;
  const homeScore = document.getElementById('home-score-value');
  if (homeScore) homeScore.textContent = best;
  const sidebar = document.getElementById('home-sidebar');
  const gameArea = document.getElementById('game-area');
  const sidePanel = document.getElementById('side-panel');
  const multiplayerPanel = document.getElementById('multiplayer-panel');
  if (sidebar) sidebar.style.display = 'flex';
  if (gameArea) { gameArea.classList.remove('game-stage-visible'); gameArea.style.display = 'none'; }
  if (sidePanel) { sidePanel.classList.remove('game-stage-visible'); sidePanel.style.display = 'none'; }
  if (multiplayerPanel) multiplayerPanel.style.display = 'none';
  const aliveHud = document.getElementById('alive-hud');
  if (aliveHud) aliveHud.style.display = 'none';
  setFinalCircle(false);
  updateSpectatorView();
}

function returnToDashboard() {
   const overlay = document.getElementById('overlay');
   if (overlay) overlay.style.display = 'none';
   showHomeDashboard();
}
window.returnToDashboard = returnToDashboard;

function showGameScreen() {
   const sidebar = document.getElementById('home-sidebar');
   const gameArea = document.getElementById('game-area');
   const sidePanel = document.getElementById('side-panel');
   const multiplayerPanel = document.getElementById('multiplayer-panel');
   if (sidebar) sidebar.style.display = 'none';
   if (gameArea) {
     gameArea.classList.add('game-stage-visible');
     gameArea.style.display = 'flex';
   }
   if (sidePanel) {
     sidePanel.classList.add('game-stage-visible');
     sidePanel.style.display = 'flex';
   }
   if (multiplayerPanel) multiplayerPanel.style.display = 'none';
   const aliveHud = document.getElementById('alive-hud');
   if (aliveHud) aliveHud.style.display = 'none';
   setFinalCircle(false);
   updateSpectatorView();
}

document.addEventListener('DOMContentLoaded', () => {
  const homeMenu = document.getElementById('home-menu');
  const menuButtons = homeMenu ? homeMenu.querySelectorAll('.menu-item') : [];

  menuButtons.forEach((btn) => {
    btn.addEventListener('mouseenter', () => {
      btn.classList.add('active');
    });
    btn.addEventListener('mouseleave', () => {
      btn.classList.remove('active');
    });
  });

const showMultiplayerScreen = () => {
    const sidebar = document.getElementById('home-sidebar');
    const gameArea = document.getElementById('game-area');
    const sidePanel = document.getElementById('side-panel');
    const multiplayerPanel = document.getElementById('multiplayer-panel');
    if (sidebar) sidebar.style.display = 'none';
    if (gameArea) {
      gameArea.classList.remove('game-stage-visible');
      gameArea.style.display = 'none';
    }
    if (sidePanel) {
      sidePanel.classList.remove('game-stage-visible');
      sidePanel.style.display = 'none';
    }
    if (multiplayerPanel) multiplayerPanel.style.display = 'flex';
  };

  const dropInBtn = document.getElementById('drop-in-home-btn');
  if (dropInBtn) {
    dropInBtn.addEventListener('click', () => {
      showGameScreen();
      startGame();
    });
  }

  const createRoomHomeBtn = document.getElementById('create-room-home-btn');
  if (createRoomHomeBtn) {
    createRoomHomeBtn.addEventListener('click', () => {
      showMultiplayerScreen();
      showMpSetup('create');
    });
  }

  const joinRoomHomeBtn = document.getElementById('join-room-home-btn');
  if (joinRoomHomeBtn) {
    joinRoomHomeBtn.addEventListener('click', () => {
      showMultiplayerScreen();
      showMpSetup('join');
    });
  }

const backBtn = document.getElementById('multiplayer-back-btn');
   if (backBtn) {
     backBtn.addEventListener('click', () => {
       leaveMultiplayer();
       showHomeDashboard();
     });
   }

   const readyBtn = document.getElementById('ready-btn');
   if (readyBtn) {
     readyBtn.addEventListener('click', () => {
       if (!room) return;
       let myReadyNow = false;
       try {
         const me = room.state.players.get(mySessionId);
         myReadyNow = !!(me && me.isReady);
       } catch (_) {}
       room.send('player_ready', { ready: !myReadyNow });
     });
   }

   const startBtn = document.getElementById('start-btn');
   if (startBtn) {
     startBtn.addEventListener('click', () => {
       if (!room) return;
       room.send('start_game', {});
     });
   }

   const startMsg = document.getElementById('Start-msg');
   if (startMsg) startMsg.addEventListener('click', startGame);

const customizeBtn = document.getElementById('customize-home-btn');
   if (customizeBtn) customizeBtn.addEventListener('click', () => showCustomize());

   const howToPlayBtn = document.getElementById('how-to-play-home-btn');
   if (howToPlayBtn) howToPlayBtn.addEventListener('click', () => showHowToPlay());

   const recordsBtn = document.getElementById('records-home-btn');
   if (recordsBtn) recordsBtn.addEventListener('click', () => showRecords());

   const settingsBtn = document.getElementById('settings-home-btn');
   if (settingsBtn) settingsBtn.addEventListener('click', () => showSettings());

   const creditsBtn = document.getElementById('credits-home-btn');
   if (creditsBtn) creditsBtn.addEventListener('click', () => {
     const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Credits coming soon';
  });

  const overlay = document.getElementById('overlay'); if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.classList.remove('active'); overlay.style.display = 'none'; } });

  const params = getUrlParams();
  const inviteCode = normalizeRoomCode(params.get('code') || params.get('room') || params.get('roomId'));
  const playerName = params.get('name') || params.get('player');
  if (inviteCode) {
    showMultiplayerScreen();
    showMpSetup('join', inviteCode);
  } else if (playerName) {
    showMultiplayerScreen();
    showMpSetup('join');
  }
});



function showLeaderboard() {
  const entries = latestLeaderboard.length ? latestLeaderboard : Array.from((room?.state?.leaderboard) || []);
  let html = '<div class="overlay-content"><h3 style="color:#5bbfff;margin:0 0 12px 0">🏆 LEADERBOARD</h3>';
  if (entries.length === 0) {
    html += '<p style="color:#cfe9ff;margin-bottom:16px">No leaderboard entries yet.</p>';
  } else {
    html += '<table style="width:100%;color:#cfe9ff;border-collapse:collapse">';
    html += '<tr style="color:#88aacc"><th>#</th><th>Name</th><th>Score</th><th>Level</th></tr>';
    entries.forEach((entry, i) => {
      const color = i === 0 ? '#F5C842' : i === 1 ? '#aaa' : i === 2 ? '#cd7f32' : '#cfe9ff';
      html += `<tr style="color:${color}">
        <td style="padding:4px 8px">${i+1}</td>
        <td style="padding:4px 8px">${escapeHtml(entry.name)}</td>
        <td style="padding:4px 8px">${entry.score}</td>
        <td style="padding:4px 8px">${entry.level}</td>
      </tr>`;
    });
    html += '</table>';
  }
  html += '<button onclick="closeLeaderboard()" style="margin-top:12px;padding:6px 18px;border-radius:6px;border:0.5px solid #5bbfff;background:transparent;color:#5bbfff;cursor:pointer">CLOSE</button></div>';
  const ov = document.getElementById('overlay');
  if (ov) { ov.innerHTML = html; ov.classList.add('active'); ov.style.display = 'flex'; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function closeLeaderboard() {
  const ov = document.getElementById('overlay');
  if (ov) {
    ov.classList.remove('active');
    ov.style.display = 'none';
  }
}

window.showLeaderboard = showLeaderboard;
window.closeLeaderboard = closeLeaderboard;

function showOverlay(html) {
  const ov = document.getElementById('overlay');
  if (!ov) return;
  ov.innerHTML = html;
  ov.classList.add('active');
  ov.style.display = 'flex';
}
window.showOverlay = showOverlay;

function closeMenuOverlay() {
  const ov = document.getElementById('overlay');
  if (ov) { ov.classList.remove('active'); ov.style.display = 'none'; }
}
window.closeMenuOverlay = closeMenuOverlay;

function showEliminationToast(victimName, eliminatorName, durationMs) {
  const feed = document.getElementById('elim-feed');
  if (!feed) return;
  const safeVictim = escapeHtml(victimName || 'Someone');
  const toast = document.createElement('div');
  toast.className = 'elim-toast';
  toast.innerHTML = eliminatorName
    ? `<span class="elim-victim">${safeVictim}</span> eliminated by <span class="elim-killer">${escapeHtml(eliminatorName)}</span>!`
    : `<span class="elim-victim">${safeVictim}</span> was eliminated!`;
  while (feed.children.length >= 4 && feed.firstChild) {
    feed.removeChild(feed.firstChild);
  }
  feed.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode === feed) feed.removeChild(toast);
  }, typeof durationMs === 'number' ? durationMs : 3200);
}
window.showEliminationToast = showEliminationToast;

function showHowToPlay() {
  const html = `<div class="overlay-content">
    <div class="menu-card-title">How to Play</div>
    <div class="menu-card-info">
      <strong>Objective:</strong> Clear as many horizontal lines as possible by fitting falling Tetromino pieces together.
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Controls</div>
      <div class="menu-card-controls">
        <div class="menu-card-control-item"><span>Move Left</span><span class="val">&larr; Arrow</span></div>
        <div class="menu-card-control-item"><span>Move Right</span><span class="val">&rarr; Arrow</span></div>
        <div class="menu-card-control-item"><span>Soft Drop</span><span class="val">&darr; Arrow</span></div>
        <div class="menu-card-control-item"><span>Rotate</span><span class="val">&uarr; Arrow</span></div>
        <div class="menu-card-control-item"><span>Hard Drop</span><span class="val">Space</span></div>
        <div class="menu-card-control-item"><span>Pause</span><span class="val">P</span></div>
      </div>
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Rules</div>
      <div class="menu-card-info">
        &bull; Complete a full horizontal line to make it disappear<br>
        &bull; Clearing multiple lines at once earns more points<br>
        &bull; Level increases every <strong>10 lines</strong>, speeding up the drop<br>
        &bull; Pieces stack up to the top &rarr; <strong>GAME OVER</strong><br>
        &bull; Next piece preview helps you plan ahead<br>
        &bull; Ghost piece shows where the piece will land
      </div>
    </div>
    <div class="menu-card-actions">
      <button class="menu-card-btn menu-card-btn-secondary" onclick="closeMenuOverlay()">BACK</button>
    </div>
  </div>`;
  showOverlay(html);
}
window.showHowToPlay = showHowToPlay;

function showRecords() {
  const { best, bestLevel, bestLines } = updatePersonalBest(0, 0, 0);
  const recent = latestLeaderboard && latestLeaderboard.length ? latestLeaderboard.slice(0, 3) : [];
  const html = `<div class="overlay-content">
    <div class="menu-card-title">Records</div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Personal Best</div>
      <div class="menu-card-row">
        <span class="menu-card-row-label">Best Score</span>
        <span class="menu-card-row-value">${best}</span>
      </div>
      <div class="menu-card-row">
        <span class="menu-card-row-label">Best Level</span>
        <span class="menu-card-row-value">${bestLevel || '--'}</span>
      </div>
      <div class="menu-card-row">
        <span class="menu-card-row-label">Best Lines</span>
        <span class="menu-card-row-value">${bestLines || '--'}</span>
      </div>
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Latest Multiplayer Results</div>
      <div class="menu-card-controls">
        ${recent.length ? recent.map((entry, i) => `<div class="menu-card-control-item"><span>${i + 1}. ${escapeHtml(entry.name)}</span><span class="val">${entry.score}</span></div>`).join('') : '<div class="menu-card-control-item"><span>No multiplayer results yet</span><span class="val">--</span></div>'}
      </div>
    </div>
    <div class="menu-card-actions">
      <button class="menu-card-btn menu-card-btn-primary" onclick="showLeaderboard()">LEADERBOARD</button>
      <button class="menu-card-btn menu-card-btn-secondary" onclick="closeMenuOverlay()">BACK</button>
    </div>
  </div>`;
  showOverlay(html);
}
window.showRecords = showRecords;

const THEMES = {
  neon: { name: 'Neon', accent: '#5bbfff' },
  sunset: { name: 'Sunset', accent: '#f5813a' },
  emerald: { name: 'Emerald', accent: '#3dd65c' },
  midnight: { name: 'Midnight', accent: '#b44fd4' },
  arctic: { name: 'Arctic', accent: '#1dd1e8' },
};

function applyTheme(themeKey) {
  const theme = THEMES[themeKey];
  if (!theme) return;
  currentThemeKey = themeKey;
  const matKeys = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  matKeys.forEach(k => {
    const mat = materials[k];
    if (!mat) return;
    const col = hexToColor3(COLORS_HEX[k]);
    mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
    mat.diffuseIntensity = 1.4;
    mat.emissiveColor = col.scale(0.06);
    mat.specularColor = new BABYLON.Color3(1, 1, 1);
    mat.specularPower = 64;
    mat.specularIntensity = 1.0;
  });
  clearMeshes(boardMeshes);
  clearMeshes(pieceMeshes);
  clearMeshes(ghostMeshes);
}

function showCustomize() {
  const currentTheme = getStored('tetris.theme', 'neon');
  const currentSpeed = getStored('tetris.speed', '3');
  const currentCols = getStored('tetris.cols', '10');
  const html = `<div class="overlay-content">
    <div class="menu-card-title">Customize</div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Color Theme</div>
      <div class="menu-card-color-options">
        ${Object.entries(THEMES).map(([key, t]) =>
          `<button class="menu-card-color-btn${key === currentTheme ? ' active' : ''}" style="background:${t.accent}" data-theme="${key}" title="${t.name}"></button>`
        ).join('')}
      </div>
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Speed</div>
      <div class="menu-card-control-item">
        <span>Drop Speed</span>
        <input type="range" min="1" max="5" value="${currentSpeed}" id="speed-slider">
        <span class="val" id="speed-val">${currentSpeed}</span>
      </div>
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Board Size</div>
      <div class="menu-card-control-item">
        <span>Columns</span>
        <select id="cols-select">
          <option value="10"${currentCols === '10' ? ' selected' : ''}>10</option>
          <option value="8"${currentCols === '8' ? ' selected' : ''}>8</option>
          <option value="12"${currentCols === '12' ? ' selected' : ''}>12</option>
        </select>
      </div>
    </div>
    <div class="menu-card-actions">
      <button class="menu-card-btn menu-card-btn-primary" onclick="applyCustomize()">APPLY</button>
      <button class="menu-card-btn menu-card-btn-secondary" onclick="closeMenuOverlay()">CANCEL</button>
    </div>
  </div>`;
  showOverlay(html);

  document.querySelectorAll('.menu-card-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.menu-card-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  const slider = document.getElementById('speed-slider');
  const valSpan = document.getElementById('speed-val');
  if (slider && valSpan) {
    slider.addEventListener('input', () => { valSpan.textContent = slider.value; });
  }
}
window.showCustomize = showCustomize;

function applyCustomize() {
  const speedSlider = document.getElementById('speed-slider');
  const speedVal = document.getElementById('speed-val');
  const colsSelect = document.getElementById('cols-select');
  const activeTheme = document.querySelector('.menu-card-color-btn.active');

  if (speedSlider && speedVal) { speedVal.textContent = speedSlider.value; }

  if (activeTheme) {
    const themeKey = activeTheme.dataset.theme;
    applyTheme(themeKey);
    setStored('tetris.theme', themeKey);
  }

  if (colsSelect) {
    const cols = parseInt(colsSelect.value, 10);
    if (Number.isFinite(cols) && cols !== COLS) {
      COLS = cols;
      CELL = cols <= 8 ? 1.2 : cols >= 12 ? 0.9 : 1.05;
      rebuildStage();
    }
    setStored('tetris.cols', colsSelect.value);
  }

  const speed = Math.min(5, Math.max(1, parseInt(speedSlider ? speedSlider.value : 3, 10) || 3));
  speedSetting = speed;
  dropInterval = baseDropInterval(typeof level === 'number' && level > 0 ? level : 1);
  setStored('tetris.speed', String(speed));

  if (typeof board !== 'undefined' && board && scene) {
    redrawBoard();
    if (piece) redrawPiece();
  }

  closeMenuOverlay();
}
window.applyCustomize = applyCustomize;

function applyBlockStyle(style) {
  blockStyle = style || blockStyle || '3d';
  const preset = blockStyle === 'flat'
    ? { intensity: 1.0, specular: 0.15, power: 8, emissive: 0.0 }
    : blockStyle === 'rounded'
      ? { intensity: 1.25, specular: 0.6, power: 24, emissive: 0.04 }
      : { intensity: 1.4, specular: 1.0, power: 64, emissive: 0.06 };
  const all = [...Object.values(materials), ...Object.values(dynamicMaterials)];
  all.forEach((mat) => {
    if (!mat || mat === materials['ghost']) return;
    mat.diffuseIntensity = preset.intensity;
    mat.specularColor = new BABYLON.Color3(1, 1, 1);
    mat.specularPower = preset.power;
    mat.specularIntensity = preset.specular;
    Object.entries(COLORS_HEX).forEach(([k, hex]) => {
      if (mat === materials[k]) mat.emissiveColor = hexToColor3(hex).scale(preset.emissive);
    });
  });
  if (typeof board !== 'undefined' && board && scene) {
    redrawBoard();
    if (piece) redrawPiece();
  }
}

function showSettings() {
  const rotateStyle = getStored('tetris.rotate', 'instant');
  const html = `<div class="overlay-content">
    <div class="menu-card-title">Settings</div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Audio</div>
      <div class="menu-card-control-item">
        <span>Sound Effects</span>
        <label style="position:relative;display:inline-block;width:44px;height:22px;cursor:pointer">
          <input type="checkbox" ${soundOn ? 'checked' : ''} id="sound-toggle" style="opacity:0;width:0;height:0">
          <span style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(111,194,255,0.2);border-radius:22px;transition:0.3s"></span>
          <span style="position:absolute;top:2px;left:2px;width:18px;height:18px;background:#5bbfff;border-radius:50%;transition:0.3s"></span>
        </label>
      </div>
      <div class="menu-card-control-item">
        <span>Background Music</span>
        <label style="position:relative;display:inline-block;width:44px;height:22px;cursor:pointer">
          <input type="checkbox" ${musicOn ? 'checked' : ''} id="music-toggle" style="opacity:0;width:0;height:0">
          <span style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(111,194,255,0.2);border-radius:22px;transition:0.3s"></span>
          <span style="position:absolute;top:2px;left:2px;width:18px;height:18px;background:#5bbfff;border-radius:50%;transition:0.3s"></span>
        </label>
      </div>
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Controls</div>
      <div class="menu-card-control-item">
        <span>Rotation Style</span>
        <select id="rotate-style">
          <option value="smooth"${rotateStyle === 'smooth' ? ' selected' : ''}>Smooth</option>
          <option value="instant"${rotateStyle === 'instant' ? ' selected' : ''}>Instant</option>
          <option value="3step"${rotateStyle === '3step' ? ' selected' : ''}>3-Step</option>
        </select>
      </div>
      <div class="menu-card-control-item">
        <span>Ghost Preview</span>
        <label style="position:relative;display:inline-block;width:44px;height:22px;cursor:pointer">
          <input type="checkbox" ${showGhost ? 'checked' : ''} id="ghost-toggle" style="opacity:0;width:0;height:0">
          <span style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(111,194,255,0.2);border-radius:22px;transition:0.3s"></span>
          <span style="position:absolute;top:2px;left:2px;width:18px;height:18px;background:#5bbfff;border-radius:50%;transition:0.3s"></span>
        </label>
      </div>
    </div>
    <div class="menu-card-section">
      <div class="menu-card-section-title">Visual</div>
      <div class="menu-card-control-item">
        <span>Block Style</span>
        <select id="block-style">
          <option value="rounded"${blockStyle === 'rounded' ? ' selected' : ''}>Rounded</option>
          <option value="flat"${blockStyle === 'flat' ? ' selected' : ''}>Flat</option>
          <option value="3d"${blockStyle === '3d' ? ' selected' : ''}>3D</option>
        </select>
      </div>
    </div>
    <div class="menu-card-actions">
      <button class="menu-card-btn menu-card-btn-primary" onclick="saveSettings()">SAVE</button>
      <button class="menu-card-btn menu-card-btn-secondary" onclick="closeMenuOverlay()">CANCEL</button>
    </div>
  </div>`;
  showOverlay(html);
}
window.showSettings = showSettings;

function saveSettings() {
  const sound = document.getElementById('sound-toggle');
  const music = document.getElementById('music-toggle');
  const ghost = document.getElementById('ghost-toggle');
  const rotate = document.getElementById('rotate-style');
  const blocks = document.getElementById('block-style');
  soundOn = sound ? sound.checked : soundOn;
  musicOn = music ? music.checked : musicOn;
  showGhost = ghost ? ghost.checked : showGhost;
  if (blocks && blocks.value) blockStyle = blocks.value;
  setStored('tetris.sound', soundOn ? '1' : '0');
  setStored('tetris.music', musicOn ? '1' : '0');
  setStored('tetris.ghost', showGhost ? '1' : '0');
  setStored('tetris.blockStyle', blockStyle);
  if (rotate) setStored('tetris.rotate', rotate.value);
  if (musicOn) startMusic(); else stopMusic();
  applyBlockStyle(blockStyle);
  closeMenuOverlay();
}
window.saveSettings = saveSettings;


let colyseusClient = null;
let room = null;
let mySessionId = null;
let isMultiplayer = false;
let multiplayerRoundActive = false;
let joiningMultiplayer = false;
let latestLeaderboard = [];

function updateRoomInfo(current, needed) {
  const waitingEl = document.getElementById('waiting-status');
  if (waitingEl) waitingEl.textContent = `Waiting for players ${current}/${needed}`;
  if (multiplayerRoundActive) return;
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = `Waiting for players ${current}/${needed}`;
}

function getAliveCount() {
  try {
    if (!room || !room.state || !room.state.players) return null;
    let alive = 0;
    let total = 0;
    room.state.players.forEach((p) => {
      total++;
      if (p && p.isAlive) alive++;
    });
    return { alive, total };
  } catch (_) {
    return null;
  }
}

function updateAliveHUD() {
  const hud = document.getElementById('alive-hud');
  if (!hud) return;
  const counts = getAliveCount();
  setFinalCircle(!!(isMultiplayer && multiplayerRoundActive && counts && counts.alive === 2));
  if (!isMultiplayer || !multiplayerRoundActive || !counts) {
    hud.style.display = 'none';
    return;
  }
  hud.style.display = 'block';
  hud.textContent = `${counts.alive} ALIVE`;
  hud.classList.toggle('alive-low', counts.alive === 2);
  hud.classList.toggle('alive-final', counts.alive <= 1);
}

function updateSpectatorView() {
  const panel = document.getElementById('spectator-panel');
  const list = document.getElementById('spectator-list');
  if (!panel || !list) return;
  const spectating = isMultiplayer && multiplayerRoundActive && gameOver
    && room && room.state && room.state.players;
  if (!spectating) {
    panel.style.display = 'none';
    return;
  }
  let opponents = [];
  try {
    room.state.players.forEach((p) => {
      if (p && p.id !== mySessionId) opponents.push(p);
    });
  } catch (_) {
    panel.style.display = 'none';
    return;
  }
  opponents.sort((a, b) =>
    ((b.isAlive ? 1 : 0) - (a.isAlive ? 1 : 0)) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  list.innerHTML = '';
  opponents.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'spec-card' + (p.isAlive ? '' : ' spec-out');
    const name = document.createElement('div');
    name.className = 'spec-name';
    name.textContent = (p.isAlive ? '' : '✕ ') + String(p.name || 'Player');
    const cv = document.createElement('canvas');
    cv.width = COLS * 5;
    cv.height = ROWS * 5;
    cv.className = 'spec-board';
    card.appendChild(name);
    card.appendChild(cv);
    list.appendChild(card);
    const grid = decodeBoard(p.board);
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'rgba(3, 15, 38, 0.98)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (grid) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (grid[r][c]) {
            ctx.fillStyle = grid[r][c];
            ctx.fillRect(c * 5 + 0.5, r * 5 + 0.5, 4, 4);
          }
        }
      }
    }
    if (!p.isAlive) {
      ctx.fillStyle = 'rgba(3, 8, 18, 0.55)';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
  });
  panel.style.display = 'block';
}

function updateRoomId(roomId) {
  const roomIdEl = document.getElementById('room-id-display');
  if (roomIdEl) roomIdEl.textContent = roomId || '-';
}

async function leaveMultiplayer() {
  stopMusic();
  const activeRoom = room;
  room = null;
  mySessionId = null;
  isMultiplayer = false;
  multiplayerRoundActive = false;
  joiningMultiplayer = false;
  updateRoomId('-');
  updateAliveHUD();
  updateSpectatorView();
  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch (_) {}
  if (activeRoom) {
    try { await activeRoom.leave(); } catch (_) {}
  }
}
window.leaveMultiplayer = leaveMultiplayer;

function showMultiplayerGameScreen() {
  const sidebar = document.getElementById('home-sidebar');
  const gameArea = document.getElementById('game-area');
  const sidePanel = document.getElementById('side-panel');
  const multiplayerPanel = document.getElementById('multiplayer-panel');

  if (sidebar) sidebar.style.display = 'none';
  if (gameArea) {
    gameArea.classList.add('game-stage-visible');
    gameArea.style.display = 'flex';
  }
  if (sidePanel) {
    sidePanel.classList.add('game-stage-visible');
    sidePanel.style.display = 'flex';
  }
  if (multiplayerPanel) multiplayerPanel.style.display = 'none';
}

function showLobbyPanel() {
  const sidebar = document.getElementById('home-sidebar');
  const gameArea = document.getElementById('game-area');
  const sidePanel = document.getElementById('side-panel');
  const multiplayerPanel = document.getElementById('multiplayer-panel');
  if (sidebar) sidebar.style.display = 'none';
  if (gameArea) {
    gameArea.classList.remove('game-stage-visible');
    gameArea.style.display = 'none';
  }
  if (sidePanel) {
    sidePanel.classList.remove('game-stage-visible');
    sidePanel.style.display = 'none';
  }
  if (multiplayerPanel) multiplayerPanel.style.display = 'flex';
}
window.showLobbyPanel = showLobbyPanel;

function evaluateLobby(playerList, myId) {
  const list = Array.isArray(playerList) ? playerList : [];
  const me = list.find((p) => p && p.id === myId);
  const isHost = !!(me && me.isHost);
  const count = list.length;
  const allReady = count > 0 && list.every((p) => p && p.isReady);
  let canStart = false;
  let reason = '';
  if (!me) reason = 'not-joined';
  else if (!isHost) reason = 'only-host';
  else if (count < 2) reason = 'need-players';
  else if (!allReady) reason = 'not-ready';
  else canStart = true;
  return { count, isHost, allReady, canStart, reason, myReady: !!(me && me.isReady), me: !!me };
}

function startDeniedText(reason) {
  if (reason === 'only-host') return 'Only the host can start the game';
  if (reason === 'need-players') return 'Need at least 2 players to start';
  if (reason === 'not-ready') return 'All players must be ready';
  return 'Cannot start the game yet';
}

function lobbyHint(ev) {
  if (!ev.me) return 'Joining...';
  if (ev.count < 2) return `Waiting for players ${ev.count}/4 — invite with the room code`;
  if (!ev.allReady) return 'Waiting for everyone to press READY';
  if (ev.isHost) return 'Everyone is ready — press START GAME';
  return 'Everyone is ready — waiting for the host to start';
}

function renderLobby() {
  const listEl = document.getElementById('players-list');
  const readyBtn = document.getElementById('ready-btn');
  const startBtn = document.getElementById('start-btn');
  const waitingEl = document.getElementById('waiting-status');
  const players = [];
  try {
    if (room && room.state && room.state.players) {
      room.state.players.forEach((p) => {
        if (p) players.push({ id: p.id, name: p.name, isReady: !!p.isReady, isHost: !!p.isHost });
      });
    }
  } catch (_) {}
  players.sort((a, b) =>
    ((b.isHost ? 1 : 0) - (a.isHost ? 1 : 0)) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  const ev = evaluateLobby(players, mySessionId);
  const countEl = document.getElementById('players-count');
  if (countEl) countEl.textContent = `${players.length}/4`;
  if (listEl) {
    listEl.innerHTML = '';
    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'player-entry mp-empty';
      empty.textContent = 'No players yet — share the room code!';
      listEl.appendChild(empty);
    }
    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-entry';
      const avatar = document.createElement('span');
      const displayName = String(p.name || 'Player');
      avatar.className = 'mp-avatar' + (p.isHost ? ' mp-avatar-host' : '');
      avatar.textContent = (displayName.trim()[0] || '?').toUpperCase();
      let hue = 210;
      for (let i = 0; i < displayName.length; i++) hue = (hue + displayName.charCodeAt(i) * 37) % 360;
      avatar.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 48%), hsl(${(hue + 45) % 360}, 70%, 32%))`;
      const meta = document.createElement('span');
      meta.className = 'mp-player-meta';
      const name = document.createElement('span');
      name.className = 'mp-player-name';
      name.textContent = displayName + (p.id === mySessionId ? ' (you)' : '');
      const sub = document.createElement('span');
      sub.className = 'mp-player-sub';
      sub.textContent = [p.isHost ? 'HOST' : '', p.id === mySessionId ? 'YOU' : ''].filter(Boolean).join(' • ');
      meta.appendChild(name);
      if (sub.textContent) meta.appendChild(sub);
      const badge = document.createElement('span');
      badge.className = p.isReady ? 'player-ready' : 'player-waiting';
      badge.textContent = p.isReady ? 'READY' : 'NOT READY';
      row.appendChild(avatar);
      row.appendChild(meta);
      row.appendChild(badge);
      listEl.appendChild(row);
    });
  }
  if (readyBtn) {
    readyBtn.textContent = ev.myReady ? 'UNREADY' : 'READY';
    readyBtn.classList.toggle('ready-on', ev.myReady);
    readyBtn.disabled = !ev.me;
  }
  if (startBtn) {
    startBtn.style.display = ev.isHost ? 'block' : 'none';
    startBtn.disabled = !ev.canStart;
    startBtn.title = ev.canStart ? 'Start the game' : startDeniedText(ev.reason);
  }
  if (waitingEl && room && !multiplayerRoundActive) {
    waitingEl.textContent = lobbyHint(ev);
  }
}

function showLobbyToast(text, durationMs) {
  const feed = document.getElementById('elim-feed');
  if (!feed || !text) return;
  const toast = document.createElement('div');
  toast.className = 'elim-toast';
  toast.textContent = String(text);
  while (feed.children.length >= 4 && feed.firstChild) {
    feed.removeChild(feed.firstChild);
  }
  feed.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode === feed) feed.removeChild(toast);
  }, typeof durationMs === 'number' ? durationMs : 3200);
}
window.showLobbyToast = showLobbyToast;

function beginMultiplayerGame() {
  if (multiplayerRoundActive) return;
  multiplayerRoundActive = true;
  latestLeaderboard = [];
  showMultiplayerGameScreen();
  startGame();
  updateAliveHUD();
  updateSpectatorView();
}

function getUrlParams() {
  return new URLSearchParams(window.location.search);
}

function setRoomUrl(roomCodeOrId, playerName) {
  const params = getUrlParams();
  if (roomCodeOrId) params.set('room', roomCodeOrId);
  if (playerName) params.set('name', playerName);
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, '', newUrl);
}

function buildInviteLink(origin, pathname, codeOrId) {
  const raw = String(codeOrId || '').trim();
  const clean = raw.length > 5 ? raw.replace(/\s+/g, '') : normalizeRoomCode(raw);
  if (!clean) return '';
  const path = pathname && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
  return `${String(origin || '').replace(/\/$/, '')}${path}?room=${clean}`;
}

function normalizeRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function findRoomByCode(rooms, code) {
  const needle = normalizeRoomCode(code);
  if (!needle || !Array.isArray(rooms)) return null;
  return rooms.find((r) => {
    const meta = r && r.metadata;
    const c = meta && meta.code;
    return typeof c === 'string' && c.toUpperCase() === needle;
  }) || null;
}

function getServerHttpBase(serverUrl) {
  return String(serverUrl || '').replace(/^ws/, 'http').replace(/\/$/, '');
}

async function resolveRoomCode(code, serverUrl) {
  const needle = normalizeRoomCode(code);
  if (!needle) return null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  try {
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), 8000);
    }
    const res = await fetch(
      `${getServerHttpBase(serverUrl)}/rooms/by-code/${needle}`,
      controller ? { signal: controller.signal } : undefined
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body && body.roomId ? body.roomId : null;
  } catch (_) {
    throw new Error('resolve_failed');
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function mapJoinError(e) {
  const message = String((e && e.message) || '');
  if (message === 'room_not_found') return 'Room not found';
  if (/already full|is full|room is full/i.test(message)) return 'Room is Full';
  if (/locked/i.test(message)) return 'Game already in progress';
  if (message === 'resolve_failed') return 'Could not reach the game server';
  return 'Multiplayer connection failed';
}

async function joinMultiplayer(playerName, codeOrRoomId = null, options = {}) {
  if (joiningMultiplayer || room) return;
  joiningMultiplayer = true;
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const serverUrl = isLocal
    ? 'ws://localhost:2567'
    : 'wss://tetris-game-mqi9.onrender.com';
  colyseusClient = new Client(serverUrl);


  try {
    const input = String(codeOrRoomId || '').trim();
    if (options.forceCreate) {
      room = await colyseusClient.create('tetris_room', { name: playerName });
    } else if (input.length > 5) {
      room = await colyseusClient.joinById(input, { name: playerName });
    } else if (input) {
      const setupError = document.getElementById('mp-setup-error');
      if (setupError) {
        setupError.textContent = 'Resolving room code...';
        setupError.classList.add('visible');
      }
      const roomId = await resolveRoomCode(input, serverUrl);
      if (!roomId) throw new Error('room_not_found');
      room = await colyseusClient.joinById(roomId, { name: playerName });
    } else {
      room = await colyseusClient.joinOrCreate('tetris_room', { name: playerName });
    }
    mySessionId = room.sessionId;
    isMultiplayer = true;
    const displayCode = (room.state && room.state.roomCode) || room.roomId;
    updateRoomId(displayCode);
    setRoomUrl(displayCode, playerName);
    updateRoomInfo(room.state.players ? room.state.players.size : 1, 4);
    showLobbyPanel();
    const setup = document.getElementById('mp-setup');
    if (setup) setup.style.display = 'none';
    const setupBack = document.getElementById('mp-setup-back');
    if (setupBack) setupBack.style.display = 'none';
    const lobby = document.getElementById('mp-lobby');
    if (lobby) lobby.style.display = 'flex';
    renderLobby();

    console.log('Joined room:', room.roomId);

    room.onMessage('player_joined', (data) => {
      if (!data) return;
      console.log('Player joined:', data.name);
      updateRoomInfo(room.state.players.size, 4);
      updateAliveHUD();
      renderLobby();
    });

    room.onMessage('player_left', (data) => {
      if (!data) return;
      console.log('Player left:', data.sessionId);
      updateRoomInfo(room.state.players.size, 4);
      updateAliveHUD();
      renderLobby();
      if (data.name) showLobbyToast(`${data.name} left the room`);
    });

    room.onMessage('host_changed', (data) => {
      if (!data) return;
      renderLobby();
      showLobbyToast(`${data.name || 'Someone'} is now the host`);
    });

    room.onMessage('start_denied', (data) => {
      const msg = startDeniedText(data && data.reason);
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = msg;
      showLobbyToast(msg);
    });

    room.onMessage('game_start', () => {
      console.log('Game starting!');
      beginMultiplayerGame();
    });

    room.onMessage('game_over', (data) => {
      if (!data) return;
      const isWinner = data.winnerId === mySessionId;
      endGameMultiplayer(isWinner, data.winnerName || 'Someone', data.leaderboard || []);
    });

    room.onMessage('player_action', (data) => {
      if (!data) return;
      console.log('Player', data.sessionId, 'did:', data.action);
    });

    room.onMessage('garbage_received', (data) => {
      if (!data || !Array.isArray(data.rows)) return;
      applyGarbage(data.rows);
    });

    room.onMessage('player_eliminated', (data) => {
      if (!data || !data.eliminatedName) return;
      showEliminationToast(data.eliminatedName, data.eliminatorName || null);
    });

    room.onMessage('waiting_players', (data) => {
      if (!data) return;
      updateRoomInfo(data.current, data.needed);
      renderLobby();
    });

    room.onStateChange((state) => {
      if (!state) return;
      if (state.players) updateRoomInfo(state.players.size, 4);
      updateAliveHUD();
      updateSpectatorView();
      renderLobby();
      if (state.gameActive) beginMultiplayerGame();
    });

    room.onLeave((code) => {
      console.warn('Disconnected from multiplayer room:', code);
      room = null;
      mySessionId = null;
      isMultiplayer = false;
      multiplayerRoundActive = false;
      updateAliveHUD();
      updateSpectatorView();
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = 'Multiplayer connection closed';
    });

    // The room starts automatically when its fourth player joins. This state
    // check covers a start that occurred while this client was joining.
    if (room.state.gameActive) beginMultiplayerGame();

  } catch (e) {
    console.error('Connection error:', e);
    const friendly = mapJoinError(e);
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = friendly;
    const waitingEl = document.getElementById('waiting-status');
    if (waitingEl) waitingEl.textContent = friendly;
    const setupError = document.getElementById('mp-setup-error');
    if (setupError) {
      setupError.textContent = friendly;
      setupError.classList.add('visible');
    }
    const goBtn = document.getElementById('mp-setup-go');
    if (goBtn) {
      goBtn.disabled = false;
      goBtn.textContent = goBtn.dataset.mode === 'join' ? 'JOIN ROOM' : 'CREATE ROOM';
    }
    isMultiplayer = false;
    room = null;
  } finally {
    joiningMultiplayer = false;
  }
}

function sendScoreUpdate() {
  if (room && isMultiplayer) {
    const payload = { score, level, lines };
    if (typeof board !== 'undefined' && board) {
      try { payload.board = encodeBoard(); } catch (_) {}
    }
    room.send("score_update", payload);
  }
}

// Compact spectator encoding: one char per cell, '0' empty, 1-7 piece
// colors, 8 garbage. Only meaningful on the standard 10x20 board.
const BOARD_PALETTE = ['', COLORS_HEX.I, COLORS_HEX.O, COLORS_HEX.T, COLORS_HEX.S, COLORS_HEX.Z, COLORS_HEX.J, COLORS_HEX.L, GARBAGE_COLOR];

function encodeBoard() {
  let out = '';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = board[r][c];
      if (!cell) { out += '0'; continue; }
      const idx = BOARD_PALETTE.indexOf(cell);
      out += idx > 0 ? String(idx) : '8';
    }
  }
  return out;
}

function decodeBoard(str) {
  if (typeof str !== 'string' || str.length !== ROWS * COLS) return null;
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const code = str.charCodeAt(r * COLS + c) - 48;
      if (code < 0 || code > 8) return null;
      row.push(code === 0 ? 0 : BOARD_PALETTE[code]);
    }
    grid.push(row);
  }
  return grid;
}

function sendAttack(cleared) {
  if (room && isMultiplayer && multiplayerRoundActive
      && Number.isInteger(cleared) && cleared >= 2 && cleared <= 4) {
    garbageSent += { 2: 1, 3: 2, 4: 4 }[cleared] || 0;
    room.send("attack", { cleared });
  }
}

function notifyDead() {
  if (room && isMultiplayer && multiplayerRoundActive) {
    room.send("player_dead", {});
  }
}

function sendPlayerAction(action) {
  if (room && isMultiplayer && multiplayerRoundActive) {
    room.send('player_action', { action });
  }
}

function requestMultiplayerRestart() {
  if (!room || !isMultiplayer) return;
  room.send('request_restart', {});
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Waiting for players to restart';
}

function endGameMultiplayer(isWinner, winnerName, leaderboard = []) {
  latestLeaderboard = leaderboard;
  multiplayerRoundActive = false;
  gameOver = true; running = false;
  stopMusic();
  sfx(isWinner ? 'level' : 'over');
  updateAliveHUD();
  updateSpectatorView();
  showGameOverScreen({ isWinner, winnerName, leaderboard });
}

function copyRoomId() {
    if (!room) return;
    const displayEl = document.getElementById('room-id-display');
    const displayText = (displayEl && displayEl.textContent || '').trim();
    const link = buildInviteLink(window.location.origin, window.location.pathname, displayText !== '-' ? displayText : room.roomId);
    navigator.clipboard.writeText(link || room.roomId);
    const btn = document.getElementById('invite-btn');
    if (btn) {
        btn.textContent = 'COPIED!';
        setTimeout(() => btn.textContent = 'INVITE', 2000);
    }
}
window.copyRoomId = copyRoomId;

function validateJoinInput(name, code) {
  const cleanName = String(name || '').trim().slice(0, 24) || 'Player';
  const raw = String(code || '').trim();
  if (!raw) return { error: 'Enter a room code to join' };
  if (raw.length > 5) return { name: cleanName, code: raw.replace(/\s+/g, '') };
  const cleanCode = normalizeRoomCode(raw);
  if (!cleanCode) return { error: 'Enter a room code to join' };
  if (cleanCode.length < 2) return { error: 'Room codes are at least 2 characters' };
  return { name: cleanName, code: cleanCode };
}

function showMpSetup(mode, presetCode) {
  const panel = document.getElementById('multiplayer-panel');
  if (panel) panel.style.display = 'flex';
  const setup = document.getElementById('mp-setup');
  const lobby = document.getElementById('mp-lobby');
  if (setup) setup.style.display = 'flex';
  if (lobby) lobby.style.display = 'none';
  const setupBack = document.getElementById('mp-setup-back');
  if (setupBack) setupBack.style.display = 'block';

  const createMode = mode !== 'join';
  if (setup) setup.classList.toggle('join-mode', !createMode);
  const title = document.getElementById('mp-setup-title');
  if (title) title.textContent = createMode ? 'Create Room' : 'Join Room';
  const codeInput = document.getElementById('mp-code-input');
  if (codeInput) {
    codeInput.style.display = createMode ? 'none' : 'block';
    const preset = normalizeRoomCode(presetCode);
    codeInput.value = preset;
    if (codeInput.readOnly !== undefined) codeInput.readOnly = !createMode && preset.length > 0;
  }
  const errorEl = document.getElementById('mp-setup-error');
  if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }
  const nameInput = document.getElementById('mp-name-input');
  if (nameInput && normalizeRoomCode(presetCode)) {
    try { nameInput.focus(); } catch (_) {}
  }
  const goBtn = document.getElementById('mp-setup-go');
  if (goBtn) {
    goBtn.textContent = createMode ? 'CREATE ROOM' : 'JOIN ROOM';
    goBtn.dataset.mode = createMode ? 'create' : 'join';
    goBtn.disabled = false;
    if (!goBtn.dataset.bound) {
      goBtn.dataset.bound = '1';
      goBtn.addEventListener('click', confirmMpSetup);
    }
  }
  if (setupBack && !setupBack.dataset.bound) {
    setupBack.dataset.bound = '1';
    setupBack.addEventListener('click', () => {
      showHomeDashboard();
    });
  }
}
window.showMpSetup = showMpSetup;

function confirmMpSetup() {
  const goBtn = document.getElementById('mp-setup-go');
  const createMode = !goBtn || goBtn.dataset.mode !== 'join';
  const nameInput = document.getElementById('mp-name-input');
  const codeInput = document.getElementById('mp-code-input');
  const errorEl = document.getElementById('mp-setup-error');
  const name = (nameInput && nameInput.value.trim()) || 'Player';

  if (createMode) {
    if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'CREATING...'; }
    joinMultiplayer(name, null, { forceCreate: true });
    return;
  }

  const checked = validateJoinInput(name, codeInput && codeInput.value);
  if (checked.error) {
    if (errorEl) {
      errorEl.textContent = checked.error;
      errorEl.classList.add('visible');
    }
    return;
  }
  if (errorEl) errorEl.classList.remove('visible');
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'JOINING...'; }
  joinMultiplayer(checked.name, checked.code);
}
window.confirmMpSetup = confirmMpSetup;
