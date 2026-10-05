import { Bone } from './Bone';
import { Mat3 } from './math/Mat3';
import { Transform } from './math/Transform';

/**
 * 一棵骨骼树。世界矩阵由 root 自顶向下更新：
 *   world(b) = world(parent) × local(b)
 * 根节点的 parent = null，所以根的 worldMatrix 直接等于它的 localMatrix。
 *
 * 实现要点：必须用一个独立的 scratch buffer 存 local 矩阵，
 * 否则 Transform.toMatrix(out, bone.worldMatrix.elements) 会让
 * localMat 拿到 bone.worldMatrix.elements 的引用，
 * 紧接着 copy(parent) 会把同一个数组覆写成 parent 的元素，
 * multiply 就变成了 parent × parent 而不是 parent × local。
 */
export class Skeleton {
  root: Bone;
  /** 每帧复用的 scratch buffer，避免和任何 bone.worldMatrix.elements 别名。 */
  private _localScratch: Float64Array = new Float64Array(9);

  constructor(root: Bone) {
    this.root = root;
  }

  /**
   * 刷新所有骨骼的世界矩阵。
   * 必须在修改骨骼 local 之后、采样世界坐标/绘制之前调用。
   */
  update(): void {
    const local = this._localScratch;
    const visit = (bone: Bone): void => {
      // 1. 把 local 矩阵算到独立 scratch（绝不复用 bone.worldMatrix.elements）
      Transform.toMatrix(bone.local, local);

      if (bone.parent) {
        // 2. 先把 parent.worldMatrix 拷到 bone.worldMatrix.elements
        const parent = bone.parent.worldMatrix.elements;
        const dst = bone.worldMatrix.elements;
        dst[0] = parent[0]; dst[1] = parent[1]; dst[2] = parent[2];
        dst[3] = parent[3]; dst[4] = parent[4]; dst[5] = parent[5];
        dst[6] = parent[6]; dst[7] = parent[7]; dst[8] = parent[8];

        // 3. dst = dst × local  （parent × local）
        Mat3.multiplyInto(dst, local, dst);
      } else {
        // root：world = local
        const dst = bone.worldMatrix.elements;
        dst[0] = local[0]; dst[1] = local[1]; dst[2] = local[2];
        dst[3] = local[3]; dst[4] = local[4]; dst[5] = local[5];
        dst[6] = local[6]; dst[7] = local[7]; dst[8] = local[8];
      }

      for (const c of bone.children) visit(c);
    };
    visit(this.root);
    // 抑制未使用变量告警
    void Mat3;
  }

  /** 返回指定骨骼的世界坐标位置。 */
  getWorldPosition(bone: Bone): { x: number; y: number } {
    return bone.worldMatrix.transformPoint(0, 0);
  }

  /** 返回指定骨骼沿 +X 方向的尾部世界坐标（= origin + length * 单位向量）。 */
  getWorldTip(bone: Bone): { x: number; y: number } {
    return bone.worldMatrix.transformPoint(bone.length, 0);
  }

  /** 按名字查找骨骼。 */
  findBone(name: string): Bone | null {
    return this.root.findByName(name);
  }
}
