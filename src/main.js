import * as BABYLON from '@babylonjs/core';
import { Client } from "@colyseus/sdk";

const COLS = 10, ROWS = 20;
const CELL = 1.05;
const COLORS_HEX = {
  I: '#1DD1E8', O: '#F5C842', T: '#B44FD4',
  S: '#3DD65C', Z: '#E84040', J: '#3B82F6', L: '#F5813A'
};
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
let boardMeshes = [], pieceMeshes = [], ghostMeshes = [];
let board, piece, nextPiece, score, lines, level, gameOver, paused, dropInterval;
let lastDrop = 0;
let running = false;
let materials = {};

function hexToColor3(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return new BABYLON.Color3(r,g,b);
}

function initBabylon() {
  const canvas = document.getElementById('renderCanvas') || document.getElementById('tetris-canvas') || document.querySelector('canvas');
  if (!canvas) return;
  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.02, 0.05, 0.1, 1);

  // Camera
  const cx = (COLS * CELL) / 2 - CELL/2;
  const cy = -(ROWS * CELL) / 2 + CELL/2;
  // Start at the front of the board, then allow pointer-only orbiting.
  camera = new BABYLON.ArcRotateCamera("cam", -Math.PI/2, Math.PI/2, 28, new BABYLON.Vector3(cx, cy, 0), scene);
  camera.lowerRadiusLimit = 28;
  camera.upperRadiusLimit = 28;
  camera.lowerBetaLimit = 0.35;
  camera.upperBetaLimit = Math.PI - 0.35;
  camera.panningSensibility = 0;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");

  // Lighting
  const ambient = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0,1,0), scene);
  ambient.intensity = 0.55;
  ambient.diffuse = new BABYLON.Color3(0.8, 0.9, 1);
  ambient.groundColor = new BABYLON.Color3(0.1, 0.15, 0.3);

  const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-0.3,-0.5,1), scene);
  dir.intensity = 0.9;
  dir.diffuse = new BABYLON.Color3(1, 0.95, 0.85);

  const pt = new BABYLON.PointLight("pt", new BABYLON.Vector3(cx, cy, -8), scene);
  pt.intensity = 0.35;
  pt.diffuse = new BABYLON.Color3(0.6, 0.85, 1);

  // Pre-build materials
  Object.entries(COLORS_HEX).forEach(([k,hex]) => {
    const mat = new BABYLON.StandardMaterial("mat_"+k, scene);
    const col = hexToColor3(hex);
    mat.diffuseColor = col;
    mat.specularColor = new BABYLON.Color3(0.6, 0.6, 0.6);
    mat.specularPower = 32;
    mat.emissiveColor = col.scale(0.12);
    materials[k] = mat;
  });

  // Ghost material (transparent)
  const ghostMat = new BABYLON.StandardMaterial("ghost", scene);
  ghostMat.diffuseColor = new BABYLON.Color3(1,1,1);
  ghostMat.alpha = 0.12;
  ghostMat.wireframe = false;
  materials['ghost'] = ghostMat;

  // Grid floor / border lines
  drawBorder();

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
  // thin wire box around the board
  const w = COLS * CELL, h = ROWS * CELL;
  const cx = w/2 - CELL/2, cy = -h/2 + CELL/2;
  const lines = [
    [new BABYLON.Vector3(-CELL/2, CELL/2, 0), new BABYLON.Vector3(w-CELL/2, CELL/2, 0)],
    [new BABYLON.Vector3(-CELL/2, -h+CELL/2, 0), new BABYLON.Vector3(w-CELL/2, -h+CELL/2, 0)],
    [new BABYLON.Vector3(-CELL/2, CELL/2, 0), new BABYLON.Vector3(-CELL/2, -h+CELL/2, 0)],
    [new BABYLON.Vector3(w-CELL/2, CELL/2, 0), new BABYLON.Vector3(w-CELL/2, -h+CELL/2, 0)],
  ];
  lines.forEach((pts, i) => {
    const ls = BABYLON.MeshBuilder.CreateLines("border"+i, {points: pts}, scene);
    ls.color = new BABYLON.Color3(0.15, 0.35, 0.55);
  });
}

function meshPos(col, row) {
  return new BABYLON.Vector3(col * CELL, -row * CELL, 0);
}

function makeCube(col, row, matKey, alpha) {
  const box = BABYLON.MeshBuilder.CreateBox("b", {size: CELL * 0.92}, scene);
  box.position = meshPos(col, row);
  if (alpha !== undefined && alpha < 1) {
    const m = materials['ghost'].clone('g_'+Math.random());
    m.alpha = alpha;
    box.material = m;
  } else if (matKey) {
    box.material = materials[matKey];
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
        const m = makeCube(c, r, null, 1);
        m.material = getMaterialByColor(board[r][c]);
        boardMeshes.push(m);
      }
    }
  }
}

function getMaterialByColor(hex) {
  for (const [k,h] of Object.entries(COLORS_HEX)) if (h === hex) return materials[k];
  const mat = new BABYLON.StandardMaterial("dyn", scene);
  mat.diffuseColor = hexToColor3(hex);
  return mat;
}

function redrawPiece() {
  clearMeshes(pieceMeshes);
  clearMeshes(ghostMeshes);
  if (!piece) return;

  // ghost
  const gy = ghostRow();
  if (gy !== piece.y) {
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
        const m = makeCube(piece.x+c, piece.y+r, null, 1);
        m.material = getMaterialByColor(piece.color);
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

function lock() {
  for(let r=0;r<piece.shape.length;r++) for(let c=0;c<piece.shape[r].length;c++)
    if(piece.shape[r][c]) board[piece.y+r][piece.x+c] = piece.color;

  // clear lines
  let cleared = 0;
  for(let r=ROWS-1;r>=0;r--) {
    if(board[r].every(c=>c)) { board.splice(r,1); board.unshift(Array(COLS).fill(0)); cleared++; r++; }
  }
  const pts=[0,100,300,500,800];
  score += (pts[cleared]||0)*level;
  lines += cleared;
  level = Math.floor(lines/10)+1;
  dropInterval = Math.max(80, 1000-(level-1)*90);
  updateUI();
  sendScoreUpdate();
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
    requestMultiplayerRestart();
    return;
  }
  const ovEl = document.getElementById('overlay'); if (ovEl) ovEl.style.display = 'none';
  if (!engine) initBabylon();
  clearMeshes(boardMeshes); clearMeshes(pieceMeshes); clearMeshes(ghostMeshes);
  board = emptyBoard();
  score = 0; lines = 0; level = 1; gameOver = false; paused = false;
  dropInterval = 1000; lastDrop = performance.now();
  piece = randomPiece(); nextPiece = randomPiece();
  running = true;
  updateUI(); drawNext(); redrawBoard(); redrawPiece();
  const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'good luck!';
  const startBtn = document.getElementById('startBtn2') || document.getElementById('start-button'); if (startBtn) startBtn.textContent = 'RESTART';
}
window.startGame = startGame;

function endGame() {
  if (!gameOver) notifyDead();
  gameOver = true; running = false;
  if (isMultiplayer && multiplayerRoundActive) {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Waiting for final results...';
    return;
  }
  const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'game over — score: '+score;
  showGameOverScreen();
}

const PERSONAL_BEST_KEY = 'tetris.personalBest';

function updatePersonalBest(finalScore) {
  let previousBest = 0;
  try {
    previousBest = Number.parseInt(window.localStorage.getItem(PERSONAL_BEST_KEY) || '0', 10) || 0;
  } catch (_) {}

  const best = Math.max(previousBest, finalScore);
  const isNewRecord = finalScore > previousBest;
  if (isNewRecord) {
    try { window.localStorage.setItem(PERSONAL_BEST_KEY, String(best)); } catch (_) {}
  }

  const homeScore = document.getElementById('home-score-value');
  if (homeScore) homeScore.textContent = best;
  return { best, isNewRecord };
}

function showGameOverScreen({ isWinner = false, winnerName = '', leaderboard = [] } = {}) {
  const { best, isNewRecord } = updatePersonalBest(score);
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
    ? `<section class="game-over-leaderboard"><div class="game-over-section-title">FINAL RANKINGS</div><ol>${rankings}</ol></section>`
    : '';
  const title = isWinner ? 'YOU WIN!' : 'GAME OVER';
  const resultMessage = leaderboard.length
    ? `<p class="game-over-result ${isWinner ? 'game-over-result-winner' : ''}">${isWinner ? '♛ CHAMPION OF THE ROUND' : `${escapeHtml(winnerName)} WINS`}</p>`
    : '';
  const ov = document.getElementById('overlay');
  if (!ov) return;

  showHomeDashboard();
  ov.innerHTML = `<section class="game-over-card${isWinner ? ' game-over-card-winner' : ''}" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
    <div class="game-over-eyebrow">ROUND COMPLETE</div>
    <h2 id="game-over-title">${isWinner ? '♛ ' : ''}${title}</h2>
    ${resultMessage}
    <div class="game-over-score"><span>FINAL SCORE</span><strong>${score}</strong></div>
    <div class="game-over-best ${isNewRecord ? 'game-over-new-record' : ''}">
      <span>${isNewRecord ? '★ NEW PERSONAL BEST' : 'PERSONAL BEST'}</span><strong>${best}</strong>
    </div>
    <div class="game-over-stats">
      <div><span>LINES</span><strong>${lines}</strong></div>
      <div><span>LEVEL</span><strong>${level}</strong></div>
    </div>
    ${multiplayerResults}
    <div class="game-over-actions">
      <button class="game-over-play" onclick="playAgain()">PLAY AGAIN</button>
      <button class="game-over-menu" onclick="returnToDashboard()">MAIN MENU</button>
    </div>
  </section>`;
  ov.classList.add('active');
  ov.style.display = 'flex';
}

function playAgain() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.style.display = 'none';

  if (isMultiplayer) {
    const panel = document.getElementById('multiplayer-panel');
    if (panel) panel.style.display = 'flex';
    requestMultiplayerRestart();
    return;
  }

  showMultiplayerGameScreen();
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
  if (!running || !piece) return;
  if (e.key==='p'||e.key==='P') {
    paused = !paused;
    const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = paused ? 'paused' : 'good luck!';
    if (!paused) lastDrop = performance.now();
    return;
  }
  if (paused || gameOver) return;
  if (e.key==='ArrowLeft') { if(valid(piece.shape,piece.x-1,piece.y)){piece.x--;redrawPiece(); sendPlayerAction('left');} }
  else if (e.key==='ArrowRight') { if(valid(piece.shape,piece.x+1,piece.y)){piece.x++;redrawPiece(); sendPlayerAction('right');} }
  else if (e.key==='ArrowDown') { moveDown(); lastDrop=performance.now(); sendPlayerAction('down'); }
  else if (e.key==='ArrowUp') { const r=rotate(piece.shape); if(valid(r,piece.x,piece.y)){piece.shape=r;redrawPiece(); sendPlayerAction('rotate');} }
  else if (e.key===' ') { e.preventDefault(); while(valid(piece.shape,piece.x,piece.y+1)) piece.y++; lock(); redrawPiece(); lastDrop = performance.now(); sendPlayerAction('drop'); }
});

function showHomeDashboard() {
  const sidebar = document.getElementById('home-sidebar');
  const gameArea = document.getElementById('game-area');
  const sidePanel = document.getElementById('side-panel');
  const multiplayerPanel = document.getElementById('multiplayer-panel');

  if (sidebar) sidebar.style.display = 'flex';
  if (gameArea) {
    gameArea.classList.remove('game-stage-visible');
    gameArea.style.display = 'none';
  }
  if (sidePanel) {
    sidePanel.classList.remove('game-stage-visible');
    sidePanel.style.display = 'none';
  }
  if (multiplayerPanel) multiplayerPanel.style.display = 'none';
}

function returnToDashboard() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.style.display = 'none';
  showHomeDashboard();
}
window.returnToDashboard = returnToDashboard;

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

  const showGameScreen = () => {
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
  };

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

  const multiplayerHomeBtn = document.getElementById('multiplayer-home-btn');
  if (multiplayerHomeBtn) {
    multiplayerHomeBtn.addEventListener('click', () => {
      showMultiplayerScreen();
      joinMultiplayerPrompt();
    });
  }

  const backBtn = document.getElementById('multiplayer-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showHomeDashboard();
    });
  }

  const customizeBtn = document.getElementById('customize-home-btn');
  if (customizeBtn) customizeBtn.addEventListener('click', () => {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Customize coming soon';
  });

  const howToPlayBtn = document.getElementById('how-to-play-home-btn');
  if (howToPlayBtn) howToPlayBtn.addEventListener('click', () => {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'How to play coming soon';
  });

  const recordsBtn = document.getElementById('records-home-btn');
  if (recordsBtn) recordsBtn.addEventListener('click', () => {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Records coming soon';
  });

  const settingsBtn = document.getElementById('settings-home-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Settings coming soon';
  });

  const creditsBtn = document.getElementById('credits-home-btn');
  if (creditsBtn) creditsBtn.addEventListener('click', () => {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Credits coming soon';
  });

  const overlay = document.getElementById('overlay'); if (overlay) overlay.addEventListener('click', () => overlay.style.display = 'none');

  const params = getUrlParams();
  const roomId = params.get('room') || params.get('roomId');
  const playerName = params.get('name') || params.get('player');
  if (roomId) {
    joinMultiplayer(playerName || 'Player', roomId);
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


let colyseusClient = null;
let room = null;
let mySessionId = null;
let isMultiplayer = false;
let multiplayerRoundActive = false;
let joiningMultiplayer = false;
let latestLeaderboard = [];

function updateRoomInfo(current, needed) {
  const statusEl = document.getElementById('status');
  const waitingEl = document.getElementById('waiting-status');
  if (statusEl) statusEl.textContent = `Waiting for players ${current}/${needed}`;
  if (waitingEl) waitingEl.textContent = `Waiting for players ${current}/${needed}`;
}

function updateRoomId(roomId) {
  const roomIdEl = document.getElementById('room-id-display');
  if (roomIdEl) roomIdEl.textContent = roomId || '-';
}

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

function beginMultiplayerGame() {
  if (multiplayerRoundActive) return;
  multiplayerRoundActive = true;
  latestLeaderboard = [];
  showMultiplayerGameScreen();
  startGame();
}

function getUrlParams() {
  return new URLSearchParams(window.location.search);
}

function setRoomUrl(roomId, playerName) {
  const params = getUrlParams();
  if (roomId) params.set('room', roomId);
  if (playerName) params.set('name', playerName);
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, '', newUrl);
}

async function joinMultiplayer(playerName, roomId = null) {
  if (joiningMultiplayer || room) return;
  joiningMultiplayer = true;
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const serverUrl = isLocal 
    ? 'ws://localhost:2567'
    : 'wss://tetris-game-mqi9.onrender.com';
  colyseusClient = new Client(serverUrl);


  try {
    if (roomId && typeof colyseusClient.joinById === 'function') {
      room = await colyseusClient.joinById(roomId, { name: playerName });
    } else {
      room = await colyseusClient.joinOrCreate('tetris_room', { name: playerName });
    }
    mySessionId = room.sessionId;
    isMultiplayer = true;
    updateRoomId(room.roomId);
    setRoomUrl(room.roomId, playerName);
    updateRoomInfo(room.state.players ? room.state.players.size : 1, 4);

    console.log('Joined room:', room.roomId);

    room.onMessage('player_joined', (data) => {
      if (!data) return;
      console.log('Player joined:', data.name);
      updateRoomInfo(room.state.players.size, 4);
    });

    room.onMessage('player_left', (data) => {
      if (!data) return;
      console.log('Player left:', data.sessionId);
      updateRoomInfo(room.state.players.size, 4);
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

    room.onMessage('waiting_players', (data) => {
      if (!data) return;
      updateRoomInfo(data.current, data.needed);
    });

    room.onStateChange((state) => {
      if (!state) return;
      if (state.players) updateRoomInfo(state.players.size, 4);
      if (state.gameActive) beginMultiplayerGame();
    });

    room.onLeave((code) => {
      console.warn('Disconnected from multiplayer room:', code);
      room = null;
      mySessionId = null;
      isMultiplayer = false;
      multiplayerRoundActive = false;
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = 'Multiplayer connection closed';
    });

    // The room starts automatically when its fourth player joins. This state
    // check covers a start that occurred while this client was joining.
    if (room.state.gameActive) beginMultiplayerGame();

  } catch (e) {
    console.error('Connection error:', e);
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Multiplayer connection failed';
    isMultiplayer = false;
    room = null;
  } finally {
    joiningMultiplayer = false;
  }
}

function sendScoreUpdate() {
  if (room && isMultiplayer) {
    room.send("score_update", { score, level, lines });
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
  showGameOverScreen({ isWinner, winnerName, leaderboard });
}

function copyRoomId() {
    if (!room) return;
    navigator.clipboard.writeText(room.roomId);
    const btn = document.getElementById('invite-btn');
    if (btn) {
        btn.textContent = 'COPIED!';
        setTimeout(() => btn.textContent = 'INVITE', 2000);
    }
}
window.copyRoomId = copyRoomId;

function joinMultiplayerPrompt() {
    
    const panel = document.getElementById('multiplayer-panel');
    if (panel) panel.style.display = 'flex';
    
    
    const waitingEl = document.getElementById('waiting-status');
    if (waitingEl) {
        waitingEl.innerHTML = `
            <input id="name-input" placeholder="Enter your name" style="
                background:transparent;
                border:1px solid rgb(79,138,239);
                color:#cfe9ff;
                padding:6px 8px;
                border-radius:4px;
                font-size:10px;
                width:100%;
                margin-bottom:6px;
                box-sizing:border-box;
            "/>
            <button onclick="confirmJoin()" style="
                width:100%;
                padding:7px;
                border-radius:6px;
                border:1.5px solid rgb(79,138,239);
                background:transparent;
                color:rgb(79,138,239);
                font-size:10px;
                letter-spacing:2px;
                cursor:pointer;
            ">JOIN</button>
        `;
    }
}

function confirmJoin() {
    window.history.replaceState(null, '', window.location.pathname);
    const input = document.getElementById('name-input');
    const name = (input && input.value.trim()) || "Player";
    const waitingEl = document.getElementById('waiting-status');
    if (waitingEl) waitingEl.textContent = 'Connecting...';
    const params = getUrlParams();
    const roomId = params.get('room') || params.get('roomId');
    joinMultiplayer(name, roomId);
}
window.confirmJoin = confirmJoin;

window.joinMultiplayerPrompt = joinMultiplayerPrompt;
