import type { PixiBonesLayer } from './types';

/** 图片素材 id 自增计数器。 */
let _imgCounter = 0;
function genImageId(): string {
  return `image_${++_imgCounter}_${Date.now().toString(36)}`;
}

/**
 * 把一张普通图片文件（PNG / JPG / WebP…）解析成一个「图片素材」。
 *
 * 产出的结构与 PSD 图层完全一致（PixiBonesLayer），所以渲染、显隐、绑定骨骼
 * 这些逻辑都不需要为它单独写一套。
 *
 * @param file   图片文件
 * @param origin 期望放置的位置（画布世界坐标的左上角）；省略时放在原点
 */
export async function parseImageFile(
  file: File,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): Promise<PixiBonesLayer> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 上下文');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const name = file.name.replace(/\.[^.]+$/, '') || file.name;
  return {
    id: genImageId(),
    name,
    left: Math.round(origin.x),
    top: Math.round(origin.y),
    width: canvas.width,
    height: canvas.height,
    opacity: 1,
    visible: true,
    blendMode: 'normal',
    canvas,
    children: [],
  };
}
