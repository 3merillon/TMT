import { Lobby, LobbyError } from './lobby';

/** Shared HTTP/WebSocket routing, executed inside a room's durable serialization boundary. */
export function lobbyAction(lobby: Lobby, method: string, url: URL, token: string, body: any): unknown {
  const action = url.pathname.split('/').pop();
  if (method === 'GET') {
    if (action === 'state') {
      const after = Number(url.searchParams.get('after') ?? 0), latency = Number(url.searchParams.get('latency') ?? 0);
      let state = lobby.poll(token, after, latency);
      const checkpoint = url.searchParams.get('checkpoint'), epoch = Number(url.searchParams.get('epoch'));
      if (checkpoint && state.room?.epoch === epoch) {
        lobby.checkpoint(token, { id: checkpoint, epoch }); state = lobby.poll(token, after, latency);
      }
      return state;
    }
    if (action === 'config') return { inRoom: !!lobby.poll(token).room };
  } else if (method === 'POST') {
    switch (action) {
      case 'session': return { token: lobby.admit(body) };
      case 'create': return lobby.create(token, body);
      case 'join': return lobby.join(token, body);
      case 'queue': return lobby.queue(token, body?.setup);
      case 'signal': {
        // A host election can overtake an ICE request in flight. Discard it and ask the sender to refresh.
        const room = lobby.poll(token).room;
        if (room && body?.epoch !== room.epoch) return { retry: true };
        lobby.signal(token, body); break;
      }
      case 'playing': lobby.playing(token); break;
      case 'complete': lobby.complete(token, body?.epoch); break;
      case 'restart': lobby.restart(token, body?.setup); break;
      case 'chat': lobby.chat(token, body?.text); break;
      case 'checkpoint': lobby.checkpoint(token, body); break;
      case 'reconnect': return { token: lobby.reconnect(token, body?.lostWorld === true) };
      case 'handoff': lobby.handoff(token); break;
      case 'leave': lobby.leave(token); break;
      default: throw new LobbyError('Not found.', 404);
    }
    return { ok: true };
  }
  throw new LobbyError('Not found.', 404);
}
