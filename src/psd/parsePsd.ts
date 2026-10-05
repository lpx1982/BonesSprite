import { readPsd, type Layer as AgPsdLayer, type Psd as AgPsd } from 'ag-psd';
import type { PixiBonesLayer, PixiBonesPsd } from './types';
import { mapBlendMode } from './blendMode';

/** id 自增计数器 —— 单次解析内稳定，跨解析不保证一致。 */
let _idCounter = 0;
function genId(): string {
  return `layer_${++_idCounter}_${Date.now().toString(36)}`;
}

/** 递归转换 ag-psd 的 Layer 到我们的内部 PixiBonesLayer。 */
function convertLayer(ag: AgPsdLayer): PixiBonesLayer {
  const left = ag.left ?? 0;
  const top = ag.top ?? 0;
  const right = ag.right ?? 0;
  const bottom = ag.bottom ?? 0;
  return {
    id: genId(),
    name: ag.name ?? '(unnamed)',
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    opacity: ag.opacity ?? 1, // ag-psd 已归一化到 0..1，不要再除
    visible: ag.hidden !== true,
    blendMode: mapBlendMode(ag.blendMode),
    canvas: ag.canvas,
    children: (ag.children ?? []).map(convertLayer),
  };
}

/**
 * 把 PSD 解析成 PixiBones 内部结构。
 *
 * ag-psd 配置：
 *   skipLayerImageData: false   ← 必须保留每个图层的 canvas（我们要拿来渲染）
 *   skipThumbnail: true         ← 不需要主缩略图
 *   useImageData: false         ← 用 canvas 更省内存
 */
export async function parsePsd(file: File): Promise<PixiBonesPsd> {
  const buffer = await file.arrayBuffer();
  const psd: AgPsd = readPsd(buffer, {
    skipLayerImageData: false,
    skipThumbnail: true,
    useImageData: false,
  });

  return {
    width: psd.width ?? 0,
    height: psd.height ?? 0,
    layers: (psd.children ?? []).map(convertLayer),
  };
}

/** 把嵌套的图层树展平成数组（保留顺序：Photoshop 顶层在最前）。 */
export function flattenLayers(psd: PixiBonesPsd): PixiBonesLayer[] {
  const result: PixiBonesLayer[] = [];
  const walk = (layers: PixiBonesLayer[]): void => {
    for (const layer of layers) {
      result.push(layer);
      if (layer.children.length > 0) walk(layer.children);
    }
  };
  walk(psd.layers);
  return result;
}

/** 计算 PSD 的"实际有内容的边界框"。 */
export function getContentBounds(psd: PixiBonesPsd): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (l: PixiBonesLayer): void => {
    if (l.canvas) {
      minX = Math.min(minX, l.left);
      minY = Math.min(minY, l.top);
      maxX = Math.max(maxX, l.left + l.width);
      maxY = Math.max(maxY, l.top + l.height);
    }
    for (const c of l.children) visit(c);
  };
  for (const l of psd.layers) visit(l);
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
