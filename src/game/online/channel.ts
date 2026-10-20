import type { LobbyState } from './protocol';

export class OnlineRequestError extends Error { constructor(message: string, readonly status = 503) { super(message); } }
export type SocketState = LobbyState & { revision: number };
/** Ordered room RPC and push updates. An ambiguous mutation is never automatically replayed. */
export class RoomChannel {
  private socket: WebSocket;
  private serial = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  readonly opened: Promise<void>;
  constructor(base: string, readonly code: string, token: string, push: (state: SocketState) => void, lost: () => void,
    create: (url: string, protocols: string[]) => WebSocket = (url, protocols) => new WebSocket(url, protocols)) {
    const url = new URL(`${base}/api/online/socket`, globalThis.location?.href ?? 'http://localhost');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('room', code);
    this.socket = create(url.toString(), ['tmt-v1', `auth.${token}`]);
    this.opened = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Room connection timed out.')); this.close(); }, 8000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('close', () => { clearTimeout(timeout); reject(new Error('Room connection closed.')); }, { once: true });
    });
    this.socket.addEventListener('message', event => {
      if (this.stopped || typeof event.data !== 'string' || event.data.length > 1_000_000) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state' && Number.isSafeInteger(message.data?.revision)) push(message.data);
        else if (message.type === 'reply') {
          const pending = this.pending.get(message.id); if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new OnlineRequestError(message.error, message.status)); else pending.resolve(message.data);
        }
      } catch { this.socket.close(1008, 'Invalid room response'); }
    });
    this.socket.addEventListener('close', () => { this.rejectPending(); if (!this.stopped) lost(); });
    this.socket.addEventListener('error', () => { /* close provides the single recovery notification */ });
  }
  get connected(): boolean { return !this.stopped && this.socket.readyState === 1; }
  request<T>(path: string, body?: unknown): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('Room connection is interrupted.'));
    if (this.pending.size >= 16 || this.socket.bufferedAmount > 128_000) return Promise.reject(new Error('Room connection is busy.'));
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Room response timed out.')); this.socket.close(4000, 'Response timeout'); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, path, ...(body === undefined ? {} : { body }) })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  private rejectPending(): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Room connection interrupted. Check the current room before retrying.')); }
    this.pending.clear();
  }
  close(): void { this.stopped = true; this.rejectPending(); this.socket.close(); }
}
