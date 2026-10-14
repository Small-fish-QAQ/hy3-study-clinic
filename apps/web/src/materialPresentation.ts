/** A reading title only. The upload always retains File.name as its filename. */
export function friendlyFilename(filename: string): string {
  let title = filename;
  if (/%[0-9a-f]{2}/iu.test(filename)) {
    try {
      const decoded = decodeURIComponent(filename);
      const unsafe = Array.from(decoded).some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127 ||
          character === '/' ||
          character === '\\',
      );
      if (!unsafe) title = decoded;
    } catch {
      // Literal or malformed percent sequences remain literal. Never decode repeatedly.
    }
  }
  return title.replace(/\.[a-z0-9]+$/iu, '') || title;
}
export const MATERIAL_FORMATS = '文本层 PDF、DOCX、PPTX、Markdown、TXT、HTML 和常见源码文件';
export const MATERIAL_LIMITS = '扫描页、图表或公式的提取可能不完整，请查看处理提示并补充文字说明。';
