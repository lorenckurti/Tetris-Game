import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";


import { MyRoom } from "./rooms/MyRoom.js";
import { TetrisRoom } from "./rooms/TetrisRoom.js";
import { matchMaker } from "@colyseus/core";

const server = defineServer({

    rooms: {
        my_room: defineRoom(MyRoom),
        tetris_room: defineRoom(TetrisRoom)
    },


    express: (app) => {
        app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.header("Access-Control-Allow-Headers", "*");
            if (req.method === "OPTIONS") {
            res.sendStatus(200);
             return;
            }

            next();
        });

        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        // Resolve a short human-friendly room code (e.g. "XJ4K") to the
        // internal Colyseus roomId, using the live room registry. Locked
        // rooms (in-game or full) are never returned.
        app.get("/rooms/by-code/:code", async (req, res) => {
            const code = String(req.params.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
            if (!code) {
                res.status(400).send({ error: "invalid_code" });
                return;
            }
            try {
                const rooms = await matchMaker.query({ name: "tetris_room" });
                const match = rooms.find((room) => {
                    const meta = room.metadata as { code?: unknown } | undefined;
                    return !room.locked && meta?.code === code;
                });
                if (!match) {
                    res.status(404).send({ error: "room_not_found" });
                    return;
                }
                res.send({ roomId: match.roomId, code, clients: match.clients, maxClients: match.maxClients });
            } catch (e) {
                res.status(500).send({ error: "lookup_failed" });
            }
        });


        app.use("/monitor", monitor());


        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;
