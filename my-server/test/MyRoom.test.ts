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

    // wait for state sync (poll: patch timing varies under load)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await room.waitForNextPatch();
      try {
        assert.deepStrictEqual(client1.state.toJSON(), { x: 0, y: 0 });
        break;
      } catch (_) {
        if (Date.now() >= deadline) throw _;
      }
    }
  });

  it("lets the host start once everyone is ready", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
      colyseus.connectTo(room, { name: "Three" }),
      colyseus.connectTo(room, { name: "Four" }),
    ]);

    assert.strictEqual(room.state.gameActive, false);
    const hosts = Array.from(room.state.players.values()).filter((p) => p.isHost);
    assert.strictEqual(hosts.length, 1);
    const hostClient = clients.find((c) => c.sessionId === hosts[0].id)!;
    const nonHostClient = clients.find((c) => c.sessionId !== hosts[0].id)!;
    assert.ok(hostClient && nonHostClient);

    // Non-host start is denied.
    nonHostClient.send("start_game", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(room.state.gameActive, false);

    // Host start is denied until everyone is ready.
    hostClient.send("start_game", {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(room.state.gameActive, false);

    for (const client of clients) {
      client.send("player_ready", { ready: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(Array.from(room.state.players.values()).every((p) => p.isReady));

    hostClient.send("start_game", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    for (const client of clients) {
      client.send("player_ready", { ready: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const host = clients.find(
      (c) => room.state.players.get(c.sessionId)?.isHost
    )!;
    assert.ok(host, "expected a host");
    host.send("start_game", {});
    const deadline = Date.now() + 5000;
    while (!room.state.gameActive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  it("assigns a short unique room code on creation", async () => {
    const roomA = await colyseus.createRoom("tetris_room", {});
    const roomB = await colyseus.createRoom("tetris_room", {});
    for (const room of [roomA, roomB]) {
      assert.match(room.state.roomCode, /^[A-Z2-9]{4}$/);
    }
    assert.notStrictEqual(roomA.state.roomCode, roomB.state.roomCode);
  });

  it("resolves room codes through the lookup endpoint", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const code = room.state.roomCode;
    assert.match(code, /^[A-Z2-9]{4}$/);

    const found: any = await colyseus.http.get(`/rooms/by-code/${code}`);
    const foundBody = found?.data ?? found;
    assert.strictEqual(foundBody.roomId, room.roomId);

    let missingStatus = 0;
    try {
      await colyseus.http.get("/rooms/by-code/ZZZZ");
    } catch (e: any) {
      missingStatus = e?.statusCode ?? e?.status ?? 0;
    }
    assert.strictEqual(missingStatus, 404);
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

  it("rejects joins to a full room", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
      colyseus.connectTo(room, { name: "Three" }),
      colyseus.connectTo(room, { name: "Four" }),
    ]);
    assert.strictEqual(clients.length, 4);
    let message = "";
    try {
      await colyseus.connectTo(room, { name: "Five" });
    } catch (e) {
      message = String((e && e.message) || "");
    }
    assert.ok(message.length > 0, "expected the fifth join to be rejected");
    assert.ok(/already full|is full|locked/i.test(message), `unexpected rejection: ${message}`);
  });

  it("starts a 2-player game once both are ready", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
    ]);
    assert.strictEqual(room.state.gameActive, false);

    clients[0].send("player_ready", { ready: true });
    clients[1].send("player_ready", { ready: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const host = clients.find(
      (c) => room.state.players.get(c.sessionId)?.isHost
    )!;
    assert.ok(host, "expected a host");
    host.send("start_game", {});
    const deadline = Date.now() + 5000;
    while (!room.state.gameActive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(room.state.gameActive, true);
    assert.strictEqual(room.locked, true);
    assert.strictEqual(room.state.players.size, 2);
  });

  it("denies start with reasons until the lobby is ready", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const solo = await colyseus.connectTo(room, { name: "Solo" });
    const denials: any[] = [];
    solo.onMessage("start_denied", (payload: any) => {
      denials.push(payload);
    });

    solo.send("start_game", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(room.state.gameActive, false);
    assert.deepStrictEqual(
      denials.map((d) => d.reason),
      ["need-players"]
    );

    const second = await colyseus.connectTo(room, { name: "Duo" });
    second.onMessage("start_denied", () => {});
    solo.send("start_game", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(room.state.gameActive, false);
    assert.deepStrictEqual(
      denials.map((d) => d.reason),
      ["need-players", "not-ready"]
    );
  });

  it("migrates host when the host leaves before start", async () => {
    const room = await colyseus.createRoom("tetris_room", {});
    const clients = await Promise.all([
      colyseus.connectTo(room, { name: "One" }),
      colyseus.connectTo(room, { name: "Two" }),
      colyseus.connectTo(room, { name: "Three" }),
    ]);
    const hostEntry = Array.from(room.state.players.values()).find((p) => p.isHost)!;
    assert.ok(hostEntry, "expected a host");
    const hostClient = clients.find((c) => c.sessionId === hostEntry.id)!;
    const expectedSuccessor = Array.from(room.state.players.values()).find(
      (p) => p.id !== hostEntry.id
    )!;
    const events: any[] = [];
    for (const c of clients) {
      if (c.sessionId === hostEntry.id) continue;
      c.onMessage("host_changed", (payload: any) => {
        events.push(payload);
      });
      c.onMessage("player_left", (payload: any) => {
        events.push({ left: payload });
      });
    }
    await hostClient.leave();
    const end = Date.now() + 5000;
    while (events.length < 4 && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const hostChanged = events.find((e) => e.sessionId && e.name);
    assert.ok(hostChanged, "expected host_changed broadcast");
    assert.strictEqual(hostChanged.sessionId, expectedSuccessor.id);
    assert.strictEqual(hostChanged.name, expectedSuccessor.name);
    assert.strictEqual(room.state.players.get(expectedSuccessor.id)!.isHost, true);
    const leftNotice = events.find((e) => e.left);
    assert.ok(leftNotice, "expected player_left broadcast");
    assert.strictEqual(leftNotice.left.name, hostEntry.name);
  });
});
