import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

// import your "app.config.ts" file here.
import appConfig from "../src/app.config.js";
import { MyRoomState } from "../src/rooms/schema/MyRoomState.js";

describe("tetris battle royale", () => {
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

  it("automatically starts a tetris round when the fourth player joins", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
      colyseus.connectTo(room, { name: "Three" }),
      colyseus.connectTo(room, { name: "Four" }),
    ]);

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

  async function startFullTetrisRoom() {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
      colyseus.connectTo(room, { name: "Three" }),
      colyseus.connectTo(room, { name: "Four" }),
    ]);
    assert.strictEqual(room.state.gameActive, true);
    return { room, clients };
  }

  it("sends the correct row counts for double/triple/tetris", async () => {
    const { clients } = await startFullTetrisRoom();

    async function collectOneAttack(cleared: number) {
      const hits: any[] = [];
      const unsubscribers: Array<() => void> = [];
      for (const c of clients.slice(1)) {
        unsubscribers.push(c.onMessage("garbage_received", (payload: any) => {
          hits.push(payload);
        }));
      }
      try {
        clients[0].send("attack", { cleared });
        const deadline = Date.now() + 5000;
        while (hits.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(hits.length > 0, `no garbage received for cleared=${cleared}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.strictEqual(hits.length, 1, `expected exactly 1 target for cleared=${cleared}`);
        return hits[0];
      } finally {
        for (const unsubscribe of unsubscribers) {
          try { unsubscribe(); } catch (_) {}
        }
      }
    }

    const doublePayload = await collectOneAttack(2);
    assert.strictEqual(doublePayload.count, 1);
    assert.strictEqual(doublePayload.rows.length, 1);

    const triplePayload = await collectOneAttack(3);
    assert.strictEqual(triplePayload.count, 2);
    assert.strictEqual(triplePayload.rows.length, 2);

    const tetrisPayload = await collectOneAttack(4);
    assert.strictEqual(tetrisPayload.count, 4);
    assert.strictEqual(tetrisPayload.rows.length, 4);

    for (const payload of [doublePayload, triplePayload, tetrisPayload]) {
      for (const row of payload.rows) {
        assert.strictEqual(row.length, 10);
        assert.strictEqual(row.filter((cell: number) => cell === 0).length, 1);
        assert.ok(row.every((cell: number) => cell === 0 || cell === 1));
      }
      assert.strictEqual(typeof payload.from, "string");
    }
  });

  it("ignores single clears and invalid attack payloads", async () => {
    const { clients } = await startFullTetrisRoom();
    let received = 0;
    for (const c of clients) {
      c.onMessage("garbage_received", () => {
        received++;
      });
    }

    clients[0].send("attack", { cleared: 1 });
    clients[0].send("attack", { cleared: 5 });
    clients[0].send("attack", { cleared: 2.5 });
    clients[0].send("attack", {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(received, 0);
  });

  it("broadcasts elimination with the attacker after garbage-caused death", async () => {
    const { clients } = await startFullTetrisRoom();
    const garbageHits: Array<{ clientIndex: number; payload: any }> = [];
    clients.forEach((c, index) => {
      c.onMessage("garbage_received", (payload: any) => {
        garbageHits.push({ clientIndex: index, payload });
      });
    });
    clients[0].send("attack", { cleared: 2 });
    const deadline = Date.now() + 5000;
    while (garbageHits.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(garbageHits.length > 0, "expected a garbage target");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(garbageHits.length, 1);
    const victimIndex = garbageHits[0].clientIndex;
    assert.notStrictEqual(victimIndex, 0);

    const eliminations: any[] = [];
    for (const c of clients) {
      c.onMessage("player_eliminated", (payload: any) => {
        eliminations.push(payload);
      });
    }
    clients[victimIndex].send("player_dead", {});
    const end = Date.now() + 5000;
    while (eliminations.length === 0 && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(eliminations.length > 0, "expected elimination feed");
    for (const event of eliminations) {
      assert.strictEqual(event.eliminatedName, ["One", "Two", "Three", "Four"][victimIndex]);
      assert.strictEqual(event.eliminatorName, "One");
      assert.ok(event.eliminatorId);
    }
  });

  it("includes player ids in the final leaderboard", async () => {
    const { room, clients } = await startFullTetrisRoom();
    const payloads: any[] = [];
    for (const c of clients) {
      c.onMessage("game_over", (payload: any) => {
        payloads.push(payload);
      });
    }
    for (const client of clients.slice(1)) {
      client.send("player_dead", {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const end = Date.now() + 5000;
    while (payloads.length === 0 && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(payloads.length > 0, "expected game_over broadcast");
    const ids = new Set(payloads[0].leaderboard.map((e: any) => e.id));
    for (const c of clients) {
      assert.ok(ids.has(c.sessionId), "leaderboard covers every player");
    }
    assert.strictEqual(room.state.leaderboard.length, 4);
  });

  it("broadcasts elimination with null eliminator on self top-out", async () => {
    const { clients } = await startFullTetrisRoom();
    const eliminations: any[] = [];
    for (const c of clients) {
      c.onMessage("player_eliminated", (payload: any) => {
        eliminations.push(payload);
      });
    }
    clients[1].send("player_dead", {});
    const end = Date.now() + 5000;
    while (eliminations.length === 0 && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(eliminations.length > 0, "expected elimination feed");
    for (const event of eliminations) {
      assert.strictEqual(event.eliminatedName, "Two");
      assert.strictEqual(event.eliminatorName, null);
      assert.strictEqual(event.eliminatorId, null);
    }
  });

  it("syncs compact board snapshots with score updates", async () => {
    const { room, clients } = await startFullTetrisRoom();
    const player = () => room.state.players.get(clients[0].sessionId)!;
    assert.strictEqual(player().board, "");

    const good = "12345678" + "0".repeat(192);
    assert.strictEqual(good.length, 200);
    const received = room.waitForMessage("score_update");
    clients[0].send("score_update", { score: 100, level: 1, lines: 0, board: good });
    await received;
    assert.strictEqual(player().score, 100);
    assert.strictEqual(player().board, good);

    const rejected = room.waitForMessage("score_update");
    clients[0].send("score_update", { score: 200, level: 1, lines: 0, board: "xyz" });
    await rejected;
    assert.strictEqual(player().score, 200);
    assert.strictEqual(player().board, good);
  });
});
