import type { Bone } from './Bone';
import type { Skeleton } from './Skeleton';
import type { Track } from './Track';
import type { TransformLike } from './math/Transform';

/** 单条轨道绑定：骨骼 + 属性名 + 轨道。 */
export interface TrackBinding {
  bone: Bone;
  property: keyof TransformLike;
  track: Track<number>;
}

/**
 * 一段动画：一组轨道绑定 + 时长。播放时把所有轨道采样到骨骼 local，
 * 再调用 skeleton.update() 刷新世界矩阵。
 */
export class Animation {
  name: string;
  duration: number;
  tracks: TrackBinding[] = [];

  constructor(name: string, duration: number) {
    this.name = name;
    this.duration = duration;
  }

  addTrack(bone: Bone, property: keyof TransformLike, track: Track<number>): this {
    this.tracks.push({ bone, property, track });
    return this;
  }

  /**
   * 在时间 t 处应用动画。t 会按 duration wrap（首尾相接）。
   */
  apply(skeleton: Skeleton, t: number): void {
    const wrapped = ((t % this.duration) + this.duration) % this.duration;
    for (const { bone, property, track } of this.tracks) {
      const value = track.sample(wrapped);
      bone.local[property] = value;
    }
    skeleton.update();
  }
}
