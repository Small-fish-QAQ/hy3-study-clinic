import { normalizeMarkdown, normalizedDocumentToSourceBlocks } from '../ingestion/normalized.js';
/** Parser QA fixture. Product ingestion uses complete structural spans in CourseSources. */
export function segmentMaterial(
  materialId: string,
  content: string,
  options: {
    pageSpans?: { pageNumber: number; startOffset: number; endOffset: number }[];
    idSeed?: string;
  } = {},
) {
  const document = normalizeMarkdown({
    revisionId: 'fixture',
    sourceType: 'md',
    mediaType: 'text/markdown',
    content,
    ...options,
  });
  return normalizedDocumentToSourceBlocks(materialId, document, options);
}
