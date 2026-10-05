/**
 * 通用关键帧。
 *
 * - time: 时间（秒）。
 * - value: 该时刻采样出的值，类型由轨道决定（number 或 Vec2Like）。
 * - cx1/cy1/cx2/cy2: 可选的 Bezier 缓动控制点（与 Spine 相同语义）。
 *   出向段用 cx1/cy1；入向段用 cx2/cy2。值为 0..1 的归一化坐标。
 */
export interface Keyframe<T = number> {
  time: number;
  value: T;
  /** 出向段控制点（time=0..1）。 */
  cx1?: number;
  cy1?: number;
  /** 入向段控制点（time=0..1）。 */
  cx2?: number;
  cy2?: number;
}
