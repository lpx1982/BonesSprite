/**
 * Spine v3.8 兼容 JSON 导出器 —— Day 6 实现。
 * Day 1 仅占位导出 `version` 字段。
 */
export const EXPORTER_VERSION = '0.1.0-day1-placeholder';

export function exportPlaceholder(): { version: string; note: string } {
  return {
    version: EXPORTER_VERSION,
    note: 'Spine v3.8 JSON exporter will be implemented in Day 6.',
  };
}
