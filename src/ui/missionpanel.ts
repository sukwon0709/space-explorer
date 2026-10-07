import type { Mission } from './missions';

/** A moment on a mission (src/generated/missions.json, scripts/build-missions.mjs). */
export interface Moment {
  tdb: number;
  utc: string;
  title: string;
  /** The body passed, with distance from its centre and altitude above it (km), and relative speed (km/s). */
  body?: number;
  distance?: number;
  altitude?: number;
  speed?: number;
  /** Speed around the Sun before and after a gravity assist, km/s. */
  assist?: [number, number];
  key?: boolean;
}

export interface MissionData {
  start: number;
  end: number;
  rows: number;
  moments: Moment[];
}

export interface PanelActions {
  jump(moment: Moment): void;
  seek(tdb: number): void;
  pace(on: boolean): void;
  follow(): void;
  close(): void;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The mission panel: the mission's story in one line, a chart of its speed around the
 * Sun through the whole flight (each gravity assist is a step in it), its moments to
 * jump to, and the pacing switch.
 */
export class MissionPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly select: HTMLSelectElement;
  private readonly paceButton: HTMLButtonElement;
  private readonly note: HTMLElement;
  private chart?: { speeds: Float32Array; times: Float64Array; max: number; moments: Moment[]; start: number; end: number };
  private moments: Moment[] = [];
  private paced = true;

  constructor(root: HTMLElement, actions: PanelActions) {
    this.root = root;
    root.hidden = true;
    root.innerHTML = `
      <div class="mission-head"><span class="mission-title"></span><button class="mission-close" title="Leave the mission">×</button></div>
      <div class="mission-summary"></div>
      <canvas class="mission-chart" width="680" height="150" title="Speed around the Sun over the mission; click to go to that date"></canvas>
      <div class="mission-controls">
        <select class="mission-moments" aria-label="Go to a moment of the mission"></select>
        <button class="mission-pace" title="Speed time up in quiet cruise and slow it down near planets">Auto pace</button>
        <button class="mission-follow" title="Back to the spacecraft">Follow</button>
      </div>
      <div class="mission-note"></div>`;
    this.title = root.querySelector('.mission-title')!;
    this.summary = root.querySelector('.mission-summary')!;
    this.canvas = root.querySelector('.mission-chart')!;
    this.select = root.querySelector('.mission-moments')!;
    this.paceButton = root.querySelector('.mission-pace')!;
    this.note = root.querySelector('.mission-note')!;
    root.querySelector('.mission-close')!.addEventListener('click', () => actions.close());
    root.querySelector('.mission-follow')!.addEventListener('click', () => actions.follow());
    this.paceButton.addEventListener('click', () => {
      this.setPace(!this.paced);
      actions.pace(this.paced);
    });
    this.select.addEventListener('change', () => {
      const m = this.moments[Number(this.select.value)];
      this.select.value = '';
      this.select.blur();
      if (m) actions.jump(m);
    });
    this.canvas.addEventListener('click', (e) => {
      if (!this.chart) return;
      const r = this.canvas.getBoundingClientRect();
      const f = (e.clientX - r.left) / r.width;
      actions.seek(this.chart.start + f * (this.chart.end - this.chart.start));
    });
  }

  open(mission: Mission, data: MissionData, speeds: { times: Float64Array; speeds: Float32Array }): void {
    this.root.hidden = false;
    this.title.textContent = mission.name;
    this.summary.textContent = mission.summary;
    this.moments = data.moments;
    this.select.replaceChildren();
    const head = document.createElement('option');
    head.value = '';
    head.textContent = 'Moments…';
    this.select.append(head);
    const key = document.createElement('optgroup');
    key.label = 'Highlights';
    const rest = document.createElement('optgroup');
    rest.label = 'Every pass';
    data.moments.forEach((m, k) => {
      const o = document.createElement('option');
      o.value = String(k);
      o.textContent = `${day(m.utc)} · ${m.title}`;
      (m.key ? key : rest).append(o);
    });
    this.select.append(key);
    if (rest.children.length) this.select.append(rest);
    let max = 0;
    for (const s of speeds.speeds) max = Math.max(max, s);
    this.chart = { ...speeds, max, moments: data.moments.filter((m) => m.key && m.body !== undefined), start: data.start, end: data.end };
    this.setPace(true);
  }

  close(): void {
    this.root.hidden = true;
    this.chart = undefined;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setPace(on: boolean): void {
    this.paced = on;
    this.paceButton.classList.toggle('active', on);
  }

  /** Redraw the chart with the current time, and the note line. */
  update(tdb: number, note: string): void {
    if (this.note.textContent !== note) this.note.textContent = note;
    const c = this.chart;
    if (!c) return;
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    const pad = 18;
    g.clearRect(0, 0, W, H);
    const x = (t: number) => ((t - c.start) / (c.end - c.start)) * W;
    const y = (v: number) => H - pad - (v / (c.max * 1.08)) * (H - 2 * pad);
    // Moments with a body: thin ticks.
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 2;
    for (const m of c.moments) {
      g.beginPath();
      g.moveTo(x(m.tdb), pad);
      g.lineTo(x(m.tdb), H - pad);
      g.stroke();
    }
    g.strokeStyle = '#7fb0ff';
    g.lineWidth = 3;
    g.beginPath();
    for (let k = 0; k < c.times.length; k++) {
      const px = x(c.times[k]), py = y(c.speeds[k]);
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
    g.fillStyle = 'rgba(232,236,242,0.7)';
    g.font = '22px system-ui, sans-serif';
    g.fillText(`${Math.round(c.max)} km/s`, 6, pad + 4);
    g.fillText('speed around the Sun', W - 230, pad + 4);
    // Now.
    if (tdb >= c.start && tdb <= c.end) {
      g.strokeStyle = '#ffd27a';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x(tdb), 4);
      g.lineTo(x(tdb), H - 4);
      g.stroke();
    }
  }
}
