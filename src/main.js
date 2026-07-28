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
  camera = new BABYLON.ArcRotateCamera("cam", -Math.PI/2, Math.PI/3.8, 28, new BABYLON.Vector3(cx, cy, 0), scene);
  camera.attachControl(canvas, false);
  camera.lowerRadiusLimit = 28;
  camera.upperRadiusLimit = 28;
  camera.lowerBetaLimit = Math.PI/3.8;
  camera.upperBetaLimit = Math.PI/3.8;
  try {
    if (camera.inputs && camera.inputs.removeByType) {
      camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
      camera.inputs.removeByType("FreeCameraKeyboardMoveInput");
    }
  } catch (e) {}

  // Lighting
  const ambient = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0,1,0), scene);
  ambient.intensity = 0.55;
  ambient.diffuse = new BABYLON.Color3(0.8, 0.9, 1);
  ambient.groundColor = new BABYLON.Color3(0.1, 0.15, 0.3);

  const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-1,-2,-1), scene);
  dir.intensity = 0.9;
  dir.diffuse = new BABYLON.Color3(1, 0.95, 0.85);

  const pt = new BABYLON.PointLight("pt", new BABYLON.Vector3(cx, 4, 6), scene);
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
  notifyDead();
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

function endGame() {
  notifyDead();
  gameOver = true; running = false;
  const statusEl = document.getElementById('status'); if (statusEl) statusEl.textContent = 'game over — score: '+score;
  const ov = document.getElementById('overlay');
  if (ov) {
    ov.innerHTML = '<h3 style="color:#E24B4A">GAME OVER</h3><p style="color:#88aacc;margin-bottom:12px">Score: '+score+'</p><button onclick="startGame()" style="padding:8px 24px;border-radius:6px;border:0.5px solid #5bbfff;background:transparent;color:#5bbfff;font-size:12px;letter-spacing:2px;cursor:pointer">PLAY AGAIN</button>';
    ov.style.display = 'flex';
  }

  createCanvasOverlay(score);
}

function createCanvasOverlay(score) {
  const canvas = document.getElementById('renderCanvas') || document.getElementById('tetris-canvas') || document.querySelector('canvas');
  if (!canvas || !canvas.parentElement) return;
  removeCanvasOverlay();

  const wrapper = document.createElement('div');
  wrapper.id = 'canvas-overlay';
  Object.assign(wrapper.style, {
    position: 'absolute',
    top: '0', left: '0',
    width: canvas.width + 'px',
    height: canvas.height + 'px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
    zIndex: 9999,
    background: 'rgba(0,0,0,0.35)',
    marginTop: '90px'
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    padding: '18px 26px',
    borderRadius: '10px',
    background: 'rgba(4,10,20,0.85)',
    color: '#cfe9ff',
    textAlign: 'center',
    boxShadow: '0 6px 18px rgba(0,0,0,0.5)'
  });
  const h = document.createElement('h2'); h.textContent = 'GAME OVER'; h.style.color = '#E24B4A'; h.style.margin = '0 0 8px 0';
  const p = document.createElement('div'); p.textContent = 'Score: ' + score; p.style.margin = '0 0 12px 0'; p.style.color = '#88aacc';
  const btn = document.createElement('button'); btn.textContent = 'PLAY AGAIN';
  Object.assign(btn.style, { padding: '8px 18px', borderRadius: '6px', border: '0.5px solid #5bbfff', background: 'transparent', color: '#5bbfff', cursor: 'pointer' });
  btn.addEventListener('click', () => { removeCanvasOverlay(); startGame(); });

  box.appendChild(h); box.appendChild(p); box.appendChild(btn);
  wrapper.appendChild(box);

  const parent = canvas.parentElement;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.appendChild(wrapper);
}

function removeCanvasOverlay() {
  const existing = document.getElementById('canvas-overlay');
  if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
}

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
  if (e.key==='ArrowLeft') { if(valid(piece.shape,piece.x-1,piece.y)){piece.x--;redrawPiece();} }
  else if (e.key==='ArrowRight') { if(valid(piece.shape,piece.x+1,piece.y)){piece.x++;redrawPiece();} }
  else if (e.key==='ArrowDown') { moveDown(); lastDrop=performance.now(); }
  else if (e.key==='ArrowUp') { const r=rotate(piece.shape); if(valid(r,piece.x,piece.y)){piece.shape=r;redrawPiece();} }
  else if (e.key===' ') { e.preventDefault(); while(valid(piece.shape,piece.x,piece.y+1)) piece.y++; lock(); redrawPiece(); lastDrop = performance.now(); }
});


document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn2') || document.getElementById('start-button');
  if (startBtn) startBtn.addEventListener('click', startGame);
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
        <td style="padding:4px 8px">${entry.name}</td>
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
  const isLocal = window.location.hostname === 'localhost';
  const serverUrl = isLocal 
    ? 'ws://localhost:2567'
    : 'wss://https://tetris-game-pmj4.onrender.com'; 
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
      startGame();
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

    setTimeout(() => {
      room.send('player_ready', {});
    }, 500);

  } catch (e) {
    console.error('Connection error:', e);
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Multiplayer connection failed';
    isMultiplayer = false;
  }
}

function sendScoreUpdate() {
  if (room && isMultiplayer) {
    room.send("score_update", { score, level, lines });
  }
}

function notifyDead() {
  if (room && isMultiplayer) {
    room.send("player_dead", {});
  }
}

function endGameMultiplayer(isWinner, winnerName, leaderboard = []) {
  latestLeaderboard = leaderboard;
  gameOver = true; running = false;
  const msg = isWinner ? '🏆 YOU WIN!' : `${winnerName} wins!`;
  const ov = document.getElementById('overlay');
  if (ov) {
    ov.innerHTML = `<h3 style="color:${isWinner ? '#3DD65C' : '#E24B4A'}">${msg}</h3>
      <p style="color:#88aacc;margin-bottom:12px">Score: ${score}</p>
      <button onclick="startGame()" style="padding:8px 24px;border-radius:6px;border:0.5px solid #5bbfff;background:transparent;color:#5bbfff;font-size:12px;letter-spacing:2px;cursor:pointer">PLAY AGAIN</button>`;
    ov.style.display = 'flex';
  }
  setTimeout(() => {showLeaderboard();}, 3000);
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
