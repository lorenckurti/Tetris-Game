import { Room, Client } from "colyseus";
import { matchMaker } from "@colyseus/core";
import { TetrisRoomState, PlayerState, LeaderboardEntry } from "./schema/TetrisRoomState.js";

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_NAME_LENGTH = 24;
const RECONNECTION_WINDOW_SECONDS = 20;
const ROOM_CODE_LENGTH = 4;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
const ACTIONS = new Set(["left", "right", "down", "rotate", "drop", "pause"]);
const GARBAGE_WIDTH = 10;
const GARBAGE_FOR_CLEARED: Record<number, number> = { 2: 1, 3: 2, 4: 4 };

type ScoreUpdate = { score?: unknown; level?: unknown; lines?: unknown; board?: unknown };
type AttackMessage = { cleared?: unknown };

export class TetrisRoom extends Room {
  maxClients = MAX_PLAYERS;
  state = new TetrisRoomState();
  private roundFinished = false;
  private lastAttacker = new Map<string, string>();

  async onCreate() {
    this.setState(new TetrisRoomState());
    this.state.roomCode = await this.generateUniqueRoomCode();
    try {
      await this.setMetadata({ code: this.state.roomCode });
    } catch (_) {}

    this.onMessage("player_action", (client, data: unknown) => {
      const player = this.state.players.get(client.sessionId);
      const action = typeof (data as { action?: unknown })?.action === "string"
        ? (data as { action: string }).action
        : undefined;

      if (!this.state.gameActive || !player?.isAlive || !action || !ACTIONS.has(action)) return;
      this.broadcast("player_action", { sessionId: client.sessionId, action }, { except: client });
    });

    this.onMessage("score_update", (client, data: ScoreUpdate) => {
      const player = this.state.players.get(client.sessionId);
      if (!this.state.gameActive || !player || !player.isAlive) return;

      // Compact spectator snapshot (200 cells, codes 0-7). Optional and
      // validated independently so a bad board never blocks score updates.
      if (typeof data?.board !== "undefined" && this.isValidBoardSnapshot(data.board)) {
        player.board = data.board;
      }
      if (!this.isValidScoreUpdate(data, player)) return;

      player.score = data.score as number;
      player.level = data.level as number;
      player.lines = data.lines as number;
    });

    this.onMessage("player_dead", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!this.state.gameActive || !player || !player.isAlive) return;

      player.isAlive = false;
      const attackerId = this.lastAttacker.get(client.sessionId);
      this.lastAttacker.delete(client.sessionId);
      const attacker = attackerId ? this.state.players.get(attackerId) : undefined;
      this.broadcast("player_eliminated", {
        eliminatedId: player.id,
        eliminatedName: player.name,
        eliminatorId: attacker?.id ?? null,
        eliminatorName: attacker?.name ?? null,
      });
      this.checkGameOver();
    });

    this.onMessage("attack", (client, data: AttackMessage) => {
      const player = this.state.players.get(client.sessionId);
      const cleared = (data as { cleared?: unknown })?.cleared;
      if (!this.state.gameActive || !player || !player.isAlive) return;
      if (typeof cleared !== "number" || !Number.isInteger(cleared)) return;
      const garbageCount = GARBAGE_FOR_CLEARED[cleared];
      if (!garbageCount) return;

      const targets = Array.from(this.state.players.values()).filter(
        (candidate) => candidate.isAlive && candidate.id !== client.sessionId
      );
      if (targets.length === 0) return;
      const target = targets[Math.floor(Math.random() * targets.length)];
      const targetClient = this.clients.find((c) => c.sessionId === target.id);
      if (!targetClient) return;

      this.lastAttacker.set(target.id, client.sessionId);
      const rows: number[][] = [];
      for (let i = 0; i < garbageCount; i++) {
        const hole = Math.floor(Math.random() * GARBAGE_WIDTH);
        const row = new Array<number>(GARBAGE_WIDTH).fill(1);
        row[hole] = 0;
        rows.push(row);
      }
      targetClient.send("garbage_received", {
        rows,
        count: garbageCount,
        from: client.sessionId,
      });
    });

    this.onMessage("player_ready", (client, data: unknown) => {
      const ready = typeof (data as { ready?: unknown })?.ready === "boolean"
        ? (data as { ready: boolean }).ready
        : true;
      this.markPlayerReady(client, ready);
    });
    this.onMessage("request_restart", (client) => this.markPlayerReady(client, true));

    this.onMessage("start_game", (client) => {
      if (this.state.gameActive) return;
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isHost) {
        try { client.send("start_denied", { reason: "only-host" }); } catch (_) {}
        return;
      }
      const players = Array.from(this.state.players.values());
      if (players.length < MIN_PLAYERS) {
        try { client.send("start_denied", { reason: "need-players" }); } catch (_) {}
        return;
      }
      if (!players.every((p) => p.isReady)) {
        try { client.send("start_denied", { reason: "not-ready" }); } catch (_) {}
        return;
      }
      this.startRound();
    });
  }

  onJoin(client: Client, options: unknown) {
    const player = new PlayerState();
    player.id = client.sessionId;
    player.name = this.getPlayerName((options as { name?: unknown })?.name, client.sessionId);
    player.isHost = this.state.players.size === 0;
    this.state.players.set(client.sessionId, player);

    this.broadcast("player_joined", {
      sessionId: client.sessionId,
      name: player.name,
      isHost: player.isHost,
      isReady: player.isReady,
    });
    if (!this.state.gameActive) {
      this.sendWaitingStatus();
    }
  }

  async onDrop(client: Client) {
    // Keep an unexpectedly disconnected player in the match long enough for the
    // Colyseus client to reconnect. onLeave handles intentional departures.
    if (!this.state.players.has(client.sessionId)) return;
    try {
      await this.allowReconnection(client, RECONNECTION_WINDOW_SECONDS);
    } catch {
      // The reservation expired; remove the player below.
      this.removePlayer(client.sessionId);
    }
  }

  onLeave(client: Client) {
    this.removePlayer(client.sessionId);
  }

  private async generateUniqueRoomCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateRoomCode();
      try {
        const rooms = await matchMaker.query({ name: "tetris_room" });
        const taken = rooms.some((room) => {
          const meta = room.metadata as { code?: unknown } | undefined;
          return meta?.code === candidate && !room.locked;
        });
        if (!taken) return candidate;
      } catch (_) {
        return candidate;
      }
    }
    return generateRoomCode();
  }

  private markPlayerReady(client: Client, ready: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.state.gameActive) return;

    player.isReady = ready;
    this.refreshLobby();
  }

  private refreshLobby() {
    if (this.state.gameActive) return;

    this.sendWaitingStatus();
  }

  private startRound() {
    this.roundFinished = false;
    this.lastAttacker.clear();
    this.state.gameActive = true;
    this.lock();

    this.state.players.forEach((player) => {
      player.score = 0;
      player.level = 1;
      player.lines = 0;
      player.isAlive = true;
      player.isReady = false;
      player.board = "";
    });
    this.broadcast("game_start", {});
  }

  private checkGameOver() {
    if (!this.state.gameActive || this.roundFinished) return;

    const players = Array.from(this.state.players.values());
    const alivePlayers = players.filter((player) => player.isAlive);
    if (alivePlayers.length > 1) return;

    this.roundFinished = true;
    this.state.gameActive = false;
    this.unlock();

    const sortedPlayers = players
      .slice()
      .sort((a, b) => b.score - a.score || b.level - a.level || b.lines - a.lines || a.id.localeCompare(b.id));
    const winner = sortedPlayers[0];

    this.state.leaderboard.clear();
    sortedPlayers.forEach((player) => {
      const entry = new LeaderboardEntry();
      entry.id = player.id;
      entry.name = player.name;
      entry.score = player.score;
      entry.level = player.level;
      this.state.leaderboard.push(entry);
      player.isReady = false;
    });

    this.broadcast("game_over", {
      winnerId: winner?.id ?? "",
      winnerName: winner?.name ?? "",
      leaderboard: this.state.leaderboard.map((entry) => ({
        id: entry.id,
        name: entry.name,
        score: entry.score,
        level: entry.level,
      })),
    });
  }

  private removePlayer(sessionId: string) {
    const departing = this.state.players.get(sessionId);
    if (!this.state.players.delete(sessionId)) return;

    this.lastAttacker.delete(sessionId);
    this.broadcast("player_left", { sessionId, name: departing?.name ?? "" });

    if (this.state.gameActive) {
      this.checkGameOver();
      return;
    }

    if (departing?.isHost && this.state.players.size > 0) {
      const nextHost = Array.from(this.state.players.values())[0];
      if (nextHost && !nextHost.isHost) {
        nextHost.isHost = true;
        this.broadcast("host_changed", { sessionId: nextHost.id, name: nextHost.name });
      }
    }
    this.refreshLobby();
  }

  private sendWaitingStatus() {
    this.broadcast("waiting_players", { current: this.state.players.size, needed: MAX_PLAYERS });
  }

  private getPlayerName(value: unknown, sessionId: string) {
    if (typeof value !== "string") return `Player_${sessionId.substring(0, 4)}`;
    const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME_LENGTH);
    return name || `Player_${sessionId.substring(0, 4)}`;
  }

  private isValidBoardSnapshot(value: unknown): value is string {
    // Standard multiplayer board: 10x20 cells, codes 0 (empty) through 8.
    return typeof value === "string" && value.length === 200 && /^[0-8]*$/.test(value);
  }

  private isValidScoreUpdate(data: ScoreUpdate, player: PlayerState) {
    const { score, level, lines } = data ?? {};
    if (![score, level, lines].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return false;
    const nextScore = score as number;
    const nextLevel = level as number;
    const nextLines = lines as number;
    if (nextScore < player.score || nextLines < player.lines || nextLevel < player.level) return false;
    // The client uses this same level formula. Enforcing it prevents malformed
    // packets from corrupting the authoritative room state.
    return nextLevel === Math.floor(nextLines / 10) + 1;
  }

  onDispose() {
    console.log("tetris room", this.roomId, "disposing...");
  }
}
