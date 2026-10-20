import { expect, it, vi } from 'vitest';
import { PeerLink } from '../src/game/online/peer';
import { WireDecoder } from '../src/game/online/wire';

it('applies renewed TURN credentials to existing peer connections without replacing the transport', () => {
  const setConfiguration = vi.fn(), close = vi.fn(), failed = vi.fn();
  class FakeConnection {
    getConfiguration() { return { bundlePolicy: 'balanced', iceServers: [] }; }
    setConfiguration = setConfiguration;
    close = close;
  }
  vi.stubGlobal('RTCPeerConnection', FakeConnection);
  const link = new PeerLink(false, [], async () => {}, failed);
  try {
    const renewed = [{ urls: 'turns:relay.test:443', username: 'renewed', credential: 'temporary' }];
    link.updateIce(renewed);
    expect(setConfiguration).toHaveBeenCalledWith({ bundlePolicy: 'balanced', iceServers: renewed });
    expect(close).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    link.close(); link.updateIce(renewed); expect(setConfiguration).toHaveBeenCalledTimes(1);
  } finally { link.close(); vi.unstubAllGlobals(); }
});

it('prioritizes inputs and live snapshots before a large recovery finishes and bounds the SCTP backlog', async () => {
  const sent: string[] = [], failed = vi.fn();
  const channel = { label: 'tmt-duel-v1', readyState: 'open', bufferedAmount: 0, onopen: () => {}, onbufferedamountlow: () => {},
    send(value: string) { sent.push(value); this.bufferedAmount += value.length; }, close() {} };
  class FakeConnection { close() {} }
  vi.stubGlobal('RTCPeerConnection', FakeConnection);
  const link = new PeerLink(false, [], async () => {}, failed);
  try {
    (link as any).bind(channel); channel.onopen(); await link.opened;
    link.send({ kind: 'recovery', epoch: 1, id: 'bulk', text: 'x'.repeat(1_000_000) });
    link.send({ kind: 'appearance-blob', epoch: 1, id: 'paint', data: 'z'.repeat(1_000_000) });
    expect(channel.bufferedAmount).toBeLessThan(80_000); expect(link.busy).toBe(false);
    link.send({ kind: 'snapshot', epoch: 1, seq: 1, text: 'y'.repeat(30_000) });
    link.send({ kind: 'input', epoch: 1, seq: 2, command: { k: 'fire' } });
    while ((link as any).output.length) { channel.bufferedAmount = 0; channel.onbufferedamountlow(); }
    const decoder = new WireDecoder(), delivered = sent.map(raw => decoder.decode(raw)).filter(Boolean) as { kind: string }[];
    expect(delivered.map(m => m.kind)).toEqual(['input', 'snapshot', 'recovery', 'appearance-blob']);
    expect(failed).not.toHaveBeenCalled();
  } finally { link.close(); vi.unstubAllGlobals(); }
});

it('cancels stale negotiation before an offer can signal to a departed room', async () => {
  let resolve!: (value: RTCSessionDescriptionInit) => void;
  const signal = vi.fn(async () => {}), setLocalDescription = vi.fn(async () => {});
  class FakeConnection {
    createDataChannel() { return { close() {} }; }
    createOffer() { return new Promise<RTCSessionDescriptionInit>(r => { resolve = r; }); }
    setLocalDescription = setLocalDescription;
    close() {}
  }
  vi.stubGlobal('RTCPeerConnection', FakeConnection);
  const link = new PeerLink(true, [], signal, vi.fn()); link.close();
  resolve({ type: 'offer', sdp: 'obsolete' }); await Promise.resolve(); await Promise.resolve();
  expect(setLocalDescription).not.toHaveBeenCalled(); expect(signal).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

it('forces relay only when requested and exposes candidate types without addresses or credentials', async () => {
  const configurations: RTCConfiguration[] = [];
  class FakeConnection {
    constructor(configuration: RTCConfiguration) { configurations.push(configuration); }
    close() {}
    async getStats() { return new Map([['transport', { type: 'transport', selectedCandidatePairId: 'pair' }], ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote' }],
      ['local', { candidateType: 'relay', protocol: 'udp', address: 'private', username: 'secret' }], ['remote', { candidateType: 'relay', address: 'private' }]]); }
  }
  vi.stubGlobal('RTCPeerConnection', FakeConnection); vi.stubGlobal('location', { search: '?relay=1' });
  expect(() => new PeerLink(false, [], async () => {}, vi.fn())).toThrow(/TURN credentials/);
  const link = new PeerLink(false, [{ urls: 'turn:relay.test', username: 'secret', credential: 'secret' }], async () => {}, vi.fn());
  try {
    expect(configurations[0].iceTransportPolicy).toBe('relay');
    expect(await link.transportInfo()).toEqual({ local: 'relay', remote: 'relay', protocol: 'udp' });
  } finally { link.close(); vi.unstubAllGlobals(); }
});
