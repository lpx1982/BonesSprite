/**
 * PixiBones 内部使用的 PSD 结构，比 ag-psd 自带的类型更精简。
 *
 * - canvas 字段是 ag-psd 已经渲染好的 HTMLCanvasElement，可以直接喂给 PixiJS Texture
 * - id 是 PixiBones 内部生成的稳定 id（同一图层多次解析 id 不变需要额外缓存）
 * - blendMode 已经是 PixiJS v8 合法的 blend 字符串
 */
export interface PixiBonesLayer {
  /** 内部稳定 id（每次解析都会重新生成，跨次解析不一致）。 */
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0..1 的透明度。 */
  opacity: number;
  visible: boolean;
  /** 已经是 PixiJS v8 合法的 blend 字符串。 */
  blendMode: string;
  /** ag-psd 已经把图层渲染到这个 canvas 里，直接给 PixiJS Texture.from() 用即可。 */
  canvas: HTMLCanvasElement | undefined;
  /** 子图层（Photoshop 的"图层组"）。 */
  children: PixiBonesLayer[];
}

export interface PixiBonesPsd {
  width: number;
  height: number;
  layers: PixiBonesLayer[];
}
