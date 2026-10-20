import type { KitLoadoutIds, MatchSetup } from '../api/match';
import type { PlayerCommand } from '../api/session';

export const ONLINE_PROTOCOL = 1;
declare const __ONLINE_BUILD__: string;
export const ONLINE_BUILD = typeof __ONLINE_BUILD__ === 'string' ? __ONLINE_BUILD__ : 'test';
export type RoomPhase = 'waiting' | 'connecting' | 'playing' | 'finished';
export type OnlineMode = 'duel' | 'artillery' | 'realtime' | 'coop';
export interface RoomSummary {
  code: string; name: string; locked: boolean; players: number; reserved: number; capacity: number; phase: RoomPhase;
  mode: OnlineMode; created: number; latency: number | null;
}
export interface Room extends RoomSummary {
  host: boolean; seat: number; hostSeat: number; epoch: number; setup: MatchSetup;
  peers: { seat: number; name: string; connected: boolean; generation: number }[];
  checkpoint: string | null; paused: boolean; canTransfer: boolean;
  ownCheckpoint?: string | null;
  reconnectUntil?: number;
  ended?: { reason: 'opponent-left' | 'reconnect-timeout'; winner: number };
}
export type Signal = { description: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit } | { candidates: RTCIceCandidateInit[] };
export interface ChatMessage { id: number; seat: number; name: string; text: string; at: number }
export interface LobbyState { room: Room | null; rooms: RoomSummary[]; queued: boolean; signals: { id: number; from: number; generation: number; toGeneration: number; epoch: number; value: Signal }[]; chat: ChatMessage[] }
export interface Admission { token: string; iceServers: RTCIceServer[]; iceExpiresAt?: number; transport?: 'websocket' }
export interface PlayerIdentity { name: string; build: string; protocol: number }
export interface JoinRequest { code: string; password: string; kit: KitLoadoutIds }
export interface CreateRequest { name: string; password: string; listed: boolean; setup: MatchSetup; capacity: 2 | 3 }
export interface OrderedCommand { tank: number; c: PlayerCommand }
export interface PeerMessage { kind: string; epoch: number; [key: string]: unknown }
