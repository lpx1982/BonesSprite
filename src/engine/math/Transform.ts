/**
 * 2D 仿射变换描述：位置 / 旋转 / 缩放。
 * 所有骨骼的 local 变换都用它表示。
 */
export interface TransformLike {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export class Transform implements TransformLike {
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;

  static identity(out?: TransformLike): TransformLike {
    const t = out ?? ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } as TransformLike);
    t.x = 0;
    t.y = 0;
    t.rotation = 0;
    t.scaleX = 1;
    t.scaleY = 1;
    return t;
  }

  static toMatrix(t: TransformLike, out?: Float64Array): Float64Array {
    // scale → rotate → translate
    const c = Math.cos(t.rotation);
    const s = Math.sin(t.rotation);
    const e = out ?? new Float64Array(9);
    e[0] = c * t.scaleX; e[1] = s * t.scaleX; e[2] = 0;
    e[3] = -s * t.scaleY; e[4] = c * t.scaleY; e[5] = 0;
    e[6] = t.x; e[7] = t.y; e[8] = 1;
    return e;
  }

  static lerp(a: TransformLike, b: TransformLike, t: number, out?: TransformLike): TransformLike {
    const o = out ?? ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } as TransformLike);
    o.x = a.x + (b.x - a.x) * t;
    o.y = a.y + (b.y - a.y) * t;
    o.rotation = a.rotation + (b.rotation - a.rotation) * t;
    o.scaleX = a.scaleX + (b.scaleX - a.scaleX) * t;
    o.scaleY = a.scaleY + (b.scaleY - a.scaleY) * t;
    return o;
  }

  static copy(src: TransformLike, out?: TransformLike): TransformLike {
    const o = out ?? ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } as TransformLike);
    o.x = src.x;
    o.y = src.y;
    o.rotation = src.rotation;
    o.scaleX = src.scaleX;
    o.scaleY = src.scaleY;
    return o;
  }
}
