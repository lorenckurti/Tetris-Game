import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState } from "./schema/MyRoomState.js";
import * as fs from 'fs';
import * as path from 'path';

export class MyRoom extends Room {
  maxClients = 4;
  state = new MyRoomState();

  messages = {
    yourMessageType: (client: Client, message: any) => {
      
      if (message === null || message === undefined) return;

      console.log(client.sessionId, 'sent a message:', message);
      try {
        this.broadcast('yourMessageType', { from: client.sessionId, payload: message });
      } catch (e) {
        console.warn('failed to broadcast yourMessageType:', e);
      }
    }
  }

  onCreate (options: any) {

    /**
     * Called when a new room is created.
     */
    console.log('room created', this.roomId, options);

    
    if (typeof options?.initialX === 'number') this.state.x = options.initialX;
    else this.state.x = 0;
    if (typeof options?.initialY === 'number') this.state.y = options.initialY;
    else this.state.y = 0;

    try {
      this.broadcast('room:created', { roomId: this.roomId, state: { x: this.state.x, y: this.state.y } });
    } catch (e) {
      console.warn('failed to broadcast room:created', e);
    }
  }

  onJoin (client: Client, options: any) {
    /**
     * Called when a client joins the room.
     */
    console.log(client.sessionId, "joined!", options);

   
    try {
      client.send('room:state', { x: this.state.x, y: this.state.y });
    } catch (e) {
      console.warn('failed to send room:state to', client.sessionId, e);
    }

    
    try {
      this.broadcast('player:joined', { sessionId: client.sessionId, options });
    } catch (e) {
      console.warn('failed to broadcast player:joined', e);
    }
  }

  onLeave (client: Client, code: CloseCode) {
    /**
     * Called when a client leaves the room.
     */
    console.log(client.sessionId, "left!", code);

    // Notify remaining clients that this player left
    try {
      this.broadcast('player:left', { sessionId: client.sessionId, code });
    } catch (e) {
      console.warn('failed to broadcast player:left', e);
    }
  }

  onDispose() {
    /**
     * Called when the room is disposed.
     */
    console.log("room", this.roomId, "disposing...");

    
    try {
      this.broadcast('room:disposed', { roomId: this.roomId });
    } catch (e) {
      
    }

    
    try {
      const outDir = path.join(process.cwd(), 'data', 'rooms');
      fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, `${this.roomId}.json`);
      const payload = {
        roomId: this.roomId,
        disposedAt: new Date().toISOString(),
        state: { x: this.state.x, y: this.state.y }
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      console.log('room state saved to', filePath);
    } catch (e) {
      console.warn('failed to persist room state on dispose', e);
    }
  }

}
