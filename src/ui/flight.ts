import type { Vec3 } from '../core/ephemeris';
import type { ShipInput } from '../core/flight';

/**
 * The pilot's controls: keyboard and mouse on a computer, on-screen buttons and drag to
 * steer on a phone. Holds which keys are down; main.ts reads `input()` each frame.
 */
export interface FlightActions {
  warp(): void;
  assist(): void;
  align(): void;
  jump(): void;
  stepOut(): void;
  exit(): void;
}

const THRUST_KEYS: Record<string, [number, number]> = {
  KeyD: [0, 1], KeyA: [0, -1],
  KeyR: [1, 1], Space: [1, 1], KeyF: [1, -1], KeyC: [1, -1],
  KeyW: [2, 1], KeyS: [2, -1],
};
const TURN_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, 1], ArrowDown: [0, -1], KeyI: [0, 1], KeyK: [0, -1],
  ArrowRight: [1, 1], ArrowLeft: [1, -1], KeyL: [1, 1], KeyJ: [1, -1],
  KeyE: [2, 1], KeyQ: [2, -1],
};

export class FlightControls {
  active = false;
  /** Set when a turn key is pressed: cancels an automatic turn toward the target. */
  turned = false;
  private readonly keys = new Set<string>();
  private readonly held = new Set<string>();
  private dragX = 0;
  private dragY = 0;
  private wheel = 0;
  readonly pad: HTMLElement;

  constructor(actions: FlightActions) {
    addEventListener('keydown', (e) => {
      if (!this.active || isTyping(e)) return;
      if (e.code in THRUST_KEYS || e.code in TURN_KEYS || e.code.startsWith('Shift')) {
        this.keys.add(e.code);
        if (e.code in TURN_KEYS) this.turned = true;
        e.preventDefault();
        return;
      }
      if (e.repeat) return;
      const action = { KeyX: actions.warp, KeyZ: actions.assist, KeyT: actions.align, KeyG: actions.jump, KeyO: actions.stepOut, Escape: actions.exit }[e.code];
      if (action) {
        action();
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    // On-screen buttons, for touch screens (and anyone without a keyboard).
    this.pad = document.createElement('div');
    this.pad.id = 'flight-pad';
    this.pad.hidden = true;
    const hold = (label: string, key: string, title: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('pointerdown', (e) => { this.held.add(key); b.setPointerCapture(e.pointerId); e.preventDefault(); });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => this.held.delete(key));
      return b;
    };
    const tap = (label: string, run: () => void, title: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', run);
      return b;
    };
    const left = document.createElement('div');
    left.className = 'pad-group';
    left.append(hold('Thrust', 'KeyW', 'Forward thrust (W)'), hold('Reverse', 'KeyS', 'Reverse thrust (S)'), hold('⟲', 'KeyQ', 'Roll left (Q)'), hold('⟳', 'KeyE', 'Roll right (E)'));
    const right = document.createElement('div');
    right.className = 'pad-group';
    right.append(tap('Warp', actions.warp, 'Warp drive on or off (X)'), tap('Assist', actions.assist, 'Flight assist on or off (Z)'), tap('Aim', actions.align, 'Turn toward the target (T)'), tap('Jump', actions.jump, 'Jump to the target (G)'), tap('Out', actions.stepOut, 'Step outside, once landed (O)'));
    this.pad.append(left, right);
    document.body.append(this.pad);
  }

  /** A drag across the view steers (pixels). */
  drag(dx: number, dy: number): void {
    this.dragX += dx;
    this.dragY += dy;
    if (dx || dy) this.turned = true;
  }

  scroll(deltaY: number): void {
    this.wheel += deltaY;
  }

  /** Drag since the last call (pixels), and wheel notches. */
  take(): { dx: number; dy: number; wheel: number } {
    const out = { dx: this.dragX, dy: this.dragY, wheel: this.wheel };
    this.dragX = this.dragY = this.wheel = 0;
    return out;
  }

  input(warping: boolean): ShipInput {
    const thrust: Vec3 = [0, 0, 0];
    const turn: Vec3 = [0, 0, 0];
    for (const code of [...this.keys, ...this.held]) {
      const t = THRUST_KEYS[code];
      if (t) thrust[t[0]] = Math.max(-1, Math.min(1, thrust[t[0]] + t[1]));
      const r = TURN_KEYS[code];
      if (r) turn[r[0]] = Math.max(-1, Math.min(1, turn[r[0]] + r[1]));
    }
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (warping) return { thrust: [0, 0, 0], turn, boost, warp: thrust[2] };
    return { thrust, turn, boost, warp: 0 };
  }

  show(on: boolean): void {
    this.active = on;
    if (!on) {
      this.keys.clear();
      this.held.clear();
    }
    this.pad.hidden = !on;
  }
}

/**
 * The cockpit display: readouts, short messages, and markers on the view (the nose, the
 * direction of travel, the target).
 */
export class FlightHud {
  readonly el: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly message: HTMLElement;
  private readonly help: HTMLElement;
  private readonly marks = new Map<string, HTMLElement>();
  private messageUntil = 0;
  readonly shipHelp: string;

  constructor() {
    this.el = document.createElement('section');
    this.el.id = 'flight';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Ship');
    this.lines = document.createElement('div');
    this.lines.className = 'flight-lines';
    this.message = document.createElement('div');
    this.message.className = 'flight-message';
    this.message.setAttribute('aria-live', 'polite');
    const helpButton = document.createElement('button');
    helpButton.className = 'flight-help-button';
    helpButton.textContent = 'Controls';
    this.help = document.createElement('div');
    this.help.className = 'flight-help';
    this.help.hidden = true;
    this.shipHelp = [
      '<b>W / S</b> thrust forward and back · <b>A / D</b> sideways · <b>R / F</b> up and down',
      '<b>Drag</b> or <b>arrows</b> to turn · <b>Q / E</b> roll · <b>Shift</b> ×10 thrust · <b>Wheel</b> engine power',
      '<b>Z</b> flight assist (holds still when you let go) · <b>X</b> warp drive, then <b>W / S</b> faster and slower',
      'Pick a destination by name or click a label, then <b>T</b> to turn toward it, <b>X</b> to warp there or <b>G</b> to jump straight there',
      'Once landed on the Moon, Mars or Earth, <b>O</b> steps outside',
      '<b>Esc</b> leaves the ship',
    ].join('<br>');
    this.help.innerHTML = this.shipHelp;
    helpButton.addEventListener('click', () => { this.help.hidden = !this.help.hidden; });
    this.el.append(this.lines, helpButton, this.help);
    document.body.append(this.el, this.message);
    for (const name of ['nose', 'prograde', 'retrograde', 'target']) {
      const m = document.createElement('div');
      m.className = `flight-mark ${name}`;
      m.hidden = true;
      document.body.append(m);
      this.marks.set(name, m);
    }
  }

  show(on: boolean): void {
    this.el.hidden = !on;
    if (!on) for (const m of this.marks.values()) m.hidden = true;
    if (!on) this.message.textContent = '';
  }

  /** Replace the controls list (on foot it differs from the ship's). */
  setHelp(html: string): void {
    this.help.innerHTML = html;
  }

  set(lines: string[]): void {
    const text = lines.join('\n');
    if (this.lines.textContent !== text) this.lines.textContent = text;
  }

  say(text: string, seconds = 4): void {
    this.message.textContent = text;
    this.messageUntil = performance.now() / 1000 + seconds;
  }

  tick(now: number): void {
    if (this.message.textContent && now > this.messageUntil) this.message.textContent = '';
  }

  /**
   * Place a marker at screen point (x, y); `edge` pins it to the screen's edge, pointing
   * toward something off screen or behind.
   */
  mark(name: string, x: number, y: number, visible: boolean, label = '', edge = false): void {
    const m = this.marks.get(name)!;
    m.hidden = !visible;
    if (!visible) return;
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    m.classList.toggle('edge', edge);
    if (m.textContent !== label) m.textContent = label;
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
