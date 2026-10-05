import type { TransformLike } from './math/Transform';

/**
 * Spine v3.8 兼容 JSON 的占位定义。
 * 完整定义会在 Day 6 导出器开发时补齐。
 */
export interface SpineJSON {
  skeleton: {
    bones: Array<{
      name: string;
      parent?: string;
      length?: number;
      x?: number;
      y?: number;
      rotation?: number;
      scaleX?: number;
      scaleY?: number;
    }>;
  };
  animations?: Record<
    string,
    {
      bones?: Record<
        string,
        Record<
          keyof TransformLike,
          { time: number; value: number; curve?: 'linear' | 'stepped' | number[] | string }[]
        >
      >;
    }
  >;
}

/** PixiBones 内部工程文件结构（占位）。 */
export interface PixiBonesProject {
  version: string;
  skeleton: {
    root: string;
    bones: Array<{
      name: string;
      parent: string | null;
      transform: TransformLike;
      length: number;
    }>;
  };
  animations: Array<{
    name: string;
    duration: number;
    tracks: Array<{
      bone: string;
      property: keyof TransformLike;
      keyframes: Array<{ time: number; value: number }>;
    }>;
  }>;
}
