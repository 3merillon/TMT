import { activeKit } from '../../meta/profile';
import { CAMPAIGN } from '../../campaign/catalog';
import { continueMission, missionUnlocked } from '../../campaign/progress';
import type { MissionId } from '../../campaign/mission';
import type { OnlineClient } from '../../online/client';
import type { OnlineMode, RoomSummary } from '../../online/protocol';
import { makeOnlineSetup } from '../../online/setup';
import { filterProfanity } from '../../online/profanity';
import { button, select, toggle } from '../components/controls';
import { el } from '../components/el';
import { collapsible, screenCard } from '../components/panel';
import type { ScreenContext } from './context';
import '../online.css';

const MODES = [{ id: 'duel', label: 'Classic artillery · take turns' }, { id: 'artillery', label: 'Realtime artillery · simultaneous shells' }, { id: 'realtime', label: 'Realtime PvP · simultaneous combat' }, { id: 'coop', label: 'Campaign · co-op' }] as const;
type Page = 'home' | 'create' | 'join' | 'browse';
export class OnlineScreen {
  readonly root: HTMLElement;
  private readonly servers = el('div', { class: 'server-list', 'aria-label': 'Available games' });
  private readonly status = el('p', { class: 'online-status', role: 'status' });
  private readonly error = el('p', { class: 'notice error', role: 'alert', hidden: true });
  private readonly room = el('div', { class: 'online-room' });
  private readonly name = field('Your player name', 'online-name', 'Commander', 48);
  private readonly serverName = field('Game name', 'online-server-name', 'Friends on the frontier', 48, 'text', 'username');
  private readonly hostPassword = field('Room password (optional)', 'online-host-password', '', 128, 'password', 'new-password');
  private readonly code = field('Invite code or link', 'online-code', '', 250, 'text', 'username');
  private readonly joinPassword = field('Room password', 'online-join-password', '', 128, 'password', 'current-password');
  private readonly search = field('Find a game', 'online-search', '', 48, 'search');
  private readonly action = button('', () => this.roomAction(), { variant: 'primary', primary: true });
  private readonly actionHint = el('p', { class: 'online-action-hint', id: 'online-action-hint', role: 'status' });
  private readonly choices: HTMLElement;
  private readonly panels: Record<Exclude<Page, 'home'>, HTMLElement>;
  private page: Page = 'home';
  private mode: OnlineMode = 'duel';
  private quickMode: Exclude<OnlineMode, 'coop'> = 'duel';
  private capacity: 2 | 3 = 2;
  private listed = false;
  private mission: MissionId;
  private filter = 'all';
  private showLocked = true;
  private showFull = false;
  private sort = 'latency';
  private readonly disconnect: () => void;
  private listKey = '';
  private roomKey = '';
  private wasInRoom = false;
  constructor(private ctx: ScreenContext, private readonly client: OnlineClient) {
    this.mission = continueMission(ctx.profile);
    const fromLink = new URLSearchParams(location.hash.slice(1)).get('join');
    if (fromLink) { this.code.input.value = fromLink; this.page = 'join'; }
    this.code.input.required = true;
    const join = () => void this.connected(() => {
      let code = this.code.input.value.trim();
      try { code = new URLSearchParams(new URL(code).hash.slice(1)).get('join') ?? code; } catch { /* plain invite code */ }
      return client.join({ code, password: this.joinPassword.input.value, kit: activeKit(this.ctx.profile) });
    });
    const host = () => void this.connected(() => client.create({ name: this.serverName.input.value, password: this.hostPassword.input.value,
      listed: this.listed, capacity: this.capacity, setup: makeOnlineSetup(this.mode, this.capacity, activeKit(this.ctx.profile), this.ctx.skirmish, this.mission) }));
    const modeHint = el('p', { class: 'field-hint' });
    const missionPicker = select('Campaign mission', CAMPAIGN.map(m => ({ id: m.id, label: `${m.chapter} · ${m.title}`, disabled: !missionUnlocked(ctx.profile, m.id) })), this.mission, id => { this.mission = id; }, 'online-mission');
    const fog = toggle('Fog of war', ctx.skirmish.rules.fog, value => ctx.setSkirmish({ ...ctx.skirmish, rules: { ...ctx.skirmish.rules, fog: value } }), { id: 'online-fog' });
    const updateMode = () => {
      missionPicker.hidden = this.mode !== 'coop'; fog.hidden = this.mode === 'coop';
      modeHint.textContent = this.mode === 'coop' ? 'Start on your own or with friends. Up to two friends can join during the mission. The campaign owner keeps progression; guests earn assistance XP without changing their campaign.'
        : this.mode === 'realtime' ? 'Everyone drives and shoots at the same time. All selected player slots must be filled to start.'
        : this.mode === 'artillery' ? 'Everyone moves and fires ballistic shells simultaneously. Choose ammunition, elevation and power; each weapon has a reload cooldown. No turns or automatic machine guns.'
        : 'Take turns aiming and firing. All selected player slots must be filled to start.';
    };
    updateMode();
    const form = (id: string, submit: () => void, ...children: HTMLElement[]) => el('form', {
      id, class: 'online-form', onsubmit: (event: Event) => { event.preventDefault(); if (!client.state.busy && !client.state.room) submit(); },
    }, ...children);
    this.panels = {
      create: form('online-host', host, this.serverName.root,
        el('div', { class: 'online-fields' }, select('Game mode', MODES, this.mode, mode => { this.mode = mode; updateMode(); }, 'online-mode'),
          select('Player slots', [{ id: '2', label: '2 players' }, { id: '3', label: '3 players' }], '2', value => { this.capacity = Number(value) as 2 | 3; }, 'online-capacity')),
        modeHint, missionPicker,
        select('Who can find this game?', [{ id: 'friends', label: 'Friends · invite code or link' }, { id: 'public', label: 'Everyone · public game list' }], 'friends', value => { this.listed = value === 'public'; }, 'online-visibility'),
        this.hostPassword.root, el('p', { class: 'field-hint', text: 'Add a password to require it from everyone joining, even with an invite link.' }), fog),
      join: form('online-friend', join, el('p', { class: 'online-intro', text: 'Ask your friend for their invite code or link. If they set a password, enter it below.' }), this.code.root, this.joinPassword.root),
      browse: el('section', { id: 'online-browse' },
        el('div', { class: 'online-filters' }, this.search.root,
          select('Mode', [{ id: 'all', label: 'All modes' }, ...MODES], 'all', value => { this.filter = value; this.updateList(); }, 'online-filter'),
          button('Refresh', () => void this.connected(() => client.refresh(), false), { id: 'online-refresh', variant: 'quiet' })),
        collapsible('online-filters', 'Filters and sorting', false,
          select('Sort', [{ id: 'latency', label: 'Lowest latency' }, { id: 'newest', label: 'Newest first' }, { id: 'name', label: 'Game name' }], 'latency', value => { this.sort = value; this.updateList(); }, 'online-sort'),
          toggle('Include passworded games', true, value => { this.showLocked = value; this.updateList(); }),
          toggle('Include full / in-progress games', false, value => { this.showFull = value; this.updateList(); })),
        el('p', { class: 'field-hint', text: 'Sorted by estimated latency. Your actual connection latency appears after joining.' }), this.servers),
    };
    const choice = (id: string, title: string, detail: string, click: () => void) => button(
      el('span', {}, el('strong', { text: title }), el('small', { text: detail })), click, { id, class: 'online-choice', variant: 'quiet' });
    this.choices = el('div', { class: 'online-choices' },
      select('Quick Match rules', MODES.filter(m => m.id !== 'coop'), this.quickMode, mode => { this.quickMode = mode; }, 'online-quick-mode'),
      choice('online-quick', 'Quick Match', 'Find an opponent using the selected rules · starts automatically', () => void this.connected(() => client.queue(makeOnlineSetup(this.quickMode, 2, activeKit(this.ctx.profile), this.ctx.skirmish)))),
      choice('online-open-create', 'Create game', 'Choose a mode, invite friends, then start', () => this.show('create')),
      choice('online-open-join', 'Join friend', 'Use an invite code or link and password', () => this.show('join')),
      choice('online-open-browse', 'Browse games', 'Find a public game with an open slot', () => { this.show('browse'); void this.connected(() => client.refresh(), false); }));
    this.search.input.addEventListener('input', () => this.updateList());
    this.root = screenCard({ id: 'online', eyebrow: 'PLAY TOGETHER', title: 'Online Play', size: 'wide', class: 'online-screen', dismiss: () => this.back(),
      body: [this.error, button('Retry connection', () => void client.connect(this.name.input.value), { id: 'online-reconnect', variant: 'quiet' }),
        el('div', { class: 'online-identity' }, this.name.root, this.status), this.choices, ...Object.values(this.panels), this.room],
      actions: [el('div', { class: 'online-footer' }, this.actionHint, this.action,
        el('div', { class: 'online-tools' }, button('Back', () => this.back(), { id: 'online-back', variant: 'quiet' }),
          button('Workshop', () => this.ctx.go({ type: 'OPEN', screen: 'workshop' }), { variant: 'quiet' }),
          button('Settings', () => this.ctx.go({ type: 'OPEN', screen: 'settings' }), { variant: 'quiet' }),
          button('Leave game', () => this.ctx.leaveOnline?.(), { id: 'online-leave', variant: 'danger' })))],
    });
    this.action.setAttribute('aria-describedby', 'online-action-hint');
    this.disconnect = client.subscribe(() => this.update(this.ctx)); this.update(ctx);
    if (client.hasSession && !client.state.connected) void client.connect(this.name.input.value);
  }
  private show(page: Page): void {
    this.page = page; this.update(this.ctx);
    this.root.querySelector('.card-body')!.scrollTop = 0;
    (page === 'join' ? this.code.input : page === 'create' ? this.serverName.input : this.root.querySelector<HTMLElement>('#online-title'))?.focus({ preventScroll: true });
  }
  backToChoices(): boolean { if (this.client.state.room || this.page === 'home') return false; this.show('home'); return true; }
  private back(): void { if (!this.backToChoices()) this.ctx.go({ type: 'BACK' }); }
  private async connected(action: () => Promise<void>, validate = true): Promise<void> {
    if (this.client.state.busy || this.client.state.room) return;
    if (validate) try { this.ctx.validateOnlineBuild?.(); } catch (error) { this.ctx.toast(String(error), 6); return; }
    if (!this.client.state.connected) await this.client.connect(this.name.input.value);
    if (this.client.state.connected && !this.client.state.room) await action();
  }
  private roomAction(): void {
    const room = this.client.state.room; if (!room || this.client.state.busy) return;
    if (room.phase === 'waiting') void this.client.start();
    else if (room.phase === 'finished') this.ctx.rematchOnline?.();
    else this.ctx.resumeOnline?.();
  }
  update(ctx: ScreenContext): HTMLElement {
    this.ctx = ctx; const state = this.client.state, room = state.room;
    if (this.wasInRoom && !room) this.page = 'home';
    this.wasInRoom = !!room;
    const ownName = room?.peers.find(peer => peer.seat === room.seat)?.name;
    if (ownName) this.name.input.value = ownName;
    this.status.textContent = state.busy ? 'Connecting…' : state.connected ? 'Connected · ready to play' : 'Choose an option below. Connection is automatic.';
    this.name.input.disabled = state.connected || state.busy;
    this.root.querySelector<HTMLElement>('.online-identity')!.hidden = !!room;
    this.error.hidden = !state.error; this.error.textContent = state.error ?? '';
    const reconnect = this.root.querySelector<HTMLButtonElement>('#online-reconnect')!;
    reconnect.hidden = !state.error || state.connected; reconnect.disabled = state.busy;
    this.choices.hidden = !!room || this.page !== 'home';
    for (const b of Array.from(this.choices.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select'))) b.disabled = state.busy;
    for (const [page, panel] of Object.entries(this.panels)) panel.hidden = !!room || page !== this.page;
    this.room.hidden = !room;
    this.root.querySelector<HTMLButtonElement>('#online-refresh')!.disabled = state.busy;
    const leave = this.root.querySelector<HTMLButtonElement>('#online-leave')!; leave.hidden = !room; leave.disabled = state.busy; leave.textContent = state.queued ? 'Cancel queue' : 'Leave game';
    this.root.querySelector('#online-title')!.textContent = room ? state.queued ? 'Finding an opponent' : room.phase === 'finished' ? 'Match over' : 'Your game lobby'
      : ({ home: 'Online Play', create: 'Create game', join: 'Join a friend', browse: 'Browse games' } as const)[this.page];
    this.updateAction();
    const roomKey = JSON.stringify([room && [room.code, room.name, room.peers, room.phase, room.host, room.canTransfer, room.players], state.queued, ctx.profile.settings.gameplay.profanityFilter]);
    if (roomKey !== this.roomKey) {
      this.roomKey = roomKey;
      this.room.replaceChildren(...(room ? [el('h3', { text: filterProfanity(room.name, ctx.profile.settings.gameplay.profanityFilter) }),
        el('p', { class: 'online-mode-label', text: `${MODES.find(m => m.id === room.mode)?.label} · ${room.players}/${room.capacity} players` }),
        room.mode === 'coop' ? el('p', { class: 'field-hint', text: 'The room creator owns campaign progress. Helpers earn assistance XP and scrap without changing their own campaign. Hosting may transfer; save ownership does not.' }) : null,
        el('div', { class: 'online-invite' }, el('div', {}, el('small', { text: 'INVITE CODE' }), el('strong', { id: 'online-room-code', text: room.code })),
          button('Copy invite link', () => {
            const url = new URL(location.pathname, location.origin); url.searchParams.set('screen', 'online'); url.hash = `join=${room.code}`;
            void navigator.clipboard.writeText(url.href).then(() => ctx.toast('Invite link copied. Share the password separately.')).catch(() => ctx.toast(`Invite code: ${room.code}`, 8));
          }, { variant: 'brass' })),
        el('p', { class: 'field-hint', text: room.locked ? 'Password required. Share your room password with your friends too.' : 'Anyone with the invite link or code can join an open slot.' }),
        el('ul', { class: 'online-slots' }, ...Array.from({ length: room.capacity }, (_, seat) => {
          const peer = room.peers.find(p => p.seat === seat);
          const owner = room.mode === 'coop' && seat === (room.setup.online?.campaignOwnerSeat ?? 0);
          return el('li', { class: peer ? '' : 'empty' }, el('span', { class: 'online-seat', text: String(seat + 1) }),
            el('strong', { text: peer ? filterProfanity(peer.name, ctx.profile.settings.gameplay.profanityFilter) : owner ? 'Campaign owner' : 'Waiting for a player…' }),
            el('small', { text: peer ? !peer.connected ? 'Reconnecting' : `${peer.seat === room.seat ? 'You · ' : ''}${peer.seat === room.hostSeat ? 'Simulation host' : 'Ready'}${owner ? ' · Campaign owner' : ''}` : owner ? 'Reserved for the owner' : 'Open slot' }));
        })),
        room.host && room.phase === 'playing' ? button('Transfer host', () => void this.client.transfer(), { id: 'online-transfer', variant: 'quiet', disabled: !room.canTransfer, title: 'Available when another player holds a recovery checkpoint' }) : null,
      ] : []).filter(n => n !== null));
    }
    this.updateList(); return this.root;
  }
  private updateAction(): void {
    const { room, queued, busy } = this.client.state;
    this.action.removeAttribute('form'); this.action.type = 'button'; this.action.disabled = busy; this.action.hidden = false;
    let hint = '';
    if (room) {
      this.action.id = room.phase === 'waiting' ? 'online-start' : room.phase === 'finished' ? 'online-rematch' : 'online-resume';
      const missing = Math.max(0, (room.mode === 'coop' ? 1 : room.capacity) - room.players);
      if (queued) { this.action.hidden = true; hint = 'Searching for an opponent… Your match starts automatically. You can visit Workshop or Settings while waiting.'; }
      else if (room.phase === 'waiting') {
        this.action.textContent = 'Start match'; this.action.disabled ||= !room.host || missing > 0;
        hint = missing ? `Waiting for ${missing} more ${missing === 1 ? 'player' : 'players'}. Share the invite link above.`
          : room.host ? 'Everyone is here. Start when you’re ready.' : `Ready! Waiting for ${room.peers.find(p => p.seat === room.hostSeat)?.name ?? 'the host'} to start.`;
        if (!room.host) this.action.hidden = true;
      } else if (room.phase === 'finished') { this.action.textContent = 'Set up next round'; this.action.hidden = !room.host; hint = 'This match has ended. Set up another round or leave to find a new game.'; }
      else { this.action.textContent = 'Return to match'; this.action.hidden = !this.ctx.online;
        hint = room.reconnectUntil ? `Opponent disconnected. Match ends in ${Math.max(0, Math.ceil((room.reconnectUntil - Date.now()) / 1000))}s unless they return.`
          : room.paused ? 'Connection interrupted. Waiting for the shared world to recover…' : 'Your match is in progress.'; }
    } else if (this.page === 'create' || this.page === 'join') {
      this.action.id = this.page === 'create' ? 'online-create' : 'online-join';
      this.action.textContent = this.page === 'create' ? 'Create lobby' : 'Join game'; this.action.type = 'submit';
      this.action.setAttribute('form', this.page === 'create' ? 'online-host' : 'online-friend');
      hint = this.page === 'create' ? 'Next: invite your friends, then start the match.' : 'You’ll enter your friend’s lobby before the match starts.';
    } else { this.action.id = 'online-action'; this.action.hidden = true; }
    this.actionHint.textContent = hint; this.actionHint.hidden = !hint;
  }
  private updateList(): void {
    const state = this.client.state, search = this.search.input.value.toLowerCase().trim();
    let rooms = state.rooms.filter(r => (this.filter === 'all' || r.mode === this.filter) && (this.showLocked || !r.locked)
      && (this.showFull || this.joinable(r)) && (!search || `${r.name} ${r.code}`.toLowerCase().includes(search)));
    rooms = [...rooms].sort((a, b) => this.sort === 'newest' ? b.created - a.created : this.sort === 'name' ? a.name.localeCompare(b.name)
      : (a.latency ?? Infinity) - (b.latency ?? Infinity) || b.created - a.created);
    const key = JSON.stringify([rooms, !!state.room, state.busy, state.latency, this.ctx.profile.settings.gameplay.profanityFilter]); if (key === this.listKey) return; this.listKey = key;
    this.servers.replaceChildren(...(rooms.length ? rooms.map(room => {
      const latency = room.latency === null || state.latency === null ? 'Unknown' : `~${Math.round(room.latency + state.latency)} ms`;
      return el('article', { class: 'server-row' }, el('div', {}, el('strong', { text: filterProfanity(room.name, this.ctx.profile.settings.gameplay.profanityFilter) }),
        el('small', { text: `${MODES.find(m => m.id === room.mode)?.label} · ${room.locked ? 'Password required' : 'Open'} · ${room.phase === 'waiting' ? 'Lobby' : 'In game'}` })),
        el('span', { class: 'server-slots', text: `${room.players}/${room.capacity}` }), el('span', { class: 'server-ping', text: latency }),
        button(room.locked ? 'Enter password' : 'Join game', () => {
          this.code.input.value = room.code; this.joinPassword.input.value = '';
          if (room.locked) { this.show('join'); this.joinPassword.input.focus(); }
          else void this.connected(() => this.client.join({ code: room.code, password: '', kit: activeKit(this.ctx.profile) }));
        }, { disabled: !this.joinable(room) || !!state.room || state.busy, variant: 'quiet' }));
    }) : [el('p', { class: 'online-empty', text: state.busy ? 'Looking for games…' : state.connected ? 'No matching games yet. Create a game and invite a friend, or try Quick Match.' : 'Connecting to the game list…' })]));
  }
  private joinable(room: RoomSummary): boolean { return room.reserved < room.capacity && (room.phase === 'waiting' || room.phase === 'playing' && room.mode === 'coop'); }
  dispose(): void { this.disconnect(); }
}
function field(label: string, id: string, value: string, max: number, type = 'text', autocomplete = 'off') {
  const input = el('input', { class: 'text-input', id, name: id, value, type, maxlength: max, autocomplete, 'aria-label': label });
  return { input, root: el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input) };
}
