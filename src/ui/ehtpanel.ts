import type { BlackHole } from '../core/blackholes';
import { blur, modelImage, ringDiameter } from '../core/ehtimage';

/** What pipeline/fetch_blackholes.py records about each EHT image. */
export interface EhtMeta {
  /** Width of the crop, microarcseconds. */
  field: number;
  ring: number;
  credit: string;
  licence: string;
  source: string;
}

/** The EHT's effective resolution (the blurring kernel of their published images), microarcseconds. */
export const EHT_BEAM = 20;
const N = 64;

/**
 * Side by side: the EHT's image of the black hole and the app's model of the same
 * patch of sky, blurred to the EHT's resolution, at the same scale.
 */
export class EhtPanel {
  private current?: string;
  private readonly models = new Map<string, HTMLCanvasElement>();

  constructor(private readonly el: HTMLElement, private readonly meta: Record<string, EhtMeta>, private readonly base: string) {}

  show(bh: BlackHole | undefined): void {
    const key = bh?.eht?.image.replace(/\.jpg$/, '');
    if (key === this.current) return;
    this.current = key;
    this.el.replaceChildren();
    this.el.hidden = !key || !this.meta[key];
    if (!bh || !key || !this.meta[key]) return;
    const m = this.meta[key];
    const real = document.createElement('img');
    real.src = `${this.base}${bh.eht!.image}`;
    real.alt = `EHT image of ${bh.name}`;
    let model = this.models.get(key);
    const caption = document.createElement('div');
    caption.className = 'eht-caption';
    if (!model) {
      model = document.createElement('canvas');
      model.width = model.height = N;
      this.models.set(key, model);
      const canvas = model;
      caption.textContent = 'Tracing the model…';
      // Off the frame loop: a few hundred thousand integration steps.
      setTimeout(() => {
        const img = blur(modelImage(bh, N, m.field, 0.05), N, (EHT_BEAM * N) / m.field);
        draw(canvas, img);
        canvas.dataset.ring = ringDiameter(img, N, m.field).toFixed(1);
        if (this.current === key) caption.textContent = captionText(bh, m, canvas.dataset.ring);
      }, 50);
    } else caption.textContent = captionText(bh, m, model.dataset.ring);
    const pair = document.createElement('div');
    pair.className = 'eht-pair';
    pair.append(figure(real, 'EHT'), figure(model, 'This model'));
    this.el.append(pair, caption);
  }
}

function figure(child: HTMLElement, title: string): HTMLElement {
  const f = document.createElement('figure');
  const c = document.createElement('figcaption');
  c.textContent = title;
  f.append(child, c);
  return f;
}

function captionText(bh: BlackHole, m: EhtMeta, ring: string | undefined): string {
  return [
    `${m.field.toFixed(0)} µas across, north up; model blurred to the EHT's ${EHT_BEAM} µas resolution`,
    `Ring: EHT ${bh.eht!.ring} ± ${bh.eht!.error} µas${ring ? `, model ${ring} µas` : ''}`,
    `EHT image: ${m.credit}, ${m.licence}`,
  ].join('\n');
}

/** The EHT's false-colour scale (afmhot), normalised to the brightest pixel. */
function draw(canvas: HTMLCanvasElement, img: Float64Array): void {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(N, N);
  const max = img.reduce((a, v) => Math.max(a, v), 1e-30);
  for (let k = 0; k < N * N; k++) {
    const x = img[k] / max;
    data.data[k * 4] = 255 * Math.min(1, Math.max(0, 2 * x));
    data.data[k * 4 + 1] = 255 * Math.min(1, Math.max(0, 2 * x - 0.5));
    data.data[k * 4 + 2] = 255 * Math.min(1, Math.max(0, 2 * x - 1));
    data.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
}
