import { RpcSession, type RpcTransport } from "capnweb";
/** qyvr patch 3: the object's `/api` sessions; a socket it holds none for (it restarted) is closed 1012, and the client reconnects. */
export class HeldSockets { #held = new Map<WebSocket, HeldSocketTransport>();
  open(ws: WebSocket, main: (abort: (reason: unknown) => void) => object): void { const t = new HeldSocketTransport(ws); this.#held.set(ws, t); new RpcSession(t, main((e) => t.abort(e))); }
  message(ws: WebSocket, m: string | ArrayBuffer): void { this.#held.get(ws)?.push(m) ?? ws.close(1012, "api session ended: the object restarted"); }
  close(ws: WebSocket, code: number, reason: string): void { this.#held.get(ws)?.end(new Error(`Peer closed WebSocket: ${code} ${reason}`)); this.#held.delete(ws); }
}
class HeldSocketTransport implements RpcTransport {  // Cap'n Web's WebSocketTransport, fed by the object's handlers
  #queue: any[] = []; #wait?: [(m: any) => void, (e: Error) => void]; #error?: Error;
  constructor(private ws: WebSocket) {}
  send(message: string): void { this.ws.send(message); }
  receive(): Promise<string> { return this.#queue.length ? Promise.resolve(this.#queue.shift()) : this.#error ? Promise.reject(this.#error) : new Promise((...w) => { this.#wait = w; }); }
  push(m: string | ArrayBuffer): true { this.#wait ? this.#wait[0](m) : this.#queue.push(m); this.#wait = undefined; return true; }
  end(error: Error): void { this.#error ??= error; this.#wait?.[1](error); this.#wait = undefined; }
  abort(reason: unknown): void { this.end(reason instanceof Error ? reason : new Error(String(reason))); this.ws.close(3000, this.#error!.message.slice(0, 120)); }
}
