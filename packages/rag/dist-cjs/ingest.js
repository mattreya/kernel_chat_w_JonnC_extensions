"use strict";
// packages/rag/src/ingest.ts
/*
 * Initial skeleton for the RAG ingestion pipeline (v0.1).
 *
 * NOTE: This is intentionally minimal and synchronous to keep the first
 * iteration lightweight.  Subsequent revisions will tune performance,
 * error-handling, PDF paging and watch-mode.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { createRequire } from 'module';
// Lazy-load heavy parsers only when first used to prevent unwanted side-effects (pdf-parse debug mode).
const require = createRequire(import.meta.url);
let pdfParse;
let mdIt;
import { htmlToText } from 'html-to-text';
const DEFAULT_STORE_DIR = '.gemini/rag_store';
const CHUNKS_FILE = 'chunks.jsonl';
async function readTextFromFile(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.pdf') {
        if (!pdfParse) {
            pdfParse = require('pdf-parse');
        }
        const buf = await fs.readFile(file);
        const data = await pdfParse(buf);
        return { text: data.text, mime: 'application/pdf' };
    }
    if (ext === '.md' || ext === '.markdown') {
        const raw = await fs.readFile(file, 'utf8');
        try {
            if (!mdIt) {
                const MarkdownIt = require('markdown-it');
                mdIt = new MarkdownIt();
            }
            const rendered = mdIt.render(raw);
            const text = htmlToText(rendered, {
                wordwrap: false,
                selectors: [{ selector: 'a', options: { ignoreHref: true } }],
            });
            return { text, mime: 'text/markdown' };
        }
        catch (_err) {
            // markdown-it not available – fall back to raw markdown text
            return { text: raw, mime: 'text/markdown' };
        }
    }
    if (ext === '.html' || ext === '.htm') {
        const raw = await fs.readFile(file, 'utf8');
        const text = htmlToText(raw, { wordwrap: false });
        return { text, mime: 'text/html' };
    }
    // fallback – treat as plain text
    const text = await fs.readFile(file, 'utf8');
    return { text, mime: 'text/plain' };
}
// very naive chunker – splits by approx characters; future rev will use token count
function chunkText(text, maxLen = 4000, overlap = 400) {
    const chunks = [];
    if (maxLen <= 0)
        return [text];
    const step = Math.max(1, maxLen - overlap);
    for (let start = 0; start < text.length; start += step) {
        const end = Math.min(text.length, start + maxLen);
        chunks.push(text.slice(start, end));
        if (end === text.length)
            break;
    }
    return chunks;
}
async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
async function appendJsonl(file, obj) {
    const json = JSON.stringify(obj);
    await fs.appendFile(file, json + '\n');
}
/**
 * Ingest a list of files/directories into the local RAG store.
 */
export async function ingest(paths, opts = {}) {
    const storeDir = path.resolve(opts.config?.getProjectRoot() ?? process.cwd(), DEFAULT_STORE_DIR);
    await ensureDir(storeDir);
    const chunkFile = path.join(storeDir, CHUNKS_FILE);
    // lazily create embedding helper
    let geminiClient;
    async function embedBatch(texts) {
        if (!geminiClient) {
            if (!opts.config) {
                throw new Error('Embedding requires a Config instance to create GeminiClient');
            }
            geminiClient = opts.config.getGeminiClient();
        }
        try {
            return await geminiClient.generateEmbedding(texts);
        }
        catch (err) {
            console.warn('Embedding API failed – using zero vectors', err);
            const dim = 768;
            const zero = new Array(dim).fill(0);
            return texts.map(() => zero);
        }
    }
    // gather all files
    const files = [];
    for (const p of paths) {
        const full = path.resolve(p);
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
            const sub = await fs.readdir(full, { recursive: true });
            sub.forEach((f) => {
                files.push(path.join(full, f));
            });
        }
        else {
            files.push(full);
        }
    }
    for (const file of files) {
        try {
            const { text, mime } = await readTextFromFile(file);
            const chunks = chunkText(text, 4000, 400);
            const embeddings = await embedBatch(chunks);
            const ingestedAt = new Date().toISOString();
            for (let idx = 0; idx < chunks.length; idx++) {
                const chunkContent = chunks[idx];
                const chunk = {
                    id: nanoid(),
                    content: chunkContent,
                    embedding: embeddings[idx],
                    metadata: {
                        source: path.relative(process.cwd(), file),
                        tag: opts.tag,
                        board: opts.board,
                        mime,
                        ingestedAt,
                    },
                };
                await appendJsonl(chunkFile, chunk);
            }
            // TODO: update manifest.json summarizing counts + hashes
            console.log(`Ingested ${file} (${chunks.length} chunks)`);
        }
        catch (err) {
            console.warn(`Failed to ingest ${file}:`, err);
        }
    }
    if (opts.watch) {
        console.log('Watch mode not yet implemented.');
    }
}
//# sourceMappingURL=ingest.js.map