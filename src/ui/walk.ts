import type { WalkInput } from '../core/walker';

/**
 * Controls on foot: W/S/A/D to walk, Shift to run, Space to jump, drag or the arrow
 * keys to look around, B to board the ship when it is near, Esc to stop walking. On
 * touch screens, buttons for walking, running and jumping, and drag to look.
 */
export interface WalkActions {
  board(): void;
  exit(): void;
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], KeyS: [0, -1], KeyD: [1, 1], KeyA: [1, -1],
};
const LOOK_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 1], ArrowDown: [1, -1],
};

export class WalkControls {
  active = false;
  private readonly keys = new Set<string>();
  private readonly held = new Set<string>();
  private jumpQueued = false;
  private dragX = 0;
  private dragY = 0;
  readonly pad: HTMLElement;

  constructor(actions: WalkActions) {
    addEventListener('keydown', (e) => {
      if (!this.active || isTyping(e)) return;
      if (e.code in MOVE_KEYS || e.code in LOOK_KEYS || e.code.startsWith('Shift')) {
        this.keys.add(e.code);
        e.preventDefault();
        return;
      }
      if (e.code === 'Space') {
        if (!e.repeat) this.jumpQueued = true;
        e.preventDefault();
        return;
      }
      if (e.repeat) return;
      const action = { KeyB: actions.board, Escape: actions.exit }[e.code];
      if (action) {
        action();
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    this.pad = document.createElement('div');
    this.pad.id = 'walk-pad';
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
    left.append(hold('Walk', 'KeyW', 'Walk forward (W)'), hold('Back', 'KeyS', 'Walk back (S)'), hold('Run', 'ShiftLeft', 'Run (hold Shift)'));
    const right = document.createElement('div');
    right.className = 'pad-group';
    right.append(tap('Jump', () => { this.jumpQueued = true; }, 'Jump (Space)'), tap('Board', actions.board, 'Board the ship (B)'));
    this.pad.append(left, right);
    document.body.append(this.pad);
  }

  /** A drag across the view turns the head (pixels). */
  drag(dx: number, dy: number): void {
    this.dragX += dx;
    this.dragY += dy;
  }

  /** Look change since the last call: drag pixels, plus arrow keys held (radians per second). */
  look(): { dx: number; dy: number; keyYaw: number; keyPitch: number } {
    let keyYaw = 0, keyPitch = 0;
    for (const code of this.keys) {
      const l = LOOK_KEYS[code];
      if (l && l[0] === 0) keyYaw += l[1];
      if (l && l[0] === 1) keyPitch += l[1];
    }
    const out = { dx: this.dragX, dy: this.dragY, keyYaw, keyPitch };
    this.dragX = this.dragY = 0;
    return out;
  }

  input(): WalkInput {
    const move: [number, number] = [0, 0];
    for (const code of [...this.keys, ...this.held]) {
      const m = MOVE_KEYS[code];
      if (m) move[m[0]] = Math.max(-1, Math.min(1, move[m[0]] + m[1]));
    }
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.held.has('ShiftLeft');
    const jump = this.jumpQueued;
    this.jumpQueued = false;
    return { move, run, jump };
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

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
