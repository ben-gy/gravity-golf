/**
 * net.ts — zero-backend P2P networking for browser games (copied from
 * patterns/). Thin wrapper over Trystero (WebRTC mesh over free public Nostr
 * relays — no server of ours, exactly what GitHub Pages needs).
 *
 * Netcode model: host-authoritative star. Every peer runs the same election
 * (lexicographically smallest peer id) so they independently agree on the host;
 * it re-elects automatically when the host leaves and fires onHostChange.
 *
 * Trystero 0.21's makeAction constrains its payload type to a DataPayload
 * union; our generic channel<T> is more permissive, so makeAction is cast to a
 * loose signature (see patterns note trystero-makeaction-type-cast).
 */

// Default = nostr strategy. To switch: `import { joinRoom, selfId } from 'trystero/torrent'`.
import { joinRoom, selfId } from 'trystero';

export type PeerId = string;
export type NetData = unknown;

export interface NetConfig {
  appId: string;
  roomId: string;
  password?: string;
}

export interface NetHandlers {
  onPeerJoin?: (id: PeerId) => void;
  onPeerLeave?: (id: PeerId) => void;
  onPeers?: (peers: PeerId[], selfId: PeerId) => void;
  onHostChange?: (hostId: PeerId, isSelfHost: boolean) => void;
}

export interface Net {
  readonly selfId: PeerId;
  peers(): PeerId[];
  host(): PeerId;
  isHost(): boolean;
  count(): number;
  channel<T = NetData>(
    name: string,
    onReceive: (data: T, from: PeerId) => void,
  ): (data: T, toPeers?: PeerId | PeerId[]) => void;
  ping(id: PeerId): Promise<number>;
  leave(): void;
}

type LooseAction = [
  (data: unknown, to?: PeerId | PeerId[]) => void,
  (cb: (data: unknown, from: PeerId) => void) => void,
];
type MakeAction = (name: string) => LooseAction;

function electHost(peers: PeerId[]): PeerId {
  return peers.reduce((min, p) => (p < min ? p : min), peers[0]);
}

export function createNet(config: NetConfig, handlers: NetHandlers = {}): Net {
  const room = joinRoom(
    { appId: config.appId, ...(config.password ? { password: config.password } : {}) },
    config.roomId,
  );
  const makeAction = room.makeAction as unknown as MakeAction;

  const sends = new Map<string, (d: NetData, to?: PeerId | PeerId[]) => void>();
  let currentHost: PeerId = selfId;

  const roster = (): PeerId[] => [selfId, ...Object.keys(room.getPeers())].sort();

  function recomputeHost(): void {
    const next = electHost(roster());
    if (next !== currentHost) {
      currentHost = next;
      handlers.onHostChange?.(currentHost, currentHost === selfId);
    }
  }

  handlers.onHostChange?.(currentHost, true);

  room.onPeerJoin((id) => {
    handlers.onPeerJoin?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  room.onPeerLeave((id) => {
    handlers.onPeerLeave?.(id);
    handlers.onPeers?.(roster(), selfId);
    recomputeHost();
  });

  const pending = new Map<string, (rtt: number) => void>();
  const [sendPing, getPing] = makeAction('ping');
  getPing((raw, from) => {
    const msg = raw as { t: number; id: string; pong?: boolean };
    if (msg.pong) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(performance.now() - msg.t);
      }
    } else {
      sendPing({ ...msg, pong: true }, from);
    }
  });

  return {
    selfId,
    peers: roster,
    host: () => currentHost,
    isHost: () => currentHost === selfId,
    count: () => roster().length,

    channel<T = NetData>(name: string, onReceive: (data: T, from: PeerId) => void) {
      if (name.length > 12) {
        throw new Error(`net channel "${name}" exceeds 12 bytes`);
      }
      const existing = sends.get(name);
      if (existing) return existing as (d: T, to?: PeerId | PeerId[]) => void;
      const [send, get] = makeAction(name);
      get((data, from) => onReceive(data as T, from));
      sends.set(name, send as (d: NetData, to?: PeerId | PeerId[]) => void);
      return send as (d: T, to?: PeerId | PeerId[]) => void;
    },

    ping(id: PeerId) {
      return new Promise<number>((resolve) => {
        const pid = `${performance.now()}-${Math.floor(Math.random() * 1e6)}`;
        pending.set(pid, resolve);
        sendPing({ t: performance.now(), id: pid }, id);
        setTimeout(() => {
          if (pending.delete(pid)) resolve(Infinity);
        }, 5000);
      });
    },

    leave() {
      room.leave();
      sends.clear();
      pending.clear();
    },
  };
}

export { selfId };
