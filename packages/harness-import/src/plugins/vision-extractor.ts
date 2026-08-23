/**
 * vision-extractor —— 图片 / 截图 / 手机拍照 → 视觉模型输入（必须插件）。
 *
 * 职责只有"组装视觉请求载荷"，识别本身交给 supportsVision 的 provider。
 */

export function toImageDataUrl(fileBase64: string, mime?: string): string {
  const m = mime && mime.startsWith("image/") ? mime : "image/jpeg";
  return `data:${m};base64,${fileBase64}`;
}
