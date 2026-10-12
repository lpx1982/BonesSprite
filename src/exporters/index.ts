/**
 * Spine v3.8 兼容 JSON 导出器（psd2spine 风格）。
 * 具体导出逻辑见 exportSpineData.ts：ProjectData → Spine JSON 字符串 / 文件下载。
 */
export { buildSpineJson, buildSpineObject, exportSpineJsonFile } from './exportSpineData';
export const EXPORTER_VERSION = '0.1.0-day6';
