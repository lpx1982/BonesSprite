/**
 * 2D 仿射变换描述：位置 / 旋转 / 缩放 / 剪切。
 * 所有骨骼的 local 变换都用它表示。
 * shearX / shearY 为弧度（对应 Spine 的 shearX / shearY 角度）。
 */
export interface TransformLike {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX?: number;
  shearY?: number;
}

export class Transform implements TransformLike {
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;
  shearX?: number;
  shearY?: number;

  static identity(out?: TransformLike): TransformLike {
    const t = out ?? ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 } as TransformLike);
    t.x = 0;
    t.y = 0;
    t.rotation = 0;
    t.scaleX = 1;
    t.scaleY = 1;
    t.shearX = 0;
    t.shearY = 0;
    return t;
  }

  static toMatrix(t: TransformLike, out?: Float64Array): Float64Array {
    // scale → shear → rotate → translate（Spine 顺序）：
    //   x 轴角 = rotation + shearX，y 轴角 = rotation + 90° + shearY
    // shear 为 0 时退化为原公式（a=cos·sx, b=sin·sx, c=-sin·sy, d=cos·sy）
    const rot = t.rotation;
    const shearX = t.shearX ?? 0;
    const shearY = t.shearY ?? 0;
    const e = out ?? new Float64Array(9);
    e[0] = Math.cos(rot + shearX) * t.scaleX; e[1] = Math.sin(rot + shearX) * t.scaleX; e[2] = 0;
    e[3] = Math.cos(rot + Math.PI / 2 + shearY) * t.scaleY; e[4] = Math.sin(rot + Math.PI / 2 + shearY) * t.scaleY; e[5] = 0;
    e[6] = t.x; e[7] = t.y; e[8] = 1;
    return e;
  }

  static lerp(a: TransformLike, b: TransformLike, t: number, out?: TransformLike): TransformLike {
    const o = out ?? ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 } as TransformLike);
    o.x = a.x + (b.x - a.x) * t;
    o.y = a.y + (b.y - a.y) * t;
    o.rotation = a.rotation + (b.rotation - a.rotation) * t;
    o.scaleX = a.scaleX + (b.scaleX - a.scaleX) * t;
    o.scaleY = a.scaleY + (b.scaleY - a.scaleY) * t;
    o.shearX = (a.shearX ?? 0) + ((b.shearX ?? 0) - (a.shearX ?? 0)) * t;
    o.shearY = (a.shearY ?? 0) + ((b.shearY ?? 0) - (a.shearY ?? 0)) * t;
    return o;
  }

  static copy(src: TransformLike, out?: TransformLike): TransformLike {
    const o = out ?? ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 } as TransformLike);
    o.x = src.x;
    o.y = src.y;
    o.rotation = src.rotation;
    o.scaleX = src.scaleX;
    o.scaleY = src.scaleY;
    o.shearX = src.shearX ?? 0;
    o.shearY = src.shearY ?? 0;
    return o;
  }
}
