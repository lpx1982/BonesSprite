/**
 * 3×3 仿射矩阵（列主序 9 个元素）。
 *
 * 与 2D 变换对应：
 *   [ a c tx ]
 *   [ b d ty ]
 *   [ 0 0 1  ]
 *
 * 数组布局 [a, b, c, d, tx, ty, 0, 0, 1] —— 这里 a/b/c/d 是列主序，
 * 即 a=scaleX*cos, b=scaleX*sin, c=-scaleY*sin, d=scaleY*cos。
 */
export interface Mat3Like {
  elements: Float64Array;
}

export class Mat3 implements Mat3Like {
  /** 9 个元素，列主序。 */
  elements: Float64Array;

  constructor() {
    this.elements = new Float64Array(9);
    this.identity();
  }

  /** 重置为单位矩阵。可选地写入外部数组。 */
  identity(out?: Float64Array): this {
    const e = out ?? this.elements;
    e[0] = 1; e[1] = 0; e[2] = 0;
    e[3] = 0; e[4] = 1; e[5] = 0;
    e[6] = 0; e[7] = 0; e[8] = 1;
    if (!out) this.elements = e;
    return this;
  }

  /** 拷贝到外部矩阵（默认覆盖自身）。 */
  copy(other: Mat3Like, out?: Float64Array): this {
    const e = out ?? this.elements;
    const o = other.elements;
    for (let i = 0; i < 9; i++) e[i] = o[i];
    if (!out) this.elements = e;
    return this;
  }

  translate(tx: number, ty: number, out?: Float64Array): this {
    const e = out ?? this.elements;
    e[6] += e[0] * tx + e[3] * ty;
    e[7] += e[1] * tx + e[4] * ty;
    if (!out) this.elements = e;
    return this;
  }

  scale(sx: number, sy: number, out?: Float64Array): this {
    const e = out ?? this.elements;
    e[0] *= sx; e[1] *= sx; e[2] *= sx;
    e[3] *= sy; e[4] *= sy; e[5] *= sy;
    if (!out) this.elements = e;
    return this;
  }

  rotate(angle: number, out?: Float64Array): this {
    const e = out ?? this.elements;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const a = e[0], b = e[1];
    e[0] = a * c + e[3] * s;
    e[1] = b * c + e[4] * s;
    e[3] = a * -s + e[3] * c;
    e[4] = b * -s + e[4] * c;
    if (!out) this.elements = e;
    return this;
  }

  /**
   * this = this × other.
   * 注意：变换顺序与"作用于顶点"保持一致 —— 后乘的变换先作用在点上。
   */
  multiply(other: Mat3Like, out?: Float64Array): this {
    const e = out ?? this.elements;
    const o = other.elements;
    // 暂存 this
    const a0 = e[0], a1 = e[1], a2 = e[2];
    const a3 = e[3], a4 = e[4], a5 = e[5];
    const a6 = e[6], a7 = e[7], a8 = e[8];
    e[0] = a0 * o[0] + a3 * o[1] + a6 * o[2];
    e[1] = a1 * o[0] + a4 * o[1] + a7 * o[2];
    e[2] = a2 * o[0] + a5 * o[1] + a8 * o[2];
    e[3] = a0 * o[3] + a3 * o[4] + a6 * o[5];
    e[4] = a1 * o[3] + a4 * o[4] + a7 * o[5];
    e[5] = a2 * o[3] + a5 * o[4] + a8 * o[5];
    e[6] = a0 * o[6] + a3 * o[7] + a6 * o[8];
    e[7] = a1 * o[6] + a4 * o[7] + a7 * o[8];
    e[8] = a2 * o[6] + a5 * o[7] + a8 * o[8];
    if (!out) this.elements = e;
    return this;
  }

  /**
   * 静态工具：out = a × b。
   * 不修改 a 或 b，专为"独立 scratch buffer 写结果"准备。
   */
  static multiplyInto(a: Float64Array, b: Float64Array, out: Float64Array): void {
    const a0 = a[0], a1 = a[1], a2 = a[2];
    const a3 = a[3], a4 = a[4], a5 = a[5];
    const a6 = a[6], a7 = a[7], a8 = a[8];
    const b0 = b[0], b1 = b[1], b2 = b[2];
    const b3 = b[3], b4 = b[4], b5 = b[5];
    const b6 = b[6], b7 = b[7], b8 = b[8];
    out[0] = a0 * b0 + a3 * b1 + a6 * b2;
    out[1] = a1 * b0 + a4 * b1 + a7 * b2;
    out[2] = a2 * b0 + a5 * b1 + a8 * b2;
    out[3] = a0 * b3 + a3 * b4 + a6 * b5;
    out[4] = a1 * b3 + a4 * b4 + a7 * b5;
    out[5] = a2 * b3 + a5 * b4 + a8 * b5;
    out[6] = a0 * b6 + a3 * b7 + a6 * b8;
    out[7] = a1 * b6 + a4 * b7 + a7 * b8;
    out[8] = a2 * b6 + a5 * b7 + a8 * b8;
  }

  /** 用本矩阵变换一个点。 */
  transformPoint(x: number, y: number): { x: number; y: number } {
    const e = this.elements;
    return {
      x: e[0] * x + e[3] * y + e[6],
      y: e[1] * x + e[4] * y + e[7],
    };
  }

  /** 分解为 {tx, ty, rotation, scaleX, scaleY}。 */
  decompose(): { tx: number; ty: number; rotation: number; scaleX: number; scaleY: number } {
    const e = this.elements;
    const sx = Math.hypot(e[0], e[1]);
    const sy = Math.hypot(e[3], e[4]);
    const rotation = Math.atan2(e[1], e[0]);
    return {
      tx: e[6],
      ty: e[7],
      rotation,
      scaleX: sx,
      scaleY: sy,
    };
  }

  /**
   * 构造一个变换矩阵。变换顺序：scale → rotate → translate。
   * 等价于 T·R·S。
   */
  static compose(
    tx: number,
    ty: number,
    rotation: number,
    sx: number,
    sy: number,
    out?: Float64Array,
  ): Float64Array {
    const e = out ?? new Float64Array(9);
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    e[0] = c * sx; e[1] = s * sx; e[2] = 0;
    e[3] = -s * sy; e[4] = c * sy; e[5] = 0;
    e[6] = tx; e[7] = ty; e[8] = 1;
    return e;
  }
}
