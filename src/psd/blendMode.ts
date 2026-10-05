/**
 * ag-psd 输出的 blendMode 是 Photoshop 的字符串命名（'color burn' / 'linear dodge' 等），
 * PixiJS v8 用的是另一套（带连字符的小写）。
 * 这里做映射 + fallback 到 'normal'，保证 Pixi 永远拿到合法值。
 */

const MODE_MAP: Record<string, string> = {
  'normal': 'normal',
  'dissolve': 'normal',
  'pass through': 'normal',

  'darken': 'darken',
  'multiply': 'multiply',
  'color burn': 'color-burn',
  'linear burn': 'color-burn',
  'darker color': 'darken',

  'lighten': 'lighten',
  'screen': 'screen',
  'color dodge': 'color-dodge',
  'linear dodge': 'add',
  'lighter color': 'lighten',

  'overlay': 'overlay',
  'soft light': 'soft-light',
  'hard light': 'hard-light',
  'vivid light': 'hard-light',
  'linear light': 'linear-light',
  'pin light': 'pin-light',
  'hard mix': 'hard-mix',

  'difference': 'difference',
  'exclusion': 'exclusion',
  'subtract': 'subtract',
  'divide': 'divide',

  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
};

const PIXI_VALID = new Set([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'linear-burn', 'hard-light', 'soft-light',
  'linear-light', 'pin-light', 'hard-mix', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity', 'add', 'subtract', 'divide',
]);

export function mapBlendMode(agMode: string | undefined): string {
  if (!agMode) return 'normal';
  const normalized = agMode.toLowerCase().trim();
  const mapped = MODE_MAP[normalized] ?? normalized;
  if (!PIXI_VALID.has(mapped)) return 'normal';
  return mapped;
}
