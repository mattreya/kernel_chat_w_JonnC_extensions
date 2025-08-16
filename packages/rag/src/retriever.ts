// packages/rag/src/retriever.ts

/*
 * Simple hybrid retriever for the local RAG store (v0.1).
 *
 * Hybrid approach (first pass):
 *   1. Vector similarity (cosine) on embeddings produced during ingestion.
 *   2. Keyword score (BM25-like) using term frequency in the chunk.
 *   3. Reciprocal rank fusion to combine the two rankings.
 *
 * This is intentionally lightweight for the initial milestone and can be
 * replaced with Chroma or a proper ANN index later.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Config, GeminiClient } from '@google/gemini-cli-core';
import { createHash } from 'node:crypto';

const DEFAULT_STORE_DIR = '.gemini/rag_store';
const CHUNKS_FILE = 'chunks.jsonl';

export type Retrieved = {
  id: string;
  pageContent: string;
  score: number;
  metadata: {
    source: string;
    page?: number;
    path?: string;
    board?: string;
    tag?: string[];
  };
};

interface RetrieverOptions {
  topk?: number;
  board?: string;
  tag?: string | string[];
  config?: Config; // used for embeddings
}

interface StoredRecord {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    source: string;
    page?: number;
    path?: string;
    board?: string;
    tag?: string[];
    mime?: string;
  };
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function bm25Score(tokensQ: string[], docTokens: string[]): number {
  // Very naive: count overlap / doc length.
  const docLen = docTokens.length;
  if (docLen === 0) return 0;
  const freq: Record<string, number> = {};
  docTokens.forEach((t) => (freq[t] = (freq[t] || 0) + 1));
  let score = 0;
  for (const t of tokensQ) {
    if (freq[t]) score += freq[t];
  }
  return score / docLen;
}

function reciprocalRankFusion(posVec: number, posKey: number, k1 = 60, k2 = 60): number {
  // RRF: 1/(k + rank)
  return 1 / (k1 + posVec) + 1 / (k2 + posKey);
}

async function loadStore(storeDir: string): Promise<StoredRecord[]> {
  const file = path.join(storeDir, CHUNKS_FILE);
  try {
    const data = await fs.readFile(file, 'utf8');
    return data
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function retrieve(
  q: string,
  opts: RetrieverOptions = {},
): Promise<Retrieved[]> {
  const storeDir = path.resolve(opts.config?.getProjectRoot() ?? process.cwd(), DEFAULT_STORE_DIR);
  const records = await loadStore(storeDir);
  if (records.length === 0) return [];

  // tag filter pre-pass
  const tagFilter = opts.tag
    ? Array.isArray(opts.tag)
      ? new Set(opts.tag.map((t) => t.toLowerCase()))
      : new Set(opts.tag.split(',').map((t) => t.trim().toLowerCase()))
    : null;
  const boardFilter = opts.board?.toLowerCase();

  const filtered = records.filter((r) => {
    if (tagFilter) {
      const tags = r.metadata.tag?.map((t) => t.toLowerCase()) || [];
      const hasAny = tags.some((t) => tagFilter.has(t));
      if (!hasAny) return false;
    }
    if (boardFilter && r.metadata.board?.toLowerCase() !== boardFilter) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  // embed query
  let queryEmbedding: number[];
  if (opts.config) {
    try {
      const gemini = opts.config.getGeminiClient();
      const [emb] = await gemini.generateEmbedding([q]);
      queryEmbedding = emb;
    } catch (err) {
      console.warn('Embedding generation failed, falling back to zeros', err);
      queryEmbedding = new Array(filtered[0].embedding.length).fill(0);
    }
  } else {
    queryEmbedding = new Array(filtered[0].embedding.length).fill(0);
  }

  const qTokens = tokenize(q);

  // score documents
  const vecScores = filtered.map((rec) => cosineSim(queryEmbedding, rec.embedding));
  const keyScores = filtered.map((rec) => bm25Score(qTokens, tokenize(rec.content)));

  // sort individually to get ranks
  const vecRank = [...vecScores].map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);
  const keyRank = [...keyScores].map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);

  const rankPosVec: Record<number, number> = {};
  vecRank.forEach(({ i }, idx) => (rankPosVec[i] = idx + 1));
  const rankPosKey: Record<number, number> = {};
  keyRank.forEach(({ i }, idx) => (rankPosKey[i] = idx + 1));

  const fusedScores = filtered.map((_, i) => reciprocalRankFusion(rankPosVec[i] || 1e6, rankPosKey[i] || 1e6));

  const entries = filtered.map((rec, i) => ({ rec, fused: fusedScores[i] }));
  entries.sort((a, b) => b.fused - a.fused);

  const topk = opts.topk ?? 5;
  return entries.slice(0, topk).map(({ rec, fused }) => ({
    id: rec.id,
    pageContent: rec.content,
    score: fused,
    metadata: {
      source: rec.metadata.source,
      page: rec.metadata.page,
      path: rec.metadata.path,
      board: rec.metadata.board,
      tag: rec.metadata.tag,
    },
  }));
}
