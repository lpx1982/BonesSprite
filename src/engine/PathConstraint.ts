import { Bone } from './Bone';
import { Skeleton } from './Skeleton';
import type { PathData, PathVertex } from '@psd/types';
import type { PathSpacingMode, PathRotateMode } from '../editor/store';

/**
 * 路径约束解算（仿 Spine 3.8 PathConstraint 的核心算法）。
 *
 * 让一串骨骼沿一条路径（目标插槽激活的 PathAttachment）平移 + 旋转：
 *  - bones[0] 停在 position 处，后续骨骼按 spacing 沿弧长依次推进。
 *  - 旋转模式：
 *      tangent   ：每根骨指向它所在弧长处的路径切线
 *      chain     ：首根指向切线，其余骨继承前一根解算后的世界旋转
 *      chainScale：同 chain，并额外按「推进弧长 / 骨长度」缩放 scaleX
 *  - translateMix / rotateMix：在「原始世界变换」和「路径解算变换」之间混合
 *    （0 = 完全不受约束）。
 *
 * 约定（与 IkConstraint 一致）：
 *  - 约束操作的是骨骼的 **world** 变换，解算完成后换算回 local 写回，
 *    再重算其 world 矩阵（每写一根调一次 skeleton.update()，
 *    chain / chainScale 依赖前一根更新后的世界矩阵）。
 *  - 路径点先在路径附件**局部**坐标采样，再用 slotWorld（6 元组仿射，
 *    与渲染时 applyBindings 的 wrap 矩阵同源）变换到**世界**坐标，
 *    之后全部推进 / 旋转都在世界空间完成。
 */

/** 解算所需的骨骼上下文（由调用方从 store 组装）。 */
export interface PathSolveContext {
  /** 受约束骨骼，顺序 = 沿路径顺序（bones[0] 在 position 处） */
  bones: Bone[];
  /** 6 元组 [a,b,c,d,tx,ty]：路径附件局部 → 引擎世界（调用方组装，与渲染 wrap 矩阵同源） */
  slotWorld: number[];
  path: PathData;
  positionMode: 'fixed' | 'percent';
  position: number;
  spacingMode: PathSpacingMode;
  spacing: number;
  rotateMode: PathRotateMode;
  rotateMix: number;
  translateMix: number;
  /** 切线角的额外偏移（度） */
  rotationOffset: number;
}

/** 曲线段细分：三次贝塞尔段固定 32 细分；无柄直线段 2 细分即可。 */
const SEG_SUBDIV = 32;
const LINE_SUBDIV = 2;

/** 段是否为直线段（两侧都没有控制柄 —— 与编辑器 drawPathCurve 的 hasCtl 判定一致）。 */
function isLineSegment(a: PathVertex, b: PathVertex): boolean {
  return a.handleOutX === 0 && a.handleOutY === 0 && b.handleInX === 0 && b.handleInY === 0;
}

/** 段内采样点（含参数 t），供弧长 / 最近点 / 恒速定位共用。
 *  ★ 无柄直线段走线性插值（与编辑器渲染的 lineTo 一致）——三次贝塞尔在
 *    控制点与端点重合时**不是**直线，不能当直线用。
 *  subdivOverride：覆盖细分数量（pathNearestT 需要更高的命中精度）。 */
function sampleSegment(
  a: PathVertex,
  b: PathVertex,
  line: boolean,
  subdivOverride?: number,
): Array<{ x: number; y: number; t: number }> {
  const subdiv = subdivOverride ?? (line ? LINE_SUBDIV : SEG_SUBDIV);
  const pts: Array<{ x: number; y: number; t: number }> = [];
  for (let i = 0; i <= subdiv; i++) {
    const t = i / subdiv;
    let x: number;
    let y: number;
    if (line) {
      x = a.x + (b.x - a.x) * t;
      y = a.y + (b.y - a.y) * t;
    } else {
      const mt = 1 - t;
      const p1x = a.x + a.handleOutX, p1y = a.y + a.handleOutY;
      const p2x = b.x + b.handleInX, p2y = b.y + b.handleInY;
      x = mt * mt * mt * a.x + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * b.x;
      y = mt * mt * mt * a.y + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * b.y;
    }
    pts.push({ x, y, t });
  }
  return pts;
}

/** 段弧长（用与 sampleSegment 相同的细分，保证各处一致）。 */
function segmentLength(a: PathVertex, b: PathVertex, line: boolean): number {
  const pts = sampleSegment(a, b, line);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return acc;
}

/**
 * 构建路径弧长表：每段终点累计长度。
 *  - 每段三次贝塞尔固定 32 细分（无柄直线段 2 细分）；
 *  - 闭合路径末段 = 末结 → 首结。
 *  - 返回 { segCount, cumLen }，cumLen 长度 = segCount + 1（cumLen[0] = 0，
 *    cumLen[segCount] = 总弧长）。
 */
export function buildPathLengthTable(path: PathData): { segCount: number; cumLen: number[] } {
  const v = path.vertices;
  const n = v.length;
  if (n < 2) return { segCount: 0, cumLen: [0] };
  const segCount = path.closed ? n : n - 1;
  const cumLen = new Array<number>(segCount + 1);
  cumLen[0] = 0;
  let acc = 0;
  for (let i = 0; i < segCount; i++) {
    const a = v[i];
    const b = v[(i + 1) % n];
    acc += segmentLength(a, b, isLineSegment(a, b));
    cumLen[i + 1] = acc;
  }
  return { segCount, cumLen };
}

/** 路径总弧长。 */
export function pathLengthOf(path: PathData): number {
  const table = buildPathLengthTable(path);
  return table.cumLen[table.segCount];
}

/** 段 seg 在参数 t 处的点 + 切线角（路径附件局部坐标；angle 为弧度）。 */
function pointAt(path: PathData, seg: number, t: number): { x: number; y: number; angle: number } {
  const v = path.vertices;
  const n = v.length;
  const a = v[seg];
  const b = v[(seg + 1) % n];
  let x: number;
  let y: number;
  let dx: number;
  let dy: number;
  if (isLineSegment(a, b)) {
    x = a.x + (b.x - a.x) * t;
    y = a.y + (b.y - a.y) * t;
    dx = b.x - a.x;
    dy = b.y - a.y;
  } else {
    const mt = 1 - t;
    const p1x = a.x + a.handleOutX, p1y = a.y + a.handleOutY;
    const p2x = b.x + b.handleInX, p2y = b.y + b.handleInY;
    x = mt * mt * mt * a.x + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * b.x;
    y = mt * mt * mt * a.y + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * b.y;
    dx = 3 * mt * mt * (p1x - a.x) + 6 * mt * t * (p2x - p1x) + 3 * t * t * (b.x - p2x);
    dy = 3 * mt * mt * (p1y - a.y) + 6 * mt * t * (p2y - p1y) + 3 * t * t * (b.y - p2y);
  }
  // 退化切线（例如闭合路径末段回到首结的折返段）→ 用段方向兜底
  if (dx === 0 && dy === 0) {
    dx = b.x - a.x;
    dy = b.y - a.y;
  }
  return { x, y, angle: Math.atan2(dy, dx) };
}

/**
 * 路径上参数 u（0..1）处的点与切线角（弧度）。
 *  - constantSpeed = true：按弧长均匀（用长度表二分定位，段内再按细分逼近 t）；
 *  - false：按段均匀（每段等权，段内参数线性）。
 * 返回的是路径附件**局部**坐标（世界化由调用方用 slotWorld 完成）。
 */
export function pathPointAt(path: PathData, u: number): { x: number; y: number; angle: number } {
  const v = path.vertices;
  const n = v.length;
  if (n === 0) return { x: 0, y: 0, angle: 0 };
  if (n === 1) return { x: v[0].x, y: v[0].y, angle: 0 };
  let uu = u;
  if (uu < 0) uu = 0;
  else if (uu > 1) uu = 1;
  const segCount = path.closed ? n : n - 1;

  if (!path.constantSpeed) {
    // 按段均匀：每段等权，段内线性 t
    let seg = Math.floor(uu * segCount);
    if (seg >= segCount) seg = segCount - 1;
    const t = uu * segCount - seg;
    return pointAt(path, seg, t);
  }

  // 按弧长均匀
  const table = buildPathLengthTable(path);
  const total = table.cumLen[table.segCount];
  if (total <= 0) return pointAt(path, 0, 0);
  const s = uu * total;
  // 二分找段：最后一段 cumLen <= s
  let lo = 0;
  let hi = table.segCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table.cumLen[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const seg = lo;
  const segStart = table.cumLen[seg];
  const segLen = table.cumLen[seg + 1] - segStart;
  if (segLen <= 1e-9) return pointAt(path, seg, 0);
  // 段内弧长 → 参数 t：对细分点二分逼近（弧长参数化非线性，细分插值足够准）
  const a = v[seg];
  const b = v[(seg + 1) % n];
  const pts = sampleSegment(a, b, isLineSegment(a, b));
  const target = s - segStart;
  let lo2 = 0;
  let hi2 = pts.length - 1;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2 + 1) >> 1;
    const acc = arcAt(pts, mid);
    if (acc <= target) lo2 = mid;
    else hi2 = mid - 1;
  }
  let t: number;
  if (lo2 >= pts.length - 1) {
    t = 1;
  } else {
    const accA = arcAt(pts, lo2);
    const accB = arcAt(pts, lo2 + 1);
    const f = accB > accA ? (target - accA) / (accB - accA) : 0;
    t = pts[lo2].t + (pts[lo2 + 1].t - pts[lo2].t) * f;
  }
  return pointAt(path, seg, t);
}

/** 采样点数组第 idx 个点的累计弧长（arcAt 是 O(idx) 的，采样点很少，够用）。 */
function arcAt(pts: Array<{ x: number; y: number; t: number }>, idx: number): number {
  let acc = 0;
  for (let i = 1; i <= idx; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return acc;
}

/**
 * 路径上离点 (px, py) 最近的参数 u（0..1，采样逼近）。
 * 供编辑器控制柄命中 / 拖动回写使用，与解算共用同一套贝塞尔数学。
 */
export function pathNearestT(path: PathData, px: number, py: number): number {
  const v = path.vertices;
  const n = v.length;
  if (n < 2) return 0;
  const segCount = path.closed ? n : n - 1;
  let bestSeg = -1;
  let bestI = -1;
  let bestPts: Array<{ x: number; y: number; t: number }> | null = null;
  let bestD = Infinity;
  for (let seg = 0; seg < segCount; seg++) {
    const a = v[seg];
    const b = v[(seg + 1) % n];
    // ★ 最近点命中用 4 倍细分（128 点/段）：直线段按线性插值采样是精确的，
    //   曲线段 128 点把拖动回写的量化误差压到亚像素（32 点在长段上会一格一格跳）。
    const pts = sampleSegment(a, b, isLineSegment(a, b), SEG_SUBDIV * 4);
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i].x - px) * (pts[i].x - px) + (pts[i].y - py) * (pts[i].y - py);
      if (d < bestD) {
        bestD = d;
        bestSeg = seg;
        bestI = i;
        bestPts = pts;
      }
    }
  }
  if (bestSeg < 0 || !bestPts) return 0;
  // ★ 必须返回与 pathPointAt **相同**的参数化，否则 gizmo 控制柄拖动回写会跳变：
  //   - constantSpeed = true：弧长归一化 u（该点弧长 / 总弧长）
  //   - false：按段均匀 (seg + t) / segCount
  //   （弧长用与 buildPathLengthTable 同一套采样累加，保证与 pathPointAt 一致。）
  if (!path.constantSpeed) return (bestSeg + bestPts[bestI].t) / segCount;
  const table = buildPathLengthTable(path);
  const total = table.cumLen[table.segCount];
  if (total <= 0) return 0;
  const arcLen = table.cumLen[bestSeg] + arcAt(bestPts, bestI);
  return Math.max(0, Math.min(1, arcLen / total));
}

// =================================================================================
//  解算
// =================================================================================

/** 求某骨骼的世界旋转角（弧度）。世界矩阵是 3x3 仿射矩阵
 *  [a  c  tx]
 *  [b  d  ty]
 *  世界旋转角 = atan2(b, a)。 */
function worldRotation(bone: Bone): number {
  const m = bone.worldMatrix.elements;
  return Math.atan2(m[1], m[0]);
}

/** 角度归一化到 [-PI, PI]，用于最短角插值。 */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 设置骨骼 local rotation，使它的世界旋转变为 targetWorldRot（mix 已由调用方算好）。 */
function setWorldRotation(skeleton: Skeleton, bone: Bone, targetWorldRot: number): void {
  const parentRot = bone.parent ? worldRotation(bone.parent) : 0;
  bone.local.rotation = normalizeAngle(targetWorldRot - parentRot);
  skeleton.update();
}

/** 设置骨骼 local 位置，使它的世界位置变为 (wx, wy)：父世界矩阵逆变换。 */
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

/** 设置骨骼 local scaleX，使它的世界 scaleX 变为 targetWorldSx
 *  （父级无 shear 时精确；父级有 shear 时是近似 —— 已知限制）。 */
function setWorldScaleX(skeleton: Skeleton, bone: Bone, targetWorldSx: number): void {
  const parentSx = bone.parent
    ? Math.hypot(bone.parent.worldMatrix.elements[0], bone.parent.worldMatrix.elements[1])
    : 1;
  const lsx = parentSx > 1e-6 ? targetWorldSx / parentSx : targetWorldSx;
  bone.local.scaleX = Math.max(1e-4, lsx);
  skeleton.update();
}

/** 解算一条路径约束（逐骨推进 + 旋转 + 混合回写）。 */
function solve(skeleton: Skeleton, ctx: PathSolveContext): void {
  const { bones, slotWorld, path, rotateMix, translateMix, rotateMode } = ctx;
  const n = bones.length;
  if (n === 0) return;

  // 1) 世界化：路径附件局部点 → 引擎世界（slotWorld 6 元组仿射），切线角同源变换
  const toWorld = (u: number): { x: number; y: number; angle: number } => {
    const p = pathPointAt(path, u);
    const x = slotWorld[0] * p.x + slotWorld[2] * p.y + slotWorld[4];
    const y = slotWorld[1] * p.x + slotWorld[3] * p.y + slotWorld[5];
    const cosA = Math.cos(p.angle);
    const sinA = Math.sin(p.angle);
    const dx = slotWorld[0] * cosA + slotWorld[2] * sinA;
    const dy = slotWorld[1] * cosA + slotWorld[3] * sinA;
    return { x, y, angle: Math.atan2(dy, dx) };
  };

  const total = pathLengthOf(path);

  // 2) 记录每根骨解算前的世界位置与旋转角（混合用）
  const orig = bones.map((b) => {
    const e = b.worldMatrix.elements;
    return { x: e[6], y: e[7], rot: Math.atan2(e[1], e[0]) };
  });

  // 3) 沿路径推进
  //    t0 = position 起点（percent = position/100 × 总弧长；fixed = 像素）
  let arc = ctx.positionMode === 'percent' ? (ctx.position / 100) * total : ctx.position;
  const clampArc = (a: number): number => {
    if (path.closed) {
      if (total > 0) return ((a % total) + total) % total;
      return a;
    }
    return Math.max(0, Math.min(total, a));
  };
  arc = clampArc(arc);

  const rotationOffsetRad = (ctx.rotationOffset * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const bone = bones[i];
    // 每根骨相对前一根骨的推进距离（bones[0] 停在 position 处，advance = 0）
    let advance = 0;
    if (i > 0) {
      const prev = bones[i - 1];
      switch (ctx.spacingMode) {
        case 'length':
          advance = ctx.spacing + prev.length;
          break;
        case 'fixed':
          advance = ctx.spacing;
          break;
        case 'percent':
          advance = (ctx.spacing / 100) * total;
          break;
        case 'proportional':
          // Spine 3.8：proportional = (本骨长度 + 前骨长度) × spacing（spacing 是比例系数，不除 2）
          advance = ctx.spacing * (prev.length + bone.length);
          break;
      }
      arc = clampArc(arc + advance);
    }
    const u = total > 0 ? arc / total : 0;
    const desired = toWorld(u);

    // 4) 旋转目标（世界角，弧度）
    let desiredRot: number;
    if (i === 0 || rotateMode === 'tangent') {
      desiredRot = desired.angle + rotationOffsetRad;
    } else {
      // chain / chainScale：继承前一根解算后的世界旋转
      desiredRot = worldRotation(bones[i - 1]) + rotationOffsetRad;
    }

    // 5) 混合回写（逐骨）
    if (translateMix > 0) {
      const fx = orig[i].x + (desired.x - orig[i].x) * translateMix;
      const fy = orig[i].y + (desired.y - orig[i].y) * translateMix;
      setWorldPosition(skeleton, bone, fx, fy);
    }
    if (rotateMix > 0) {
      const finalRot = orig[i].rot + normalizeAngle(desiredRot - orig[i].rot) * rotateMix;
      setWorldRotation(skeleton, bone, finalRot);
    }
    // chainScale：额外按「本骨推进弧长 / 骨长度」设世界 scaleX（长度 0 时跳过缩放）
    if (rotateMode === 'chainScale' && rotateMix > 0 && i > 0 && bone.length > 0) {
      const targetWorldSx = Math.max(1e-4, advance / bone.length);
      setWorldScaleX(skeleton, bone, targetWorldSx);
    }
  }
}

/**
 * 应用一组路径约束（按顺序）。
 * 调用前必须已经 skeleton.update() 过一次（保证初始世界矩阵正确）。
 * 与 IK 的顺序约定：调用方先全部 IK 后全部 Path（Spine 固定顺序）。
 */
export function applyPathConstraints(skeleton: Skeleton, contexts: PathSolveContext[]): void {
  for (const ctx of contexts) {
    if (ctx.rotateMix <= 0 && ctx.translateMix <= 0) continue;
    solve(skeleton, ctx);
  }
}
