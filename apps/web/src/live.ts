// The browser side of a live run: a WebSocket to the server, which applies each move as it is made.
// Moves are queued and sent one at a time, each with the nonce from the server's previous reply.
// The connection reconnects by itself, and on every connect asks for the racer's open run.

export interface RunInfo {
  sessionId: string;
  track: { slug: string; version: number };
  moves: number[];
}

export interface Finished {
  score: number;
  par: number | null;
  best: { rank: number; score: number } | null;
  isBest: boolean;
}

export interface WireState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  turn: number;
}

export type LiveEvent =
  | { type: 'connection'; connected: boolean }
  | ({ type: 'run_started' } & RunInfo)
  | ({ type: 'run_resumed' } & RunInfo)
  | { type: 'no_run' }
  | { type: 'state'; turn: number; state: WireState }
  | ({ type: 'finished' } & Finished)
  | { type: 'error'; code: string; message: string };

const MAX_BACKOFF_MS = 10_000;

export class LiveConnection {
  private ws: WebSocket | undefined;
  private nonce: string | undefined;
  /** Moves the server hasn't acknowledged yet; the first is in flight when `inFlight`. */
  private queue: number[] = [];
  private inFlight = false;
  private pendingStart: { slug: string; version: number } | undefined;
  private retries = 0;
  connected = false;

  constructor(private readonly onEvent: (event: LiveEvent) => void) {}

  connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retries = 0;
      this.connected = true;
      this.onEvent({ type: 'connection', connected: true });
      // A run started while offline goes first; otherwise pick up whatever run is open.
      if (this.pendingStart) this.sendStart();
      else this.send({ type: 'resume' });
    });
    ws.addEventListener('message', (e) => this.receive(JSON.parse(String(e.data)) as LiveEvent & { nonce?: string }));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.nonce = undefined;
      this.inFlight = false;
      this.onEvent({ type: 'connection', connected: false });
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.retries++);
      setTimeout(() => this.connect(), delay);
    });
  }

  /** Starts a new run on the server (replacing any open one), then sends `moves` in order. */
  start(slug: string, version: number, moves: number[]): void {
    this.pendingStart = { slug, version };
    this.queue = [...moves];
    this.inFlight = false;
    this.nonce = undefined;
    if (this.connected) this.sendStart();
  }

  move(move: number): void {
    this.queue.push(move);
    this.flush();
  }

  /** Replaces the unacknowledged moves, e.g. after a resume shows the server is behind. */
  setQueue(moves: number[]): void {
    this.queue = [...moves];
    this.inFlight = false;
    this.flush();
  }

  /** Asks the server for the open run again, to resynchronise. */
  resume(): void {
    this.nonce = undefined;
    this.inFlight = false;
    this.send({ type: 'resume' });
  }

  private sendStart(): void {
    const start = this.pendingStart!;
    this.send({ type: 'start_run', trackSlug: start.slug, trackVersion: start.version });
  }

  private flush(): void {
    if (!this.connected || this.inFlight || !this.nonce || this.queue.length === 0) return;
    this.inFlight = true;
    this.send({ type: 'move', move: this.queue[0], nonce: this.nonce });
    this.nonce = undefined; // single use
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private receive(msg: LiveEvent & { nonce?: string }): void {
    if (msg.type === 'run_started') this.pendingStart = undefined;
    if (msg.type === 'state' || msg.type === 'finished') {
      this.queue.shift();
      this.inFlight = false;
    }
    if (msg.type === 'error') this.inFlight = false;
    if (msg.nonce) this.nonce = msg.nonce;
    this.onEvent(msg);
    this.flush();
  }
}
