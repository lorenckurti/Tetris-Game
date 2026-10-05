import { Schema, MapSchema, type, ArraySchema } from "@colyseus/schema";

export class LeaderboardEntry extends Schema {
    @type("string") id: string = "";
    @type("string") name: string = "";
    @type("number") score: number = 0;
    @type("number") level: number = 1;
}

export class PlayerState extends Schema {
    @type("string") id: string = "";
    @type("string") name: string = "";
    @type("number") score: number = 0;
    @type("number") level: number = 1;
    @type("number") lines: number = 0;
    @type("boolean") isAlive: boolean = true;
    @type("boolean") isReady: boolean = false;
    @type("boolean") isHost: boolean = false;
    @type("string") board: string = "";
}

export class TetrisRoomState extends Schema {
  @type("boolean") gameActive: boolean = false;
  @type("number") score: number = 0;
  @type("number") level: number = 1;
  @type("string") roomCode: string = "";
  @type({ map: PlayerState }) players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
  @type([LeaderboardEntry]) leaderboard: ArraySchema<LeaderboardEntry> = new ArraySchema<LeaderboardEntry>();
}


