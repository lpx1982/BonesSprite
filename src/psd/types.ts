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

/**
 * 网格附件数据（仿 Spine 的 Mesh Attachment）。
 *
 * 正常附件（区域附件）只有 4 个角顶点、只能整体变换；网格附件把图片切成
 * 三角网格，**每个顶点可以各自移动**，于是图片能被弯曲 / 拉扯成任意形状。
 *
 * - `vertices`：顶点位置，**附件局部坐标**（相对图层 left/top 的像素）。
 *   与 Sprite 同一个坐标系，所以骨骼绑定 / 插槽变换 / 颜色混合等现有逻辑可直接复用。
 * - `uvs`：纹理坐标，归一化 0..1。创建时按网格算好，**之后固定不变**。
 * - `indices`：三角形索引，每 3 个一组。
 *
 * 变形原理：UV 固定、顶点位置可变 —— 纹理跟着顶点走，图片随之弯曲。
 * 「重置」= 把每个顶点移回它 UV 对应的位置（uv × 图层尺寸），从而消除变形。
 */
export interface MeshData {
  vertices: number[];
  uvs: number[];
  indices: number[];
  /**
   * 权重绑定数据（仿 Spine Mesh Attachment.weights）。
   *  - `bones`：参与绑定的骨骼 id 列表（去重，顺序稳定 = 自动权重写入顺序）
   *  - `weights`：每顶点一组，长度 = bones.length；w_i = 该顶点对 bones[i] 的权重（0..1）
   *    数组长度 = vertices.length / 2 * bones.length；字段名命名为 flatWeights 避免误解。
   *  - `bindPose`：绑定姿态下的顶点坐标（**附件局部坐标**）。
   *    渲染时：v = Σ w_i · M_i · bindPose   （M_i = 骨骼 i 的世界矩阵）
   *  未绑定（bones.length === 0）时退化为「整图跟随插槽骨骼」，
   *  此时 vertices 直接被当作显示位置（无变形叠加）。
   */
  bones?: string[];
  weights?: number[];
  bindPose?: number[];
}
