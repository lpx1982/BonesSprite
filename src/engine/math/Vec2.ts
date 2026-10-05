/**
 * 2D 向量类，纯数学无外部依赖。
 * 用一个对象 {x, y} 表示，便于在矩阵/插值场景中直接读写。
 */
export interface Vec2Like {
  x: number;
  y: number;
}

export class Vec2 implements Vec2Like {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  copy(v: Vec2Like): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  add(v: Vec2Like): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  sub(v: Vec2Like): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): this {
    const len = this.length();
    if (len > 0) {
      this.x /= len;
      this.y /= len;
    }
    return this;
  }

  static lerp(a: Vec2Like, b: Vec2Like, t: number, out: Vec2Like = { x: 0, y: 0 }): Vec2Like {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    return out;
  }
}
