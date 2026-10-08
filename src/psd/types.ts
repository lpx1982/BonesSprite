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

/**
 * 插槽（仿 Spine）。
 *
 * - 插槽是「附件的容器」，本身**没有位置、也不绘制**；绘制的是它当前激活的那个附件。
 * - 一个插槽可持有多个附件，任意时刻只有一个可见（activeAttachmentId）。
 * - 绘制顺序、显隐、绑定骨骼、slot 变换，都属于**插槽**（而不是附件）。
 * - 导入时默认「1 个图层 = 1 个插槽，该图层作为它的第 1 个附件」。
 *
 * 引用关系：插槽通过 attachmentIds **引用**素材（PixiBonesLayer）。素材是全局的
 * （不属于任何插槽），**同一素材可被多个插槽同时引用** —— 例如一把枪同时给
 * 左手 / 右手两个插槽用，两处各自渲染一份。
 */
export interface PixiBonesSlot {
  id: string;
  name: string;
  /** 持有的附件 id 列表（对应 PixiBonesLayer.id） */
  attachmentIds: string[];
  /** 当前显示的附件 id；null = 该插槽不显示任何附件 */
  activeAttachmentId: string | null;
}
