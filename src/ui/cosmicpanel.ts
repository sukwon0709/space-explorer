/**
 * The cosmic event panel: what is happening in one line, a chart of the event's own
 * measure (the supernova's light curve against what was measured, the young star's
 * light and growth, the merger's wave against what LIGO recorded), a timeline to drag,
 * play and pacing, and for the merger the chirp to listen to.
 */
export interface CosmicPanelActions {
  /** Seek to a point on the timeline, 0..1. */
  seek(u: number): void;
  play(on: boolean): void;
  pace(on: boolean): void;
  listen?(): void;
  close(): void;
}

export interface CosmicChart {
  /** x range and label, y range and label. */
  x: [number, number];
  y: [number, number];
  xLabel: string;
  yLabel: string;
  /** Lines: points [x, y], colour. */
  lines: Array<{ points: Array<[number, number]>; color: string; label: string }>;
  /** Measured points. */
  dots?: Array<{ points: Array<[number, number]>; color: string; label: string }>;
  /** Tick values on x and how to print them. */
  ticks?: Array<[number, string]>;
}

export class CosmicPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly slider: HTMLInputElement;
  private readonly playButton: HTMLButtonElement;
  private readonly paceButton: HTMLButtonElement;
  private readonly listenButton: HTMLButtonElement;
  private readonly note: HTMLElement;
  private chart?: CosmicChart;
  private playing = true;
  private paced = true;
  private dragging = false;
  key?: string;

  constructor(root: HTMLElement, private readonly actions: CosmicPanelActions) {
    this.root = root;
    root.hidden = true;
    root.innerHTML = `
      <div class="mission-head"><span class="mission-title"></span><button class="mission-close" title="Leave the event">×</button></div>
      <div class="mission-summary"></div>
      <canvas class="cosmic-chart" width="680" height="220"></canvas>
      <input class="cosmic-time" type="range" min="0" max="1000" step="1" aria-label="Time in the event">
      <div class="mission-controls">
        <button class="cosmic-play" title="Play or pause the event">Pause</button>
        <button class="cosmic-pace" title="Slow down when things happen fast, speed up when they are slow">Auto pace</button>
        <button class="cosmic-listen" title="The wave as sound: LIGO's frequencies are audible">Listen</button>
      </div>
      <div class="mission-note"></div>`;
    this.title = root.querySelector('.mission-title')!;
    this.summary = root.querySelector('.mission-summary')!;
    this.canvas = root.querySelector('.cosmic-chart')!;
    this.slider = root.querySelector('.cosmic-time')!;
    this.playButton = root.querySelector('.cosmic-play')!;
    this.paceButton = root.querySelector('.cosmic-pace')!;
    this.listenButton = root.querySelector('.cosmic-listen')!;
    this.note = root.querySelector('.mission-note')!;
    root.querySelector('.mission-close')!.addEventListener('click', () => actions.close());
    this.playButton.addEventListener('click', () => {
      this.setPlaying(!this.playing);
      actions.play(this.playing);
    });
    this.paceButton.addEventListener('click', () => {
      this.paced = !this.paced;
      this.paceButton.classList.toggle('active', this.paced);
      actions.pace(this.paced);
    });
    this.listenButton.addEventListener('click', () => this.actions.listen?.());
    this.slider.addEventListener('pointerdown', () => (this.dragging = true));
    this.slider.addEventListener('pointerup', () => (this.dragging = false));
    this.slider.addEventListener('input', () => actions.seek(Number(this.slider.value) / 1000));
  }

  open(key: string, title: string, summary: string, chart: CosmicChart, canListen: boolean): void {
    this.key = key;
    this.root.hidden = false;
    this.title.textContent = title;
    this.summary.textContent = summary;
    this.chart = chart;
    this.listenButton.hidden = !canListen;
    this.setPlaying(true);
    this.paced = true;
    this.paceButton.classList.add('active');
  }

  close(): void {
    this.root.hidden = true;
    this.key = undefined;
    this.chart = undefined;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.playButton.textContent = on ? 'Pause' : 'Play';
  }

  /** Redraw with the current moment: its x on the chart and place on the timeline (0..1). */
  update(x: number, u: number, note: string): void {
    if (this.note.textContent !== note) this.note.textContent = note;
    if (!this.dragging) this.slider.value = String(Math.round(Math.min(1, Math.max(0, u)) * 1000));
    const c = this.chart;
    if (!c) return;
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    const left = 46, right = 10, top = 22, bottom = 30;
    g.clearRect(0, 0, W, H);
    const px = (v: number) => left + ((v - c.x[0]) / (c.x[1] - c.x[0])) * (W - left - right);
    const py = (v: number) => H - bottom - ((v - c.y[0]) / (c.y[1] - c.y[0])) * (H - top - bottom);
    g.font = '16px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    for (const [v, label] of c.ticks ?? []) {
      g.beginPath();
      g.moveTo(px(v), top);
      g.lineTo(px(v), H - bottom);
      g.stroke();
      g.fillText(label, px(v) - g.measureText(label).width / 2, H - 8);
    }
    g.save();
    g.translate(14, H / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(c.yLabel, -g.measureText(c.yLabel).width / 2, 0);
    g.restore();
    g.fillText(c.xLabel, W - right - g.measureText(c.xLabel).width, top - 6);
    g.save();
    g.beginPath();
    g.rect(left, top, W - left - right, H - top - bottom);
    g.clip();
    for (const d of c.dots ?? []) {
      g.fillStyle = d.color;
      for (const [a, b] of d.points) {
        g.beginPath();
        g.arc(px(a), py(b), 2.6, 0, 2 * Math.PI);
        g.fill();
      }
    }
    for (const line of c.lines) {
      g.strokeStyle = line.color;
      g.lineWidth = 2;
      g.beginPath();
      line.points.forEach(([a, b], k) => (k ? g.lineTo(px(a), py(b)) : g.moveTo(px(a), py(b))));
      g.stroke();
    }
    g.restore();
    // Legend.
    let lx = left + 6;
    for (const item of [...c.lines, ...(c.dots ?? [])]) {
      g.fillStyle = item.color;
      g.fillRect(lx, 6, 12, 4);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillText(item.label, lx + 16, 14);
      lx += 26 + g.measureText(item.label).width;
    }
    // Now.
    g.strokeStyle = '#ffd27a';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px(x), top);
    g.lineTo(px(x), H - bottom);
    g.stroke();
  }
}
