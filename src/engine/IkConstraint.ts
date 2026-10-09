import { Bone } from './Bone';
import { Skeleton } from './Skeleton';

/**
 * IK 约束解算（仿 Spine 3.8 IkConstraint 的核心算法）。
 *
 * 约定：
 *  - 约束操作的是骨骼的 **world** 变换（位置 / 旋转），解算完成后把结果
 *    换算回 local rotation 写回骨骼，再重算其 world 矩阵。
 *  - 单骨 IK：让 bone 旋转指向 target（bone 的"指向" = 骨骼 +X 轴方向，
 *    即骨骼长轴方向）。
 *  - 双骨 IK：parent + child 组成两节链，让 child 的末端落在 target 上。
 *    用余弦定理（两节固定长度）解出 parent / child 的旋转角，
 *    bendDirection 决定弯曲方向（1 逆时针 / -1 顺时针）。
 *  - mix：0..1，在「原始旋转」和「IK 解算旋转」之间线性插值（最短角插值）。
 */

/** 解算所需的骨骼上下文（由调用方从 store 组装）。 */
export interface IkSolveContext {
  /** 受约束的第一根骨骼（单骨 IK 即这根） */
  bone: Bone;
  /** 双骨 IK 的第二根骨骼（可空） */
  child: Bone | null;
  /** 目标骨骼 */
  target: Bone;
  /** 弯曲方向（双骨 IK）：1 / -1 */
  bendDirection: 1 | -1;
  /** 混合程度 0..1 */
  mix: number;
}

/**
 * 求某骨骼的世界旋转角（弧度）。世界矩阵是 3x3 仿射矩阵
 * [c*sx  -s*sy  tx]
 * [s*sx   c*sy  ty]
 * 世界旋转角 = atan2(m[1], m[0])。
 */
function worldRotation(bone: Bone): number {
  const m = bone.worldMatrix.elements;
  return Math.atan2(m[1], m[0]);
}

/**
 * 求某骨骼的世界位置（x, y）。
 */
function worldPos(bone: Bone): { x: number; y: number } {
  const m = bone.worldMatrix.elements;
  return { x: m[6], y: m[7] };
}

/**
 * 求某骨骼末梢的世界位置（沿 +X 方向 length 处）。
 */
function worldTip(bone: Bone): { x: number; y: number } {
  const m = bone.worldMatrix.elements;
  const len = bone.length;
  return { x: m[6] + m[0] * len, y: m[7] + m[1] * len };
}

/** 角度归一化到 [-PI, PI]，用于最短角插值。 */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * 设置某骨骼的 local rotation，使它的世界旋转变为目标值。
 * 需要先知道它的父骨世界旋转（若父骨存在），反解 local = 目标 - 父世界旋转。
 * 之后调用 skeleton.update() 重算世界矩阵。
 */
function setWorldRotation(skeleton: Skeleton, bone: Bone, targetWorldRot: number, mix: number): void {
  const parentRot = bone.parent ? worldRotation(bone.parent) : 0;
  const desiredLocal = normalizeAngle(targetWorldRot - parentRot);
  // mix 插值：当前 local rotation → desiredLocal
  const curLocal = bone.local.rotation;
  const delta = normalizeAngle(desiredLocal - curLocal);
  bone.local.rotation = curLocal + delta * mix;
  skeleton.update();
}

/** 单骨 IK：让 bone 的 +X 轴指向 target 的世界位置。 */
function solveSingleBone(skeleton: Skeleton, ctx: IkSolveContext): void {
  const { bone, target, mix } = ctx;
  const p = worldPos(bone);
  const t = worldPos(target);
  const desiredRot = Math.atan2(t.y - p.y, t.x - p.x);
  setWorldRotation(skeleton, bone, desiredRot, mix);
}

/** 双骨 IK：parent + child 两节链，child 末端落到 target。 */
function solveTwoBone(skeleton: Skeleton, ctx: IkSolveContext): void {
  const { bone: parent, child, target, bendDirection, mix } = ctx;
  if (!child) { solveSingleBone(skeleton, ctx); return; }

  const pa = worldPos(parent);      // 关节 A（parent 原点）
  const pb = worldPos(child);       // 关节 B（parent 末端 = child 原点）
  const tip = worldTip(child);      // C（child 末端）
  const t = worldPos(target);       // 目标点

  const a = parent.length;          // 第一节长度
  const b = child.length;           // 第二节长度
  const ab = Math.sqrt((pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2);
  const at = Math.sqrt((t.x - pa.x) ** 2 + (t.y - pa.y) ** 2);

  // 余弦定理：求 parent 应转过的角度（∠A 的变化）
  // 三角形 APT 中：边 AT 对面是 angle 1（在 A 点）
  //   cos1 = (a² + at² - b²) / (2·a·at)
  const cosAngle1 = (a * a + at * at - b * b) / (2 * a * at);
  const angle1 = Math.acos(Math.min(1, Math.max(-1, cosAngle1)));

  // 当前 parent 指向 target 的角度
  const parentToTarget = Math.atan2(t.y - pa.y, t.x - pa.x);
  // 当前 parent 的世界旋转角
  const parentRot = worldRotation(parent);
  // parent 应旋转到：指向 target 且按 bendDirection 弯曲
  //   bendDirection=1（逆时针）：parent 指向 target 再逆时针偏 angle1
  //   即 targetRot = parentToTarget + bendDirection * angle1
  const desiredParentRot = parentToTarget + bendDirection * angle1;

  // 应用 mix 并写回 parent
  setWorldRotation(skeleton, parent, desiredParentRot, mix);

  // 现在 parent 已旋转，child 的世界位置变化了，需要重算
  const p2 = worldPos(parent);
  const c2 = worldPos(child);

  // 三角形 BC: child 应旋转使 C 指向 T
  const cToT = Math.atan2(t.y - c2.y, t.x - c2.x);
  const childRot = worldRotation(child);
  // 期望 child 世界旋转 = 指向 target
  // 弯曲：child 相对 parent 的旋转由 bendDirection 决定，
  // 我们让 child 直接指向 target（C→T 方向），这样末端精确落在 target 上
  setWorldRotation(skeleton, child, cToT, mix);
}

/**
 * 应用一组 IK 约束（按顺序）。
 * 调用前必须已经 skeleton.update() 过一次（保证初始世界矩阵正确）。
 */
export function applyIkConstraints(skeleton: Skeleton, contexts: IkSolveContext[]): void {
  for (const ctx of contexts) {
    if (ctx.mix <= 0) continue;
    if (ctx.child) solveTwoBone(skeleton, ctx);
    else solveSingleBone(skeleton, ctx);
  }
}
