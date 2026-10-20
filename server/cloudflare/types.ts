import type { DurableObjectNamespace, Fetcher } from '@cloudflare/workers-types';
import type { LobbyState, RoomSummary } from '../../src/game/online/protocol';
import type { StoredLobby } from '../lobby';

export interface Env {
  ROOMS: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  ASSETS: Fetcher;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  HUB_ICE_SERVERS?: string;
  HUB_ORIGINS?: string;
  ALLOW_DIRECT_ONLY?: string;
}
export type Member = StoredLobby['members'][number];
export interface Operation { method: string; path: string; token: string; body?: any; ip?: string }
export interface Listing extends RoomSummary { build: string; listed: boolean; revision: number; expires: number }
export interface RoomResult {
  data?: any; error?: string; status?: number;
  listing: Listing | null; revision: number; members: Member[];
}
export interface RoomRecord { lobby: StoredLobby; revision: number; published: number;
  reconnects?: { token: string; id: string; replacement: string; expires: number }[] }
export type PushedState = LobbyState & { revision: number };
export const validCode = (code: unknown): code is string => typeof code === 'string' && /^[A-F0-9]{10}$/.test(code);
export const validToken = (token: string): boolean => /^[\w-]{43}$/.test(token);
export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-v1'));
export const roomStub = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

/** Internal service calls only; these routes are never forwarded from public URLs. */
export async function internal<T>(stub: ReturnType<typeof directory>, path: string, body: unknown): Promise<T> {
  const response = await stub.fetch(`https://internal/${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Coordination service unavailable.');
  return await response.json() as T;
}
