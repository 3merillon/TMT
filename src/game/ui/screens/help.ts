/** The field manual: current controls, battlefield rules, builds, campaign and online play. */
import { button, segmented } from '../components/controls';
import { el } from '../components/el';
import { collapsible, screenCard, section } from '../components/panel';
import { HELP_BINDING_MODES, helpBindingRows } from '../help-model';
import type { BindingContext } from '../input/bindings';
import type { ScreenContext } from './context';

const paragraph = (text: string) => el('p', { text });

function keyboardHelp(ctx: ScreenContext): HTMLElement {
  let mode: BindingContext = 'drive';
  const detail = el('p', { class: 'field-hint', role: 'status' });
  const rows = el('tbody');
  const table = el('table', { class: 'keys', 'aria-label': 'Your saved keyboard controls' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Keys' }), el('th', { scope: 'col', text: 'Action' }))), rows);
  const draw = () => {
    detail.textContent = HELP_BINDING_MODES.find(item => item.id === mode)!.detail;
    rows.replaceChildren(...helpBindingRows(ctx.profile.settings.controls.bindings, mode).map(binding =>
      el('tr', { 'data-action': binding.action },
        // Each binding is one keycap, including names such as Left Shift and Num Enter.
        el('td', {}, binding.keys.length ? el('div', { class: 'help-keycaps' }, ...binding.keys.map(key => el('kbd', { text: key }))) : el('span', { text: 'Not bound' })),
        el('td', { text: binding.label }))));
  };
  draw();
  return collapsible('help-keyboard', 'Your keyboard controls', false,
    paragraph('These are your saved keys, not a fixed default layout. Choose a mode below: the same key can do different things during aiming, driving and spectating. Key names refer to physical keyboard positions.'),
    segmented('Keyboard control mode', HELP_BINDING_MODES, mode, (next: BindingContext) => { mode = next; draw(); }, 'help-binding-mode'),
    detail, table,
    paragraph('Change them in Settings → Keys. Select a mode, click a key and press its replacement. Delete clears that slot; Escape cancels. Conflicting keys swap within that mode. Each action accepts up to three keys. Reset restores only the selected mode.'),
    paragraph('Not bound means no keyboard shortcut is assigned; use the matching on-screen control or assign a key. Escape always opens or closes the match menu. In menus, Tab moves focus and Enter activates the focused control. Text fields and sliders keep their normal editing keys.'));
}

export function renderHelp(ctx: ScreenContext): HTMLElement {
  return screenCard({
    dismiss: () => ctx.go({ type: 'BACK' }),
    id: 'help', eyebrow: 'A LITTLE FIELD MANUAL', title: 'How to play', size: 'wide',
    subtitle: 'Read the ground. Place your shot. Keep your tank in one piece.',
    body: [
      section('Your first shot',
        paragraph('Start with Artillery Duel against AI, or begin The Unwinding in Campaign. Workshop lets you build a tank and try Drive test before a battle.'),
        paragraph('Click or tap the ground or a visible enemy to choose a target. The gun solves bearing, elevation and power. Check the predicted arc and landing circle, then press your Fire key or the on-screen Fire button. Aiming alone never fires.'),
        paragraph('In classic artillery, fire once and use the short relocation window to reach cover. In campaign and realtime play, drive and aim together, then fire again when your gun has reloaded.')),
      el('div', { class: 'card-columns' },
        collapsible('help-modes', 'Choose a battlefield', false,
          paragraph('Artillery Duel offers Turn-based or Realtime artillery against AI, with 2–4 tanks, free-for-all or 2v2 teams, world and rule choices. Realtime artillery lets you and the bots drive, aim and fire together, with main-gun reloads and no automatic coaxial fire. Choose a realtime AI profile and difficulty before starting.'),
          paragraph('Pass-and-play is turn-based only: choosing it switches combat back to Turn-based. Pass the device when the turn changes. Wind, fog of war and ammunition limits follow the selected rules; the aim timer applies only to turn-based play.'),
          paragraph('Campaign is realtime combat across The Unwinding. Read each briefing and the current objective: missions can require more than destroying enemies. Follow the objective marker and use the field-command panel for repair, your equipped ability and companion orders.'),
          paragraph('Online Play offers Classic artillery, Realtime artillery, Realtime PvP and Campaign co-op. Realtime artillery has simultaneous main-gun fire without automatic coaxial fire. Realtime PvP and campaign add an automatic coaxial gun against nearby enemies in its firing arc.')),
        collapsible('help-turns', 'Turns and realtime', false,
          paragraph('Classic artillery: set your shot during Aim and watch the timer if one is enabled. After firing, use the Driving controls until your relocation time runs out, or choose Hold position to finish moving early. You cannot fire again during this relocation. When your opponent acts, your controls switch to Spectating.'),
          paragraph('Realtime: movement and aiming stay available together while your tank is alive. Each press of Fire requests one shot; wait for the reload indicator to show Ready before firing again. Hold position is a classic relocation command, not a realtime pause.'),
          paragraph('Opening the menu pauses local play. Online matches continue while your menu or Settings is open.'))),
      collapsible('help-aim', 'Aim and read the shot', false,
        paragraph('Bearing turns the turret. Elevation raises or lowers the barrel. Power sets launch speed. Gravity curves the shell around the little planet; wind, when enabled, affects its flight. Fine aim opens the manual bearing, elevation and power sliders.'),
        paragraph('Square brackets mark the requested target; the circle marks the predicted landing. Blocked and out-of-range targets are identified. Dotted arc sections pass behind terrain, and an obscured landing marker is out of sight. Flight limit means the preview found no landing before the shell expires. Recheck your shot after movement or a terrain change.'),
        paragraph('Cycle visible targets, or the Target button, selects the nearest visible enemy first and then cycles by distance. Target tracking lasts until you aim elsewhere or lose sight of that enemy. A last-known marker is an old report, not a current position. Radar, when enabled and charged, can refresh contact reports.')),
      keyboardHelp(ctx),
      el('div', { class: 'card-columns' },
        collapsible('help-mouse', 'Mouse', false,
          paragraph('Left-click or hold and drag over the battlefield to place your target. While holding the left button, wheel up trims range farther and wheel down brings it nearer. Release the button and the wheel zooms the camera.'),
          paragraph('Right-drag to orbit. Focus tank restores the tank view; Overview shows the planet. The camera button switches between them. Use Fire separately to shoot. Manual aim keys and Fine aim sliders remain available.'),
          paragraph('In realtime matches and Drive test, target with the mouse while using your Driving keys to move. Classic relocation only allows movement, not a new shot.')),
        collapsible('help-touch', 'Touch and pen', false,
          paragraph('Tap the ground or an enemy to aim. Drag one finger across the battlefield to orbit; pinch with two fingers to zoom. A drag beginning on your own tank aims by hand: direction sets bearing and distance sets power.'),
          paragraph('Place your left thumb in the lower-left joystick area. It drives during realtime play or relocation, and trims bearing and elevation during turn-based aiming. The slider beside Fire changes power; Target cycles visible enemies.'),
          paragraph('Tap the tank chip for the roster, objective and wind. Fine aim opens the angle sliders and ammunition list. Fire shoots; Hold position ends classic relocation. Use the menu button for Settings.'))),
      el('div', { class: 'card-columns' },
        collapsible('help-gamepad', 'Gamepad', false,
          paragraph('With a standard controller, the left stick drives and the right stick aims during realtime play and Drive test. Either stick aims during your classic aiming turn. During classic relocation, only the left stick moves your tank.'),
          paragraph('RT or RB increases power; LT or LB decreases it. Press A to fire, X for the previous munition and Y for the next. B scans during classic aiming or ends classic relocation. These actions still depend on the current rules, charge, ammunition and reload.'),
          paragraph('Start opens the match menu, right-stick click focuses your tank, and Back/View shows the planet. In menus, use the D-pad to move focus, A to activate and B to return. Buttons use standard gamepad names; printed labels vary by controller.')),
        collapsible('help-driving', 'Drive your way', false,
          paragraph('Settings → Gameplay offers separate driving schemes for the touch joystick and for keyboard/gamepad. Camera driving points where you want to go on screen; the tank steers and can reverse to reach that direction. Tank driving makes forward/reverse follow the hull and left/right steer it.'),
          paragraph('Watch slopes, craters and your hull orientation. Destroyed cover changes both routes and lines of fire. Use the camera controls to inspect the ground before committing to a shot or a move.'))),
      el('div', { class: 'card-columns' },
        collapsible('help-weapons', 'Weapons and survival', false,
          paragraph('The four ammunition slots are high explosive, heavy demolition, incendiary and nuclear. These select shells for your fitted main gun; they do not swap workshop weapons. Your configured Weapon keys and the on-screen ammunition controls choose them. Limited-ammunition rules can leave a slot empty.'),
          paragraph('High explosive is the balanced shell. Heavy demolition flies slower and makes a wider crater. Incendiary creates lingering fire and smoke, with its munition damage applied on impact. Nuclear makes a much larger blast: keep your distance.'),
          paragraph('Armor, impact direction and damaged machinery matter. A disabled main gun in classic artillery changes Fire into a crew repair that spends the turn. Realtime repair uses the field-command button and its displayed kit or charge cost. Seek cover and watch your health, charge and reload indicators.')),
        collapsible('help-workshop', 'Workshop and crew', false,
          paragraph('Workshop saves named builds. Choose compatible hull, running gear, turret, main weapon, utility and armor within the fitting budget. Compare the displayed stats, inspect parts directly on the tank, and use the test options to try a build before taking it into combat.'),
          paragraph('Paint directly on visible metal with the brush, adjust your finish, and use Undo or Eraser to revise the design. There is no stroke-count limit. Choose Save design to keep it; Unsaved changes means the drawing is still only in the editor. Leaving offers Save design, Discard changes or Keep painting. Saved designs are shared automatically in online matches.'),
          paragraph('Special parts can require rank, mission progress or scrap; their cards explain the requirement. Your active build is used when you prepare a new battle. Sandbox lets you inspect and test parts, but its saves last only for that session.'),
          paragraph('Campaign has its own crew and gadget choices on the operations board. Select your available upgrades and mission ability there; read their descriptions and costs. Mission objectives and bonus conditions determine progress and rewards.'))),
      collapsible('help-online', 'Play together', false,
        paragraph('Use Quick Match for a selected versus mode, browse public games, or create a lobby and share its invite code or link. Passworded games require the password too. Everyone needs the same game version. The lobby shows the selected mode and available player slots.'),
        paragraph('Campaign co-op can start with the owner alone and accept up to two helpers during the mission. Only the owner advances campaign stars and unlocks. Helpers earn separate assistance XP and scrap for new or improved results; repeating the same result does not repeatedly pay out.'),
        paragraph('A player hosts the simulation. Hosting can transfer without changing campaign ownership. Recovery can pause play and return to a recent checkpoint. In a two-player versus match, a lost opponent pauses play for a three-minute reconnect window; expiry or explicitly leaving ends it. Three-player versus can continue with two, and co-op can continue after a helper leaves.'),
        paragraph('For a temporary connection problem, return in the same browser and keep your reserved seat. Leave server is an explicit departure. In co-op, an owner who disconnects should reconnect before the party advances to the next mission to receive the completed mission result.')),
      collapsible('help-saves', 'Progress and settings', false,
        paragraph('Builds, crew, rank, scrap, unlocks, campaign stars, cosmetics and settings save in this browser. Campaign checkpoints are separate local saves. Continue can resume a matching saved mission; Restart mission starts fresh and drops its checkpoint.'),
        paragraph('Settings → Profile exports and imports your profile, including remapped keys. Export a backup before importing: import replaces the current profile. Profile exports do not contain an in-progress battle or campaign checkpoint. Browser saves do not follow you to another device or website address.'),
        paragraph('For smoother play, try a lower graphics preset or render scale in Settings → Graphics. Settings → Gameplay includes reduced motion and driving schemes; Audio has separate music, effects, interface and dialogue levels.')),
    ],
    actions: [button('Back to menu', () => ctx.go({ type: 'BACK' }), { id: 'help-back', variant: 'primary', primary: true })],
  });
}
