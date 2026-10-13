/**
 * 「变换约束 Match」算法（仿 Spine 4.3 编辑器 Match 按钮）：
 *   - offset Match：基于「源 / 目标 未约束姿态」反推 offsetX/Y/Rotation/ScaleX/ScaleY/ShearY，
 *     使 Mix=1 时目标的世界变换 = 目标当前世界变换。
 *   - props Match：基于同一未约束姿态反推 6 组 min/max 映射区间，使源当前值映射到目标当前值，
 *     保持目标映射范围（max-min）不变。
 *
 * 全部用 store 形态的 BoneNode 直接算世界矩阵（不依赖引擎实例 / 骨架），
 * 这样 store action 可以独立工作、与渲染解耦。
 *
 * 矩阵元素约定（与全引擎一致）：[a, b, c, d, tx, ty, 0, 0, 1]
 *   旋转 = atan2(b, a)；scaleX = sqrt(a²+b²)；scaleY = sqrt(c²+d²)。
 *   x 轴 = (a, b)，y 轴 = (c, d)。
 *
 * 参考：
 *   - http://esotericsoftware.com/spine-transform-constraints#Match
 *   - 4.3 编辑器：Match 永远用未约束姿态（as if mixes were 0）
 */
import type { BoneNode, TransformConstraintDef } from '../editor/store';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** 弧度归一化到 (-PI, PI]。 */
function wrapRad(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  else if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

/** 反射（det < 0 = 镜像）。 */
function reflectOf(e: Float64Array): number {
  return e[0] * e[4] - e[1] * e[3] > 0 ? 1 : -1;
}

/**
 * 把 store 骨树按 parent 链组装成一张「id → Float64Array(9)」的世界矩阵表
 * （元素 = [a, b, c, d, tx, ty, 0, 0, 1]）。
 * 骨树结构异常时（无根 / 父级缺失）该骨返回单位矩阵，调用方需自行过滤。
 */
export function computeWorldMatrices(bones: BoneNode[]): Map<string, Float64Array> {
  const out = new Map<string, Float64Array>();
  const nodeById = new Map(bones.map((b) => [b.id, b]));
  // 1) 找根（parentId 为空 / 找不到父级的视为根）
  const root = bones.find((b) => b.parentId == null || !nodeById.has(b.parentId));
  if (!root) return out;
  // 2) 递归：先父后子
  const visit = (node: BoneNode, parentE: Float64Array | null) => {
    // local → matrix
    const local = new Float64Array(9);
    const rot = node.rotation * DEG_TO_RAD;
    const shearX = node.shearX ?? 0;
    const shearY = node.shearY ?? 0;
    const sx = node.scaleX;
    const sy = node.scaleY;
    local[0] = Math.cos(rot + shearX) * sx;
    local[1] = Math.sin(rot + shearX) * sx;
    local[2] = 0;
    local[3] = Math.cos(rot + Math.PI / 2 + shearY) * sy;
    local[4] = Math.sin(rot + Math.PI / 2 + shearY) * sy;
    local[5] = 0;
    local[6] = node.x;
    local[7] = node.y;
    local[8] = 1;
    const world = new Float64Array(9);
    if (parentE) {
      // parent × local
      const pa = parentE[0], pb = parentE[1], pc = parentE[3], pd = parentE[4], ptx = parentE[6], pty = parentE[7];
      const la = local[0], lb = local[1], lc = local[3], ld = local[4], ltx = local[6], lty = local[7];
      world[0] = pa * la + pb * lc;
      world[1] = pa * lb + pb * ld;
      world[3] = pc * la + pd * lc;
      world[4] = pc * lb + pd * ld;
      world[6] = pa * ltx + pb * lty + ptx;
      world[7] = pc * ltx + pd * lty + pty;
      world[2] = 0; world[5] = 0; world[8] = 1;
    } else {
      world.set(local);
    }
    out.set(node.id, world);
    // 子级
    for (const child of bones) {
      if (child.parentId === node.id) visit(child, world);
    }
  };
  visit(root, null);
  return out;
}

/** offset Match 结果：要写入 store 的 offset 字段（不含 mix / id / 名称 / 源 / 目标 / 选项）。 */
export interface OffsetMatchResult {
  offsetX: number;
  offsetY: number;
  offsetRotation: number;
  offsetScaleX: number;
  offsetScaleY: number;
  offsetShearY: number;
}

/** props Match 结果：6 组 min/max 字段的更新值。 */
export interface PropsMatchResult {
  minRotate: number; maxRotate: number;
  minTranslateX: number; maxTranslateX: number;
  minTranslateY: number; maxTranslateY: number;
  minScaleX: number; maxScaleX: number;
  minScaleY: number; maxScaleY: number;
  minShearY: number; maxShearY: number;
}

/**
 * offset Match：基于「源 / 目标 未约束姿态」反推 6 个 offset 字段。
 * 返回 null 表示源或目标骨找不到。
 */
export function computeOffsetMatch(
  c: TransformConstraintDef,
  worldById: Map<string, Float64Array>,
): OffsetMatchResult | null {
  const se = worldById.get(c.sourceBoneId);
  const be = worldById.get(c.boneId);
  if (!se || !be) return null;
  const sa = se[0], sb = se[1], sc = se[3], sd = se[4];
  const ba = be[0], bb = be[1], bc = be[3], bd = be[4];
  // 反射符号：源 / 目标任一为镜像时，offset 的角度方向需要翻转
  const sReflect = sa * sd - sb * sc > 0 ? 1 : -1;
  // 反推（参考 applyAbsoluteWorld 公式反过来）：
  //   rotation: target_rot = source_rot + offsetRotation ⇒ offset = target - source（度）
  //   scaleX:   target_scaleX = source_scaleX + offsetScaleX ⇒ offset = Δ
  //   scaleY:   同上
  //   shearY:   target_shearY_world = source_shearY_world + offsetShearY ⇒ offset = Δ（度）
  //   translate: target_world_pos = source_world × (offsetX, offsetY) ⇒ (offsetX, offsetY) = source_world⁻¹ × target_world_pos
  const srcRot = wrapRad(Math.atan2(sb, sa));
  const tgtRot = wrapRad(Math.atan2(bb, ba));
  const offsetRotation = (tgtRot - srcRot) * sReflect * RAD_TO_DEG;
  const srcShearWorld = wrapRad(Math.atan2(sd, sc)) - srcRot - Math.PI / 2;
  const tgtShearWorld = wrapRad(Math.atan2(bd, bc)) - tgtRot - Math.PI / 2;
  const offsetShearY = wrapRad(tgtShearWorld - srcShearWorld) * sReflect * RAD_TO_DEG;
  const srcScaleX = Math.hypot(sa, sb);
  const tgtScaleX = Math.hypot(ba, bb);
  const offsetScaleX = tgtScaleX - srcScaleX;
  const srcScaleY = Math.hypot(sc, sd);
  const tgtScaleY = Math.hypot(bc, bd);
  const offsetScaleY = tgtScaleY - srcScaleY;
  // translate：解 (offsetX, offsetY) 使 source_world × (offsetX, offsetY) = target_world_pos
  //  =  [ sa sc 6 ] [x]   [tx]
  //     [ sb sd 7 ] [y] = [ty]
  //  det = sa*sd - sb*sc
  const det = sa * sd - sb * sc;
  if (Math.abs(det) < 1e-9) {
    // 源骨退化（零缩放 / 奇异）：无法解出 offsetX/Y，归零
    return { offsetX: 0, offsetY: 0, offsetRotation, offsetScaleX, offsetScaleY, offsetShearY };
  }
  const inv = 1 / det;
  const dx = be[6] - se[6];
  const dy = be[7] - se[7];
  const offsetX = (sd * dx - sc * dy) * inv;
  const offsetY = (-sb * dx + sa * dy) * inv;
  return { offsetX, offsetY, offsetRotation, offsetScaleX, offsetScaleY, offsetShearY };
}

/**
 * props Match：基于「源 / 目标 未约束姿态」反推 6 组 min/max。
 * 算法：对每个属性，把「源当前值」映射到「目标当前值」对应的源侧范围，
 * 目标侧范围（max - min）保持不变。
 *   旋转：源值 = 源世界旋转（度）；目标值 = 目标世界旋转（度）
 *   平移 X/Y：源 / 目标值 = 在「源本地坐标系」下的 X / Y 分量
 *   缩放 X/Y：源 / 目标值 = 源 / 目标世界 scaleX / scaleY
 *   倾斜 Y：源 / 目标值 = 源 / 目标世界 shearY（度）
 */
export function computePropsMatch(
  c: TransformConstraintDef,
  worldById: Map<string, Float64Array>,
): PropsMatchResult | null {
  const se = worldById.get(c.sourceBoneId);
  const be = worldById.get(c.boneId);
  if (!se || !be) return null;
  const sa = se[0], sb = se[1], sc = se[3], sd = se[4];
  const ba = be[0], bb = be[1], bc = be[3], bd = be[4];
  const sReflect = reflectOf(se);
  const srcRot = wrapRad(Math.atan2(sb, sa));
  const tgtRot = wrapRad(Math.atan2(bb, ba));
  const srcRotDeg = srcRot * sReflect * RAD_TO_DEG;
  const tgtRotDeg = tgtRot * sReflect * RAD_TO_DEG;
  // 平移 X/Y：把 target_world_pos 投到 source 的本地坐标系
  const det = sa * sd - sb * sc;
  let srcTxLocal = 0, srcTyLocal = 0, tgtTxLocal = 0, tgtTyLocal = 0;
  if (Math.abs(det) >= 1e-9) {
    const inv = 1 / det;
    const sdx = 0, sdy = 0; // 源本地原点 = 0,0
    srcTxLocal = (sd * sdx - sc * sdy) * inv;
    srcTyLocal = (-sb * sdx + sa * sdy) * inv;
    const tdx = be[6] - se[6];
    const tdy = be[7] - se[7];
    tgtTxLocal = (sd * tdx - sc * tdy) * inv;
    tgtTyLocal = (-sb * tdx + sa * tdy) * inv;
  }
  const srcScaleX = Math.hypot(sa, sb);
  const tgtScaleX = Math.hypot(ba, bb);
  const srcScaleY = Math.hypot(sc, sd);
  const tgtScaleY = Math.hypot(bc, bd);
  const srcShearDeg = (wrapRad(Math.atan2(sd, sc) - srcRot - Math.PI / 2)) * sReflect * RAD_TO_DEG;
  const tgtShearDeg = (wrapRad(Math.atan2(bd, bc) - tgtRot - Math.PI / 2)) * sReflect * RAD_TO_DEG;
  // 每个属性：min_src = src_value, max_src = src_value + (max_dst - min_dst)
  return {
    minRotate: srcRotDeg, maxRotate: srcRotDeg + (c.maxRotate - c.minRotate),
    minTranslateX: srcTxLocal, maxTranslateX: srcTxLocal + (c.maxTranslateX - c.minTranslateX),
    minTranslateY: srcTyLocal, maxTranslateY: srcTyLocal + (c.maxTranslateY - c.minTranslateY),
    minScaleX: srcScaleX, maxScaleX: srcScaleX + (c.maxScaleX - c.minScaleX),
    minScaleY: srcScaleY, maxScaleY: srcScaleY + (c.maxScaleY - c.minScaleY),
    minShearY: srcShearDeg, maxShearY: srcShearDeg + (c.maxShearY - c.minShearY),
  };
}
