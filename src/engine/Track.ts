import type { Keyframe } from './Keyframe';

/** 缓动函数：输入 t ∈ [0,1]，输出 ∈ [0,1]。 */
export type Easing = (t: number) => number;

const NEWTON_ITERATIONS = 8;

/**
 * 一条动画轨道：针对某个骨骼属性的若干 Keyframe 按时序排列。
 */
export class Track<T = number> {
  keyframes: Keyframe<T>[] = [];
  /** 段间默认缓动，未设置则对每一段 fallback 为 linear。 */
  easing: Easing = (t) => t;

  constructor(initial?: Keyframe<T>[]) {
    if (initial) this.keyframes = [...initial];
  }

  add(k: Keyframe<T>): this {
    this.keyframes.push(k);
    this.keyframes.sort((a, b) => a.time - b.time);
    return this;
  }

  /**
   * 在时间 t 处采样。
   * - t 超出范围：clamp 到两端。
   * - 中间帧：用 Newton-Raphson 迭代求解 Bezier 出向控制点对应的 s，
   *   失败回退到二分搜索。
   */
  sample(t: number): T {
    const kfs = this.keyframes;
    if (kfs.length === 0) {
      throw new Error('Track.sample: no keyframes');
    }
    if (kfs.length === 1 || t <= kfs[0].time) {
      return kfs[0].value;
    }
    const last = kfs[kfs.length - 1];
    if (t >= last.time) return last.value;

    // 找到第一个 time > t 的关键帧
    let i = 1;
    while (i < kfs.length - 1 && kfs[i].time < t) i++;
    const a = kfs[i - 1];
    const b = kfs[i];

    const span = b.time - a.time;
    const u = (t - a.time) / span;

    // Bezier 缓动：用 cx1/cy1 + cx2/cy2 当作三次曲线控制点
    if (
      a.cx1 !== undefined && a.cy1 !== undefined &&
      a.cx2 !== undefined && a.cy2 !== undefined
    ) {
      const eased = bezierInterpolate(
        u,
        a.cx1,
        a.cy1,
        a.cx2,
        a.cy2,
        NEWTON_ITERATIONS,
      );
      return lerpValue(a.value, b.value, eased);
    }

    // 否则使用 easing 或 linear
    const e = this.easing;
    return lerpValue(a.value, b.value, e(u));
  }
}

/** 简单值的线性插值（兼容 number）。 */
function lerpValue<T>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') {
    return (a + (b - a) * t) as unknown as T;
  }
  // 对象形式：{x, y}
  const av = a as unknown as { x: number; y: number };
  const bv = b as unknown as { x: number; y: number };
  return {
    x: av.x + (bv.x - av.x) * t,
    y: av.y + (bv.y - av.y) * t,
  } as unknown as T;
}

/**
 * 求解三次贝塞尔曲线 y(s) = u0：
 *   y(s) = 3(1-s)^2 s * cy1 + 3(1-s) s^2 * cy2 + s^3
 * 默认 x 控制点固定在 0 与 1，使用 Newton-Raphson。
 * 失败时 fallback 到二分搜索。
 */
function bezierInterpolate(
  u0: number,
  cx1: number,
  cy1: number,
  cx2: number,
  cy2: number,
  iterations: number,
): number {
  if (u0 <= 0) return 0;
  if (u0 >= 1) return 1;

  // x(s) = 3(1-s)^2 s * cx1 + 3(1-s) s^2 * cx2 + s^3
  const sampleX = (s: number) => 3 * (1 - s) * (1 - s) * s * cx1 + 3 * (1 - s) * s * s * cx2 + s * s * s;
  const sampleY = (s: number) => 3 * (1 - s) * (1 - s) * s * cy1 + 3 * (1 - s) * s * s * cy2 + s * s * s;
  const sampleDX = (s: number) => {
    // d/ds x(s)
    return 9 * cx1 * s * s - 12 * cx1 * s + 3 * cx1
      + 6 * cx2 * s - 9 * cx2 * s * s
      + 3 * s * s;
  };

  // Newton-Raphson
  let s = u0;
  for (let i = 0; i < iterations; i++) {
    const x = sampleX(s) - u0;
    const dx = sampleDX(s);
    if (Math.abs(dx) < 1e-6) break;
    const next = s - x / dx;
    if (next < 0 || next > 1) break; // 越界回退二分
    s = next;
  }

  // 验证得到的 s 是否有效，否则二分
  const xAtS = sampleX(s);
  if (Math.abs(xAtS - u0) > 1e-3) {
    let lo = 0, hi = 1;
    s = u0;
    for (let i = 0; i < 20; i++) {
      const x = sampleX(s);
      if (Math.abs(x - u0) < 1e-4) break;
      if (x < u0) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
  }

  return sampleY(s);
}
