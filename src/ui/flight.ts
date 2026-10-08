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
  /** Switch between the warp drive and the relativistic rocket. */
  drive(): void;
  /** Put the ship on an approach for a gravity assist past the destination. */
  flyby(): void;
  /** Show or hide the coasting path ahead. */
  path(): void;
  /** Show or hide the gravity well. */
  well(): void;
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
      const action = { KeyX: actions.warp, KeyZ: actions.assist, KeyT: actions.align, KeyG: actions.jump, KeyO: actions.stepOut, KeyV: actions.drive, KeyY: actions.flyby, KeyP: actions.path, KeyH: actions.well, Escape: actions.exit }[e.code];
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
    right.append(tap('Go', actions.warp, 'Fly to the destination, or warp ahead; again to stop (X)'), tap('Assist', actions.assist, 'Flight assist on or off (Z)'), tap('Aim', actions.align, 'Turn toward the target (T)'), tap('Jump', actions.jump, 'Jump to the target (G)'), tap('Out', actions.stepOut, 'Step outside, once landed (O)'), tap('Drive', actions.drive, 'Warp drive or relativistic rocket (V)'), tap('Flyby', actions.flyby, 'Swing past the destination for a gravity assist (Y)'), tap('Well', actions.well, 'Gravity well on or off (H)'));
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
  private readonly gauge: HTMLElement;
  private readonly gaugeDots: SVGCircleElement[] = [];
  private readonly gaugeText: HTMLElement;
  private readonly vignette: HTMLElement;

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
      '<b>Pick a destination</b> by name or click a label, then <b>X</b> to fly there (<b>G</b> jumps there instantly)',
      '<b>X</b> with no destination: warp straight ahead · <b>W / S</b> faster and slower while warping · <b>X</b> again stops',
      '<b>W / S</b> thrust forward and back · <b>A / D</b> sideways · <b>R / F</b> up and down · <b>Shift</b> ×30 thrust',
      '<b>Drag</b> or <b>arrows</b> to turn · <b>Q / E</b> roll · <b>Wheel</b> engine power · <b>T</b> turn toward the destination',
      '<b>V</b> switches to the rocket: real physics near light speed (1 g, time on board runs slow, the sky shifts); the time bar sets time on board',
      '<b>Y</b> sets up a flyby of the destination: coast past it, engines off, and gain (or lose) speed from its gravity',
      '<b>P</b> the path you coast on with the engines off · <b>H</b> the gravity well',
      'Once landed on a solid surface, <b>O</b> steps outside',
      '<b>Z</b> flight assist (holds still when you let go) · <b>Esc</b> leaves the ship',
    ].join('<br>');
    this.help.innerHTML = this.shipHelp;
    helpButton.addEventListener('click', () => { this.help.hidden = !this.help.hidden; });
    // The tides gauge: a ring of loose objects in the cabin, as tides would pull them
    // (stretched toward and away from what pulls, squeezed across it), exaggerated.
    this.gauge = document.createElement('div');
    this.gauge.className = 'flight-tides';
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '-30 -30 60 60');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(svgNs, 'circle');
    ring.setAttribute('r', '16');
    ring.setAttribute('class', 'rest');
    svg.append(ring);
    for (let i = 0; i < 16; i++) {
      const dot = document.createElementNS(svgNs, 'circle');
      dot.setAttribute('r', '1.8');
      svg.append(dot);
      this.gaugeDots.push(dot);
    }
    this.gaugeText = document.createElement('div');
    this.gauge.append(svg, this.gaugeText);
    this.el.prepend(this.gauge);
    this.vignette = document.createElement('div');
    this.vignette.className = 'g-vignette';
    this.el.append(this.lines, helpButton, this.help);
    document.body.append(this.vignette, this.el, this.message);
    for (const name of ['nose', 'prograde', 'retrograde', 'target', 'closest', 'encounter', 'impact']) {
      const m = document.createElement('div');
      m.className = `flight-mark ${name}`;
      m.hidden = true;
      document.body.append(m);
      this.marks.set(name, m);
    }
  }

  /**
   * Draw the tides gauge: `angle` (rad, on screen, counter-clockwise from the right) of
   * the stretch, `ratio` how elongated to draw it (1 = round), `label` under it.
   */
  tides(angle: number, ratio: number, label: string, visible = true): void {
    this.gauge.hidden = !visible;
    if (!visible) return;
    const c = Math.cos(angle), s = Math.sin(angle);
    const across = 1 / Math.sqrt(ratio);
    this.gaugeDots.forEach((dot, i) => {
      const t = (i / this.gaugeDots.length) * 2 * Math.PI;
      const a = Math.cos(t) * 16 * ratio, b = Math.sin(t) * 16 * across;
      dot.setAttribute('cx', (a * c - b * s).toFixed(2));
      dot.setAttribute('cy', (-(a * s + b * c)).toFixed(2));
    });
    if (this.gaugeText.textContent !== label) this.gaugeText.textContent = label;
  }

  /** Darken the edges of the view as the crew would see under a hard push (0..1). */
  strain(level: number): void {
    const v = level.toFixed(3);
    if (this.vignette.style.opacity !== v) this.vignette.style.opacity = v;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
    if (!on) this.strain(0);
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
