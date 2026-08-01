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


        app.use("/monitor", monitor());


        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;
