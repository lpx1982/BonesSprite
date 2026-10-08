import { parsePsd, parseImageFile } from '@psd/index';
import { usePixiBonesStore } from './store';

/**
 * 导入一个素材文件。
 *
 * - `.psd`  → 解析成 PSD（图层作为素材挂在层级树「图片」节点下）
 * - 图片（png/jpg/webp/gif/bmp） → 作为一张独立素材追加到 store.images
 *
 * @returns 是否成功导入
 */
export async function importAssetFile(file: File): Promise<boolean> {
  const lower = file.name.toLowerCase();
  const st = usePixiBonesStore.getState();

  if (lower.endsWith('.psd')) {
    const result = await parsePsd(file);
    if (result.layers.length === 0) return false;
    st.setPsd(result);
    // 工程名跟文件名走（层级树顶部的工程节点会显示它）
    st.setProjectName(file.name.replace(/\.psd$/i, '') || st.projectName);
    return true;
  }

  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(lower)) {
    // 图片放在当前内容中心（没有 PSD 时放原点）
    const origin = st.psd
      ? { x: st.psd.width / 2, y: st.psd.height / 2 }
      : { x: 0, y: 0 };
    const layer = await parseImageFile(file, origin);
    st.addImage(layer);
    return true;
  }

  return false;
}
