import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

// import your "app.config.ts" file here.
import appConfig from "../src/app.config.js";
import { MyRoomState } from "../src/rooms/schema/MyRoomState.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => await colyseus.cleanup());

  it("connecting into a room", async () => {
    // `room` is the server-side Room instance reference.
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});

    // `client1` is the client-side `Room` instance reference (same as JavaScript SDK)
    const client1 = await colyseus.connectTo(room);

    // make your assertions
    assert.strictEqual(client1.sessionId, room.clients[0].sessionId);

    // wait for state sync
    await room.waitForNextPatch();

    assert.deepStrictEqual(client1.state.toJSON(), { x: 0, y: 0 });
  });

  it("starts one tetris round, rejects invalid scores, and finishes once", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
      colyseus.connectTo(room, { name: "Three" }),
      colyseus.connectTo(room, { name: "Four" }),
    ]);

    for (const client of clients) {
      const received = room.waitForMessage("player_ready");
      client.send("player_ready", {});
      await received;
    }

    assert.strictEqual(room.state.gameActive, true);
    assert.strictEqual(room.locked, true);

    const firstPlayer = room.state.players.get(clients[0].sessionId)!;
    const invalidScore = room.waitForMessage("score_update");
    clients[0].send("score_update", { score: -1, level: 1, lines: 0 });
    await invalidScore;
    assert.strictEqual(firstPlayer.score, 0);

    const validScore = room.waitForMessage("score_update");
    clients[0].send("score_update", { score: 100, level: 1, lines: 0 });
    await validScore;
    assert.strictEqual(firstPlayer.score, 100);

    for (const client of clients.slice(1)) {
      const received = room.waitForMessage("player_dead");
      client.send("player_dead", {});
      await received;
    }

    assert.strictEqual(room.state.gameActive, false);
    assert.strictEqual(room.locked, false);
    assert.strictEqual(room.state.leaderboard.length, 4);
    assert.strictEqual(room.state.leaderboard[0].name, "One");
  });
});
