import { Mat3 } from './math/Mat3';
import { Transform, type TransformLike } from './math/Transform';

/**
 * 单根骨骼。
 *
 * - local: 相对父骨骼（或世界原点）的变换。
 * - worldMatrix: 由 Skeleton.update() 计算的世界矩阵。
 * - length: 骨骼长度，沿 local +X 方向；用于子骨骼默认位置与权重计算。
 */
export class Bone {
  name: string;
  local: TransformLike;
  /** 世界矩阵缓存。 */
  worldMatrix: Mat3;
  /** 骨骼长度（local +X 方向）。 */
  length: number;
  parent: Bone | null;
  children: Bone[];

  constructor(name: string, opts: Partial<TransformLike & { length: number } & { inheritRotation?: boolean; inheritScale?: boolean; inheritReflection?: boolean }> = {}) {
    this.name = name;
    this.local = {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      rotation: opts.rotation ?? 0,
      scaleX: opts.scaleX ?? 1,
      scaleY: opts.scaleY ?? 1,
      shearX: opts.shearX ?? 0,
      shearY: opts.shearY ?? 0,
      // 变换继承标志（Spine Inherit）：Skeleton.update 里按勾选决定继承哪些
      inheritRotation: opts.inheritRotation ?? true,
      inheritScale: opts.inheritScale ?? true,
      inheritReflection: opts.inheritReflection ?? true,
    } as TransformLike & { inheritRotation: boolean; inheritScale: boolean; inheritReflection: boolean };
    this.worldMatrix = new Mat3();
    this.length = opts.length ?? 0;
    this.parent = null;
    this.children = [];
  }

  addChild(child: Bone): this {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  /** 深度优先遍历所有骨骼（包括自身）。 */
  traverse(cb: (b: Bone) => void): void {
    cb(this);
    for (const c of this.children) c.traverse(cb);
  }

  /** 按名字查找（深度优先）。 */
  findByName(name: string): Bone | null {
    if (this.name === name) return this;
    for (const c of this.children) {
      const r = c.findByName(name);
      if (r) return r;
    }
    return null;
  }

  /** 重置 local 变换为单位矩阵。 */
  resetLocal(): void {
    Transform.identity(this.local);
  }
}
