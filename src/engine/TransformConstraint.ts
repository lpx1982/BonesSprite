import { Bone } from './Bone';
import { Skeleton } from './Skeleton';

/**
 * 变换约束解算（仿 Spine 3.8 TransformConstraint 核心算法）。
 *
 * 语义：把「源骨骼」的世界变换（旋转 / 平移 / 缩放 / 倾斜）按混合权重复制给
 * 「目标骨骼」，并叠加偏移量：
 *  - 绝对模式（默认，additive = false）：目标世界 = 源世界 × 混合，offset 是
 *    叠加在源变换上的本地偏移（offsetX/Y 像素、offsetRotation/offsetShearY 度、
 *    offsetScaleX/Y 乘数）。
 *  - 相对模式（additive = true，Spine 3.8 的 relative）：把源的变换增量
 *    （相对单位矩阵）叠到目标当前变换上。
 *  - local（本地模式）：暂存参数，本版回退到绝对世界模式（注释见下）。
 *  - clamped（钳制）：min/max 暂存不生效（占位，待 Spine 4.1 语义落地）。
 *
 * 矩阵约定（与整个引擎一致，元素布局 [a, b, c, d, tx, ty, 0, 0, 1]）：
 *   [ a  c  tx ]
 *   [ b  d  ty ]
 *   x 轴方向 = (a, b)，旋转 = atan2(b, a)，scaleX = sqrt(a² + b²)；
 *   y 轴方向 = (c, d)，scaleY = sqrt(c² + d²)。
 *
 * 写回约定（与 PathConstraint / IK 一致）：
 *   - 约束先在世界空间算出目标骨骼的新世界矩阵，再换算回 local 写进
 *     bone.local，最后调 skeleton.update() 重算其 world（子骨骼自动跟随）。
 *   - 只影响引擎骨架的骨骼 local，不写回 store（store 保存未约束的设置姿态）。
 */

const PI2 = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/** 弧度归一化到 (-PI, PI]。 */
function wrapRad(a: number): number {
  let r = a % PI2;
  if (r > Math.PI) r -= PI2;
  else if (r <= -Math.PI) r += PI2;
  return r;
}

/** 解算所需的上下文（由调用方从 store 组装）。 */
export interface TransformSolveContext {
  /** 源骨骼：提供变换（Spine 数据里的 target） */
  source: Bone;
  /** 目标骨骼：被约束（Spine 数据里的 bones[0]） */
  target: Bone;
  /** 混合 0..1（Mix 区；平移/缩放 X、Y 分离，对齐 Spine 4.x） */
  rotateMix: number;
  translateMixX: number;
  translateMixY: number;
  scaleMixX: number;
  scaleMixY: number;
  shearMix: number;
  /** 偏移（Offset 区）；offsetRotation / offsetShearY 单位 = 度 */
  offsetX: number;
  offsetY: number;
  offsetRotation: number;
  offsetScaleX: number;
  offsetScaleY: number;
  offsetShearY: number;
  /** 相加（Spine 3.8 relative）：true = 相对叠加；false = 绝对复制（默认） */
  additive: boolean;
  /** 本地模式：暂存参数不强制，回退绝对世界模式 */
  local: boolean;
}

/**
 * 绝对模式（Spine applyAbsoluteWorld）：
 * 目标骨骼的旋转直接向源骨骼对齐（差异角 × rotateMix + offsetRotation），
 * 平移移到「源本地 offset 点」的世界位置（× translateMix），
 * 缩放 / 倾斜按源的 scaleX/scaleY/shearY 混合。
 */
function applyAbsoluteWorld(skeleton: Skeleton, ctx: TransformSolveContext): void {
  const { source, target, rotateMix, translateMixX, translateMixY, scaleMixX, scaleMixY, shearMix } = ctx;
  const se = source.worldMatrix.elements;
  const ta = se[0], tb = se[1], tc = se[3], td = se[4];
  // 反射（det < 0 = 镜像）：offset 的角度方向随反射翻转（Spine degRadReflect）
  const reflect = ta * td - tb * tc > 0 ? 1 : -1;
  const offsetRotation = ctx.offsetRotation * reflect * DEG_TO_RAD;
  const offsetShearY = ctx.offsetShearY * reflect * DEG_TO_RAD;

  const be = target.worldMatrix.elements;
  let a = be[0], b = be[1], c = be[3], d = be[4];
  let tx = be[6], ty = be[7];
  let modified = false;

  if (rotateMix !== 0) {
    // 源旋转 - 自身旋转 + 偏移 → 归一化 → × mix → 旋转自身坐标系
    let r = Math.atan2(tb, ta) - Math.atan2(b, a) + offsetRotation;
    r = wrapRad(r);
    r *= rotateMix;
    const cos = Math.cos(r), sin = Math.sin(r);
    const na = cos * a - sin * b;
    const nb = sin * a + cos * b;
    const nc = cos * c - sin * d;
    const nd = sin * c + cos * d;
    a = na; b = nb; c = nc; d = nd;
    modified = true;
  }

  if (translateMixX !== 0 || translateMixY !== 0) {
    // 源本地偏移 (offsetX, offsetY) → 源世界坐标，目标世界平移到该点 × mix（X/Y 独立混合）
    const px = ta * ctx.offsetX + tc * ctx.offsetY + se[6];
    const py = tb * ctx.offsetX + td * ctx.offsetY + se[7];
    if (translateMixX !== 0) tx += (px - tx) * translateMixX;
    if (translateMixY !== 0) ty += (py - ty) * translateMixY;
    modified = true;
  }

  if (scaleMixX !== 0 || scaleMixY !== 0) {
    // x 轴缩放：源 scaleX = sqrt(ta² + tb²)；offsetScaleX 是「源缩放上的增量乘数」
    if (scaleMixX !== 0) {
      let s = Math.sqrt(a * a + b * b);
      const ts = Math.sqrt(ta * ta + tb * tb);
      if (s > 0.00001) s = (s + (ts - s + ctx.offsetScaleX) * scaleMixX) / s;
      a *= s; b *= s;
    }
    // y 轴缩放：源 scaleY = sqrt(tc² + td²)
    if (scaleMixY !== 0) {
      let s = Math.sqrt(c * c + d * d);
      const ts = Math.sqrt(tc * tc + td * td);
      if (s > 0.00001) s = (s + (ts - s + ctx.offsetScaleY) * scaleMixY) / s;
      c *= s; d *= s;
    }
    modified = true;
  }

  if (shearMix !== 0) {
    // 目标「倾斜角 - 旋转角」差异 + offsetShearY → 混合后旋转目标 y 轴
    const by = Math.atan2(d, c);
    let r = Math.atan2(td, tc) - Math.atan2(tb, ta) - (by - Math.atan2(b, a));
    r = wrapRad(r);
    r = by + (r + offsetShearY) * shearMix;
    const s = Math.sqrt(c * c + d * d);
    c = Math.cos(r) * s;
    d = Math.sin(r) * s;
    modified = true;
  }

  if (modified) writeWorldBack(skeleton, target, a, b, c, d, tx, ty);
}

/**
 * 相对模式（Spine applyRelativeWorld，即「相加」）：
 * 把源的变换增量（相对单位矩阵的旋转角 / 平移 / 缩放 / 倾斜）直接叠加到
 * 目标骨骼当前的世界变换上，不参考目标自己的姿态。
 */
function applyRelativeWorld(skeleton: Skeleton, ctx: TransformSolveContext): void {
  const { source, target, rotateMix, translateMixX, translateMixY, scaleMixX, scaleMixY, shearMix } = ctx;
  const se = source.worldMatrix.elements;
  const ta = se[0], tb = se[1], tc = se[3], td = se[4];
  const reflect = ta * td - tb * tc > 0 ? 1 : -1;
  const offsetRotation = ctx.offsetRotation * reflect * DEG_TO_RAD;
  const offsetShearY = ctx.offsetShearY * reflect * DEG_TO_RAD;

  const be = target.worldMatrix.elements;
  let a = be[0], b = be[1], c = be[3], d = be[4];
  let tx = be[6], ty = be[7];
  let modified = false;

  if (rotateMix !== 0) {
    // 相对：直接叠加源旋转角（+offset），旋转自身坐标系
    let r = Math.atan2(tb, ta) + offsetRotation;
    r = wrapRad(r);
    r *= rotateMix;
    const cos = Math.cos(r), sin = Math.sin(r);
    const na = cos * a - sin * b;
    const nb = sin * a + cos * b;
    const nc = cos * c - sin * d;
    const nd = sin * c + cos * d;
    a = na; b = nb; c = nc; d = nd;
    modified = true;
  }

  if (translateMixX !== 0 || translateMixY !== 0) {
    // 相对：把源本地 offset 点按源世界位移量直接加到目标世界位置（X/Y 独立混合）
    const px = ta * ctx.offsetX + tc * ctx.offsetY + se[6];
    const py = tb * ctx.offsetX + td * ctx.offsetY + se[7];
    if (translateMixX !== 0) tx += px * translateMixX;
    if (translateMixY !== 0) ty += py * translateMixY;
    modified = true;
  }

  if (scaleMixX !== 0 || scaleMixY !== 0) {
    // 相对：缩放因子 = (源scale - 1 + offset) × mix + 1（X/Y 独立混合）
    if (scaleMixX !== 0) {
      const s = (Math.sqrt(ta * ta + tb * tb) - 1 + ctx.offsetScaleX) * scaleMixX + 1;
      a *= s; b *= s;
    }
    if (scaleMixY !== 0) {
      const s = (Math.sqrt(tc * tc + td * td) - 1 + ctx.offsetScaleY) * scaleMixY + 1;
      c *= s; d *= s;
    }
    modified = true;
  }

  if (shearMix !== 0) {
    // 相对：源的「倾斜角 - 旋转角」增量（+offset），旋转目标 y 轴
    let r = Math.atan2(td, tc) - Math.atan2(tb, ta);
    r = wrapRad(r);
    r = Math.atan2(d, c) + (r - Math.PI / 2 + offsetShearY) * shearMix;
    const s = Math.sqrt(c * c + d * d);
    c = Math.cos(r) * s;
    d = Math.sin(r) * s;
    modified = true;
  }

  if (modified) writeWorldBack(skeleton, target, a, b, c, d, tx, ty);
}

/**
 * 把约束算出的目标骨骼新世界矩阵换算回 local 写进 bone.local 并重算 world。
 * local = parentWorld⁻¹ × world；再分解 local 矩阵成
 * (x, y, rotation, scaleX, scaleY, shearX=0, shearY) —— 分解是精确的，
 * 重建出的矩阵与原矩阵完全一致（shearX 折叠进 rotation，不影响世界结果）。
 */
function writeWorldBack(
  skeleton: Skeleton,
  bone: Bone,
  a: number, b: number, c: number, d: number, tx: number, ty: number,
): void {
  const parent = bone.parent;
  let la: number, lb: number, lc: number, ld: number, ltx: number, lty: number;
  if (parent) {
    const pe = parent.worldMatrix.elements;
    const pa = pe[0], pb = pe[1], pc = pe[3], pd = pe[4], ptx = pe[6], pty = pe[7];
    const det = pa * pd - pb * pc;
    if (Math.abs(det) < 1e-9) {
      // 退化父矩阵（零缩放）无法求逆 → 直接把世界值当本地值
      la = a; lb = b; lc = c; ld = d; ltx = tx; lty = ty;
    } else {
      const inv = 1 / det;
      la = (pd * a - pc * b) * inv;
      lb = (-pb * a + pa * b) * inv;
      lc = (pd * c - pc * d) * inv;
      ld = (-pb * c + pa * d) * inv;
      const dx = tx - ptx, dy = ty - pty;
      ltx = (pd * dx - pc * dy) * inv;
      lty = (-pb * dx + pa * dy) * inv;
    }
  } else {
    la = a; lb = b; lc = c; ld = d; ltx = tx; lty = ty;
  }
  const scaleX = Math.sqrt(la * la + lb * lb);
  const scaleY = Math.sqrt(lc * lc + ld * ld);
  const rotation = Math.atan2(lb, la);
  const shearY = Math.atan2(ld, lc) - rotation - Math.PI / 2;
  bone.local.x = ltx;
  bone.local.y = lty;
  bone.local.rotation = rotation;
  bone.local.scaleX = Math.max(1e-4, scaleX);
  bone.local.scaleY = Math.max(1e-4, scaleY);
  bone.local.shearX = 0;
  bone.local.shearY = shearY;
  skeleton.update();
}

/** 应用一组变换约束（按数组顺序）。调用前必须已 skeleton.update() 过。 */
export function applyTransformConstraints(
  skeleton: Skeleton,
  contexts: TransformSolveContext[],
): void {
  for (const ctx of contexts) {
    if (
      ctx.rotateMix === 0 && ctx.translateMixX === 0 && ctx.translateMixY === 0 &&
      ctx.scaleMixX === 0 && ctx.scaleMixY === 0 && ctx.shearMix === 0
    ) continue;
    if (ctx.local) {
      // 本地模式（Spine applyAbsoluteLocal）依赖 applied 变换跟踪，暂存参数不强制：
      // 本版回退绝对世界模式，行为与 Spine「未勾选本地」一致。
      applyAbsoluteWorld(skeleton, ctx);
    } else if (ctx.additive) {
      applyRelativeWorld(skeleton, ctx);
    } else {
      applyAbsoluteWorld(skeleton, ctx);
    }
  }
}
