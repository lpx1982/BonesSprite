import { Bone } from './Bone';
import { Mat3 } from './math/Mat3';
import { Transform, type TransformLike } from './math/Transform';

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
   *
   * 继承规则（Spine Inherit）：
   *   - 三个标志全开 → 保持原有的「parent × local」精确矩阵乘；
   *   - 任一标志被勾掉 → 把父世界矩阵分解成 rotation / scale / reflection，
   *     按勾选重组，未被勾选的部分不再从父级继承（平移始终继承）。
   */
  update(): void {
    const local = this._localScratch;
    const visit = (bone: Bone): void => {
      // 1. 把 local 矩阵算到独立 scratch（绝不复用 bone.worldMatrix.elements）
      Transform.toMatrix(bone.local, local);

      if (bone.parent) {
        const parent = bone.parent.worldMatrix.elements;
        const dst = bone.worldMatrix.elements;
        const l = bone.local as TransformLike & {
          inheritRotation?: boolean; inheritScale?: boolean; inheritReflection?: boolean;
        };
        const inheritRot = l.inheritRotation !== false;
        const inheritScale = l.inheritScale !== false;
        const inheritReflect = l.inheritReflection !== false;

        if (inheritRot && inheritScale && inheritReflect) {
          // 全继承：精确的 parent × local（保持既有行为）
          dst[0] = parent[0]; dst[1] = parent[1]; dst[2] = parent[2];
          dst[3] = parent[3]; dst[4] = parent[4]; dst[5] = parent[5];
          dst[6] = parent[6]; dst[7] = parent[7]; dst[8] = parent[8];
          Mat3.multiplyInto(dst, local, dst);
        } else {
          // 部分继承：分解父世界 → 按勾选重组（Spine 语义）
          const pRot = Math.atan2(parent[1], parent[0]);      // 父世界旋转
          const pScaleX = Math.hypot(parent[0], parent[1]) || 1;
          const pScaleY = Math.hypot(parent[3], parent[4]) || 1;
          const pReflect = parent[0] * parent[4] - parent[1] * parent[3] < 0 ? -1 : 1;
          const lx = l.x, ly = l.y;
          const lRot = l.rotation;
          const lSx = l.scaleX, lSy = l.scaleY;
          // 世界旋转 / 缩放 / 反射：未被勾选的项不再继承父级
          const wRot = inheritRot ? pRot + lRot : lRot;
          const wSx = inheritScale ? pScaleX * lSx : lSx;
          const wSy = inheritScale ? pScaleY * lSy : lSy;
          const wRe = inheritReflect ? pReflect : 1;
          const shearX = l.shearX ?? 0;
          const shearY = l.shearY ?? 0;
          const wrx = wRot + shearX;
          const wry = wRot + Math.PI / 2 + shearY;
          // 平移始终继承：worldPos = parent.world × local(x,y)
          const wtx = parent[0] * lx + parent[3] * ly + parent[6];
          const wty = parent[1] * lx + parent[4] * ly + parent[7];
          dst[0] = Math.cos(wrx) * wSx * wRe;
          dst[1] = Math.sin(wrx) * wSx * wRe;
          dst[3] = Math.cos(wry) * wSy * wRe;
          dst[4] = Math.sin(wry) * wSy * wRe;
          dst[2] = 0; dst[5] = 0; dst[6] = wtx; dst[7] = wty; dst[8] = 1;
        }
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
