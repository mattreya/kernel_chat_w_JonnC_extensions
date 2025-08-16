export type ChunkMeta = {
  /** Absolute or relative source path, e.g., "datasheets/AM62x_TRM.pdf" */
  source: string;
  /** Page number if applicable (PDF/HTML) */
  page?: number;
  /** Logical section or path within the document */
  path?: string;
  /** Board identifier (accepted but unused for v0.1) */
  board?: string;
  /** Optional user-defined tags */
  tag?: string[];
  /** MIME type of the original document */
  mime: string;
  /** SHA-256 hash of the original chunk */
  hash: string;
  /** ISO timestamp of ingestion */
  ingestedAt: string;
};

export type Retrieved = {
  id: string;
  pageContent: string;
  score: number;
  metadata: ChunkMeta;
};
