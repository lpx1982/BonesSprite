import { Bone } from './Bone';
import { Skeleton } from './Skeleton';

/**
 * 物理约束解算（仿 Spine 4.1 PhysicsConstraint）。
 *
 * 核心思想：不是真实物理引擎（无质量、无碰撞），而是对骨骼变换做「滞后偏移」：
 *  - 每帧记录骨骼（未受物理影响）的世界位置，与上一帧的差 × inertia = 新增偏移
 *    （骨骼移动时「赖在原地」→ 滞后跟随）
 *  - offset 受弹簧回复力 strength 拉回 0（回到真实姿势），质量 mass 反比抗拉
 *  - damping 削弱速度，抑制振荡
 *  - wind / gravity 施加世界 X / Y 恒定外力
 *  - limit 限制单帧偏移幅度（限速）
 *  - 最终 offset × mix 叠加回骨骼 local 变换
 *
 * 状态约定：
 *  - 每个约束一份运行时状态（offset / velocity / 上一帧缓存），由调用方跨帧持有。
 *  - 骨骼每帧可能被重建（buildSkeleton）——状态按约束 id 存，与骨骼实例解耦。
 */

/** 物理约束运行时状态（每约束一份，跨帧保留）。 */
export interface PhysicsRuntimeState {
  /** 上一帧「未受物理影响」的骨骼世界位置 */
  ux: number;
  uy: number;
  /** 上一帧骨骼尖端的世界位置（旋转 / 缩放的滞后参考） */
  tipX: number;
  tipY: number;
  /** 平移偏移与速度（世界像素） */
  xOffset: number;
  xVelocity: number;
  yOffset: number;
  yVelocity: number;
  /** 旋转偏移与速度（弧度） */
  rotateOffset: number;
  rotateVelocity: number;
  /** scaleX 偏移与速度（比例增量，0 = 无缩放偏移） */
  scaleOffset: number;
  scaleVelocity: number;
}

/** 新建一份零初始状态。 */
export function createPhysicsRuntime(): PhysicsRuntimeState {
  return {
    ux: 0, uy: 0, tipX: 0, tipY: 0,
    xOffset: 0, xVelocity: 0,
    yOffset: 0, yVelocity: 0,
    rotateOffset: 0, rotateVelocity: 0,
    scaleOffset: 0, scaleVelocity: 0,
  };
}

/** 解算所需的上下文（由调用方从 store 组装）。 */
export interface PhysicsSolveContext {
  /** 受约束骨骼（引擎实例） */
  bone: Bone;
  /** 运行时状态（跨帧） */
  state: PhysicsRuntimeState;
  /** 各属性受物理影响的程度 0..1（Spine Setup 区滑块 /100） */
  x: number;
  y: number;
  rotate: number;
  shearX: number;
  scaleX: number;
  /** 限速：单帧偏移上限（世界像素） */
  limit: number;
  /** 更新率（Hz，Spine FPS）。物理推进的步长 = 1/fps */
  fps: number;
  /** 惯性 0..1：骨骼移动量转成滞后偏移的比例 */
  inertia: number;
  /** 回复力 0..1：把 offset 拉回 0 的弹簧强度 */
  strength: number;
  /** 阻尼 0..1：削弱速度（抑制振荡） */
  damping: number;
  /** 质量倒数（越大越「轻」，越容易被拉/被推） */
  massInverse: number;
  /** 风：世界 X 恒定力（缩放因子乘数） */
  wind: number;
  /** 重力：世界 Y 恒定力（缩放因子乘数） */
  gravity: number;
  /** 混合 0..1：约束影响力 */
  mix: number;
}

const PI2 = Math.PI * 2;

/** 角度归一化到 [-PI, PI]。 */
function wrapAngle(a: number): number {
  return a - Math.ceil(a / PI2 - 0.5) * PI2;
}

/** 读取骨骼世界旋转角（弧度）：矩阵 [a,b;c,d] 的 atan2(c,a)。 */
function worldRotation(bone: Bone): number {
  const e = bone.worldMatrix.elements;
  return Math.atan2(e[3], e[0]);
}

/** 读取骨骼世界 scaleX。 */
function worldScaleX(bone: Bone): number {
  const e = bone.worldMatrix.elements;
  return Math.hypot(e[0], e[1]);
}

/** 设置骨骼 local rotation，使它的世界旋转变为 targetWorldRot。 */
function setWorldRotation(skeleton: Skeleton, bone: Bone, targetWorldRot: number): void {
  const parentRot = bone.parent ? worldRotation(bone.parent) : 0;
  bone.local.rotation = wrapAngle(targetWorldRot - parentRot);
  skeleton.update();
}

/** 设置骨骼 local 位置，使它的世界位置变为 (wx, wy)。 */
function setWorldPosition(skeleton: Skeleton, bone: Bone, wx: number, wy: number): void {
  if (bone.parent) {
    const e = bone.parent.worldMatrix.elements;
    const a = e[0], b = e[1], c = e[3], d = e[4], tx = e[6], ty = e[7];
    const det = a * d - b * c;
    if (Math.abs(det) > 1e-12) {
      const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
      const ox = wx - tx, oy = wy - ty;
      bone.local.x = ia * ox + ic * oy;
      bone.local.y = ib * ox + id * oy;
    } else {
      bone.local.x = wx;
      bone.local.y = wy;
    }
  } else {
    bone.local.x = wx;
    bone.local.y = wy;
  }
  skeleton.update();
}

/** 设置骨骼 local scaleX，使它的世界 scaleX 变为 targetWorldSx。 */
function setWorldScaleX(skeleton: Skeleton, bone: Bone, targetWorldSx: number): void {
  const parentSx = bone.parent ? worldScaleX(bone.parent) : 1;
  const lsx = parentSx > 1e-6 ? targetWorldSx / parentSx : targetWorldSx;
  bone.local.scaleX = Math.max(1e-4, lsx);
  skeleton.update();
}

/**
 * 推进一个物理约束一帧。
 * 调用前必须 skeleton.update() 过（骨骼 world 已含动画/IK/Path 结果）。
 * 只修改受约束骨骼自己的 local 变换，写回后重算其 world（子骨骼由 update() 跟随）。
 *
 * @param delta 距上一帧的真实时间（秒）。<=0 时仅应用当前 offset（不推进）。
 */
export function solvePhysics(skeleton: Skeleton, ctx: PhysicsSolveContext, delta: number): void {
  const { bone, state, mix } = ctx;
  if (mix <= 0) return;
  const hasX = ctx.x > 0, hasY = ctx.y > 0;
  const hasRot = ctx.rotate > 0;
  const hasShear = ctx.shearX > 0;
  const hasScale = ctx.scaleX > 0;
  const boneLen = bone.length;
  const e = bone.worldMatrix.elements;
  const bx = e[6], by = e[7];
  const ca = worldRotation(bone);
  const ca0 = ca; // 记录「物理前」世界旋转（写回时叠加）

  // 尖端位置（世界）：旋转滞后/缩放滞后的参考点
  const tipX = bx + boneLen * Math.cos(ca);
  const tipY = by + boneLen * Math.sin(ca);

  // ★ 未初始化保护：delta<=0（或状态为零且尚未记录过位置）时，
  //   只把本帧位置写入缓存，不产生任何偏移（避免首帧从 (0,0) 到骨骼位置造成爆炸偏移）。
  if (delta <= 0 || (state.ux === 0 && state.uy === 0 && state.tipX === 0 && state.tipY === 0)) {
    state.ux = bx;
    state.uy = by;
    state.tipX = tipX;
    state.tipY = tipY;
    return;
  }

  // ---- 一、平移偏移（世界空间）----
  const qx = Math.max(0, ctx.limit) * delta;
  const qy = qx;
  if (hasX) {
    const u = (state.ux - bx) * ctx.inertia;
    state.xOffset += u > qx ? qx : u < -qx ? -qx : u;
    state.ux = bx;
  }
  if (hasY) {
    const u = (state.uy - by) * ctx.inertia;
    state.yOffset += u > qy ? qy : u < -qy ? -qy : u;
    state.uy = by;
  }

  // ---- 旋转滞后：骨骼尖端「赖在原地」→ 旋转朝旧尖端方向偏移 ----
  if (hasRot || hasShear) {
    const oldTipX = state.tipX, oldTipY = state.tipY;
    // 目标方向 = 当前原点 → 旧尖端
    const desired = Math.atan2(oldTipY - by, oldTipX - bx);
    const r = wrapAngle(desired - ca);
    state.rotateOffset += r * ctx.inertia;
  }
  if (hasScale) {
    // 缩放滞后：尖端相对当前骨骼方向的前向位移量
    const dx = state.tipX - tipX, dy = state.tipY - tipY;
    const len = boneLen * worldScaleX(bone);
    if (len > 1e-6) state.scaleOffset += (dx * Math.cos(ca) + dy * Math.sin(ca)) * ctx.inertia / len;
  }

  // ---- 弹簧 + 外力 + 阻尼（按约束 fps 步进积分）----
  const step = ctx.fps > 0 ? 1 / ctx.fps : 1 / 60;
  const n = Math.max(1, Math.ceil(Math.max(delta, 0) / step));
  const dt = Math.max(delta, 0) / n;
  const damp = Math.pow(Math.max(0, 1 - ctx.damping), dt * 60);
  const m = ctx.massInverse * dt;
  const str = ctx.strength;
  const wind = ctx.wind, gravity = ctx.gravity;
  const h = boneLen / 100; // 骨长杠杆比（旋转受外力影响的程度）
  for (let i = 0; i < n; i++) {
    if (hasX) {
      state.xVelocity += (wind - state.xOffset * str) * m;
      state.xOffset += state.xVelocity * dt;
      state.xVelocity *= damp;
    }
    if (hasY) {
      state.yVelocity -= (gravity + state.yOffset * str) * m;
      state.yOffset += state.yVelocity * dt;
      state.yVelocity *= damp;
    }
    if (hasScale) {
      state.scaleVelocity += (wind * Math.cos(ca) - gravity * Math.sin(ca) - state.scaleOffset * str) * m;
      state.scaleOffset += state.scaleVelocity * dt;
      state.scaleVelocity *= damp;
    }
    if (hasRot || hasShear) {
      state.rotateVelocity -= ((wind * Math.sin(ca) + gravity * Math.cos(ca)) * h + state.rotateOffset * str) * m;
      state.rotateOffset += state.rotateVelocity * dt;
      state.rotateVelocity *= damp;
    }
  }

  // ---- 混合写回 ----
  // 平移
  if (hasX) setWorldPosition(skeleton, bone, bx + state.xOffset * mix * ctx.x, bone.worldMatrix.elements[7]);
  if (hasY) setWorldPosition(skeleton, bone, bone.worldMatrix.elements[6], by + state.yOffset * mix * ctx.y);
  // 旋转 / 剪切
  if (hasRot || hasShear) {
    const rotOffset = state.rotateOffset * mix;
    if (hasRot) {
      setWorldRotation(skeleton, bone, ca0 + rotOffset * ctx.rotate);
      if (hasShear) {
        // 剪切：额外旋转 shearX 部分（作用于世界矩阵的分量）
        const e2 = bone.worldMatrix.elements;
        const r2 = rotOffset * ctx.shearX;
        const sr = Math.sin(r2), cr = Math.cos(r2);
        const a = e2[0], b = e2[1], c = e2[3], d = e2[4];
        e2[0] = cr * a + sr * c;
        e2[1] = cr * b + sr * d;
        e2[3] = -sr * a + cr * c;
        e2[4] = -sr * b + cr * d;
        skeleton.update();
      }
    } else if (hasShear) {
      const e2 = bone.worldMatrix.elements;
      const r2 = rotOffset * ctx.shearX;
      const sr = Math.sin(r2), cr = Math.cos(r2);
      const a = e2[0], b = e2[1], c = e2[3], d = e2[4];
      e2[0] = cr * a + sr * c;
      e2[1] = cr * b + sr * d;
      e2[3] = -sr * a + cr * c;
      e2[4] = -sr * b + cr * d;
      skeleton.update();
    }
  }
  // 缩放
  if (hasScale) {
    setWorldScaleX(skeleton, bone, worldScaleX(bone) * (1 + state.scaleOffset * mix * ctx.scaleX));
  }

  // ---- 缓存本帧尖端（供下一帧滞后参考）----
  const e2 = bone.worldMatrix.elements;
  state.tipX = e2[6] + boneLen * Math.cos(worldRotation(bone));
  state.tipY = e2[7] + boneLen * Math.sin(worldRotation(bone));
}

/** 把偏移/速度清零（骨骼跳到新位置时应重置，避免旧偏移带到新姿势）。 */
export function resetPhysicsState(state: PhysicsRuntimeState): void {
  const fresh = createPhysicsRuntime();
  Object.assign(state, fresh);
}

/** 应用一组物理约束（按顺序）。调用前必须已 skeleton.update() 过。 */
export function applyPhysicsConstraints(
  skeleton: Skeleton,
  contexts: PhysicsSolveContext[],
  delta: number,
): void {
  for (const ctx of contexts) {
    if (ctx.mix <= 0) continue;
    solvePhysics(skeleton, ctx, delta);
  }
}
