import { Room, Client, CloseCode } from "colyseus";
import { TetrisRoomState, PlayerState, LeaderboardEntry } from "./schema/TetrisRoomState.js";

export class TetrisRoom extends Room {
  maxClients = 4;
  state = new TetrisRoomState();

  onCreate(options: any) {
    this.setState(new TetrisRoomState());

    this.onMessage("player_action", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.isAlive) return;
      this.broadcast("player_action", {
        sessionId: client.sessionId,
        action: data.action
      }, { except: client });
    });

    this.onMessage("score_update", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.score = data.score;
      player.level = data.level;
      player.lines = data.lines;
    });

    this.onMessage("player_dead", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.isAlive = false;
      this.checkGameOver();
    });

    this.onMessage("player_ready", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.isReady = true;
      this.checkAllReady();
    });
  }

  onJoin(client: Client, options: any) {
    const player = new PlayerState();
    player.id = client.sessionId;
    player.name = options?.name || "Player_" + client.sessionId.substring(0, 4);
    this.state.players.set(client.sessionId, player);
    this.broadcast("player_joined", {
      sessionId: client.sessionId,
      name: player.name
    });
    this.checkAllReady();
  }

  onLeave(client: Client, code?: number) {
    this.state.players.delete(client.sessionId);
    this.broadcast("player_left", { sessionId: client.sessionId });
    this.checkAllReady();
  }

  private updateLeaderboard(name: string, score: number, level: number) {
    const entry = new LeaderboardEntry();
    entry.name = name;
    entry.score = score;
    entry.level = level;
    this.state.leaderboard.push(entry);

    const sorted = this.state.leaderboard
      .slice()
      .sort((a: LeaderboardEntry, b: LeaderboardEntry) => b.score - a.score)
      .slice(0, 10);

    this.state.leaderboard.clear();
    sorted.forEach((entryItem: LeaderboardEntry) => this.state.leaderboard.push(entryItem));
  }

  private checkAllReady() {
    let allReady = true;
    this.state.players.forEach((player: PlayerState) => { if (!player.isReady) allReady = false; });
    if (allReady && this.state.players.size === 4) {
      this.state.gameActive = true;
      this.broadcast("game_start", {});
    } else {
      this.broadcast("waiting_players", {
        current: this.state.players.size,
        needed: 4
      });
    }
  }

  private checkGameOver() {
    let alive = 0;
    let winner: PlayerState | null = null;
    const players = Array.from(this.state.players.values());

    players.forEach((player: PlayerState) => {
      if (player.isAlive) {
        alive++;
      }
      if (!winner || player.score > winner.score) {
        winner = player;
      }
    });

    if (alive <= 1 && winner) {
      const sortedPlayers = players
        .slice()
        .sort((a: PlayerState, b: PlayerState) => b.score - a.score || b.level - a.level);

      this.state.leaderboard.clear();
      sortedPlayers.forEach((player: PlayerState) => {
        const entry = new LeaderboardEntry();
        entry.name = player.name;
        entry.score = player.score;
        entry.level = player.level;
        this.state.leaderboard.push(entry);
      });

      const leaderboard = this.state.leaderboard.map(entry => ({
        name: entry.name,
        score: entry.score,
        level: entry.level
      }));

      this.broadcast("game_over", {
        winnerId: winner.id,
        winnerName: winner.name,
        leaderboard
      });
    }
  }

  onDispose() {
    console.log("tetris room", this.roomId, "disposing...");
  }
}
