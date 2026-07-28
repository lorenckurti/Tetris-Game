import { Room, Client } from "colyseus";
import { TetrisRoomState, PlayerState, LeaderboardEntry } from "./schema/TetrisRoomState.js";

const REQUIRED_PLAYERS = 4;
const MAX_NAME_LENGTH = 24;
const RECONNECTION_WINDOW_SECONDS = 20;
const ACTIONS = new Set(["left", "right", "down", "rotate", "drop", "pause"]);

type ScoreUpdate = { score?: unknown; level?: unknown; lines?: unknown };

export class TetrisRoom extends Room {
  maxClients = REQUIRED_PLAYERS;
  state = new TetrisRoomState();
  private roundFinished = false;

  onCreate() {
    this.setState(new TetrisRoomState());

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
      if (!this.state.gameActive || !player || !player.isAlive || !this.isValidScoreUpdate(data, player)) return;

      player.score = data.score as number;
      player.level = data.level as number;
      player.lines = data.lines as number;
    });

    this.onMessage("player_dead", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!this.state.gameActive || !player || !player.isAlive) return;

      player.isAlive = false;
      this.checkGameOver();
    });

    this.onMessage("player_ready", (client) => this.markPlayerReady(client));
    this.onMessage("request_restart", (client) => this.markPlayerReady(client));
  }

  onJoin(client: Client, options: unknown) {
    const player = new PlayerState();
    player.id = client.sessionId;
    player.name = this.getPlayerName((options as { name?: unknown })?.name, client.sessionId);
    this.state.players.set(client.sessionId, player);

    this.broadcast("player_joined", { sessionId: client.sessionId, name: player.name });
    this.sendWaitingStatus();
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

  private markPlayerReady(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.state.gameActive) return;

    player.isReady = true;
    this.checkAllReady();
  }

  private checkAllReady() {
    if (this.state.gameActive) return;

    if (this.state.players.size === REQUIRED_PLAYERS &&
        Array.from(this.state.players.values()).every((player) => player.isReady)) {
      this.startRound();
      return;
    }

    this.sendWaitingStatus();
  }

  private startRound() {
    this.roundFinished = false;
    this.state.gameActive = true;
    this.lock();

    this.state.players.forEach((player) => {
      player.score = 0;
      player.level = 1;
      player.lines = 0;
      player.isAlive = true;
      player.isReady = false;
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
        name: entry.name,
        score: entry.score,
        level: entry.level,
      })),
    });
  }

  private removePlayer(sessionId: string) {
    if (!this.state.players.delete(sessionId)) return;

    this.broadcast("player_left", { sessionId });
    if (this.state.gameActive) this.checkGameOver();
    else this.checkAllReady();
  }

  private sendWaitingStatus() {
    this.broadcast("waiting_players", { current: this.state.players.size, needed: REQUIRED_PLAYERS });
  }

  private getPlayerName(value: unknown, sessionId: string) {
    if (typeof value !== "string") return `Player_${sessionId.substring(0, 4)}`;
    const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME_LENGTH);
    return name || `Player_${sessionId.substring(0, 4)}`;
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
