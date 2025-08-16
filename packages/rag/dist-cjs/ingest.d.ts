import { Config } from '@google/gemini-cli-core';
export interface IngestOptions {
    board?: string;
    tag?: string[];
    watch?: boolean;
    config?: Config;
}
export type ChunkMetadata = {
    source: string;
    page?: number;
    path?: string;
    board?: string;
    tag?: string[];
    mime?: string;
    hash?: string;
    ingestedAt: string;
};
export type StoredChunk = {
    id: string;
    content: string;
    embedding: number[];
    metadata: ChunkMetadata;
};
/**
 * Ingest a list of files/directories into the local RAG store.
 */
export declare function ingest(paths: string[], opts?: IngestOptions): Promise<void>;
