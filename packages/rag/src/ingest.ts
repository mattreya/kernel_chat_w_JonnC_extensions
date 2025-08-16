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
import { Config, GeminiClient } from '@google/gemini-cli-core';
import { nanoid } from 'nanoid';
import { createRequire } from 'module';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore no types
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
// Dynamically import pdf-parse later to avoid mutable import
let pdfParse: any;
import { htmlToText } from 'html-to-text';

// Lazy-load heavy parsers only when first used to prevent unwanted side-effects (pdf-parse debug mode).
const require = createRequire(import.meta.url);
let mdIt: any;

export interface IngestOptions {
  board?: string;
  tag?: string[];
  watch?: boolean;
  config?: Config; // optional – if omitted we create a throw-away one internally
  progress?: (msg: string) => void; // optional progress logger
}

export type ChunkMetadata = {
  source: string;           // filename
  page?: number;           // for PDFs
  path?: string;           // heading path if available
  board?: string;
  tag?: string[];
  mime?: string;
  hash?: string;           // sha256(content)
  ingestedAt: string;      // ISO timestamp
};

export type StoredChunk = {
  id: string;
  content: string;
  embedding: number[];      // vector
  metadata: ChunkMetadata;
};

const DEFAULT_STORE_DIR = '.gemini/rag_store';
const CHUNKS_FILE = 'chunks.jsonl';

async function readTextFromFile(file: string, log?: (msg: string) => void): Promise<{ text: string; mime: string; pages?: number[] }> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    log?.('Attempting PDF parsing with pdf2json...');
    
    // Check file size first
    const stats = await fs.stat(file);
    const fileSizeMB = stats.size / (1024 * 1024);
    log?.(`PDF file size: ${fileSizeMB.toFixed(1)} MB`);
    
    // Adjust timeout based on file size (1MB = ~10s, max 5 minutes)
    const timeoutMs = Math.min(Math.max(fileSizeMB * 10000, 15000), 300000);
    log?.(`Setting timeout to ${Math.round(timeoutMs/1000)}s for this PDF size`);
    
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PDFParser = require('pdf2json');
      const parser = new PDFParser();
      
      log?.('Setting up pdf2json parser...');
      
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`pdf2json timeout after ${Math.round(timeoutMs/1000)}s`));
        }, timeoutMs);
        
        parser.on('pdfParser_dataError', (errData: any) => {
          clearTimeout(timeout);
          log?.(`pdf2json error: ${errData.parserError}`);
          reject(new Error(`PDF parsing error: ${errData.parserError}`));
        });
        
        parser.on('pdfParser_dataReady', (pdfData: any) => {
          clearTimeout(timeout);
          try {
            const pageCount = pdfData.Pages?.length || 0;
            log?.(`Processing ${pageCount} pages...`);
            
            // For very large PDFs (>1000 pages), process in batches to avoid memory issues
            let text = '';
            let processedPages = 0;
            
            if (pdfData.Pages && Array.isArray(pdfData.Pages)) {
              const batchSize = pageCount > 1000 ? 100 : pageCount; // Process 100 pages at a time for large PDFs
              
              for (let i = 0; i < pdfData.Pages.length; i += batchSize) {
                const batch = pdfData.Pages.slice(i, Math.min(i + batchSize, pdfData.Pages.length));
                
                for (const page of batch) {
                  if (page.Texts && Array.isArray(page.Texts)) {
                    for (const textItem of page.Texts) {
                      if (textItem.R && Array.isArray(textItem.R)) {
                        for (const run of textItem.R) {
                          if (run.T) {
                            try {
                              // Decode URI component and add space
                              text += decodeURIComponent(run.T) + ' ';
                            } catch (decodeErr) {
                              // Skip malformed text
                              text += run.T + ' ';
                            }
                          }
                        }
                      }
                    }
                  }
                  text += '\n\n'; // Add page break
                  processedPages++;
                }
                
                // Log progress for large PDFs
                if (pageCount > 100 && i % 100 === 0) {
                  log?.(`Processed ${processedPages}/${pageCount} pages (${Math.round(processedPages/pageCount*100)}%)`);
                }
              }
            }
            
            log?.(`pdf2json completed! Extracted ${text.length} characters from ${pageCount} pages`);
            
            // For very large texts, warn about potential chunking
            if (text.length > 1000000) { // 1MB of text
              log?.(`Warning: Large text extracted (${Math.round(text.length/1000)}K chars). This will create many chunks.`);
            }
            
            resolve({ text: text.trim(), mime: 'application/pdf' });
          } catch (parseErr) {
            log?.(`Error processing pdf2json data: ${(parseErr as Error).message}`);
            reject(parseErr);
          }
        });
        
        log?.('Loading PDF file for pdf2json...');
        parser.loadPDF(file);
      });
      
    } catch (err) {
      log?.(`pdf2json failed: ${(err as Error).message}`);
      log?.('Returning empty text as fallback for problematic PDF');
      return { text: `[PDF parsing failed: ${path.basename(file)}]`, mime: 'application/pdf' };
    }
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
    } catch (_err) {
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
function chunkText(text: string, maxLen = 4000, overlap = 400): string[] {
  const chunks: string[] = [];
  if (maxLen <= 0) return [text];
  const step = Math.max(1, maxLen - overlap);
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + maxLen);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
  }
  return chunks;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function appendJsonl(file: string, obj: unknown) {
  const json = JSON.stringify(obj);
  await fs.appendFile(file, json + '\n');
}

/**
 * Ingest a list of files/directories into the local RAG store.
 */
export async function ingest(paths: string[], opts: IngestOptions = {}): Promise<void> {
  const storeDir = path.resolve(opts.config?.getProjectRoot() ?? process.cwd(), DEFAULT_STORE_DIR);
  const log = opts.progress ?? ((m: string) => console.log(`[ingest] ${m}`));
  await ensureDir(storeDir);
  const chunkFile = path.join(storeDir, CHUNKS_FILE);

  // lazily create embedding helper
  let geminiClient: GeminiClient | undefined;
  async function embedBatch(texts: string[]): Promise<number[][]> {
    if (!geminiClient) {
      if (!opts.config) {
        throw new Error('Embedding requires a Config instance to create GeminiClient');
      }
      geminiClient = opts.config.getGeminiClient();
    }
    try {
      return await geminiClient.generateEmbedding(texts);
    } catch (err) {
      console.warn('Embedding API failed – using zero vectors', err);
      const dim = 768;
      const zero = new Array(dim).fill(0);
      return texts.map(() => zero);
    }
  }

  // Collect all candidate files (depth-first) – skip hidden files
  const extsAccepted = new Set([
    '.pdf',
    '.md',
    '.markdown',
    '.txt',
    '.html',
    '.htm',
    '.json',
  ]);

  const files: string[] = [];
  const stack: string[] = paths.map((p) => path.resolve(p));
  while (stack.length) {
    const current = stack.pop()!;
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(current, {
          withFileTypes: true,
        });
        for (const ent of entries) {
          // skip dot-files / dot-directories
          if (ent.name.startsWith('.')) continue;
          const full = path.join(current, ent.name);
          if (ent.isDirectory()) stack.push(full);
          else if (ent.isFile()) {
            if (extsAccepted.has(path.extname(ent.name).toLowerCase())) {
              files.push(full);
            } else if (opts.progress) {
              opts.progress(`Skipping unsupported file type: ${full}`);
            }
          }
        }
      } else if (stat.isFile()) {
        if (extsAccepted.has(path.extname(current).toLowerCase())) {
          files.push(current);
        } else if (opts.progress) {
          opts.progress(`Skipping unsupported file type: ${current}`);
        }
      }
    } catch (err) {
      opts.progress?.(`Error accessing ${current}: ${(err as Error).message}`);
    }
  }

  if (files.length === 0) {
    log('No ingestable files found.');
    return;
  }
  log(`Discovered ${files.length} ingestable file(s)`);

  for (const file of files) {
    log(`Reading ${file}`);
    log(`About to call readTextFromFile for: ${file}`);
    try {
      const { text, mime } = await readTextFromFile(file, log);
      log(`readTextFromFile completed, text length: ${text.length}`);
      const chunks = chunkText(text, 4000, 400);
      log(`Split into ${chunks.length} chunk(s)`);
      const embeddings = await embedBatch(chunks);
      log(`Embeddings generated`);
      const ingestedAt = new Date().toISOString();
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunkContent = chunks[idx];
        const chunk: StoredChunk = {
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
      log(`Stored ${chunks.length} chunks for ${file}`);
    } catch (err) {
      const e = err as Error;
      log(`Failed to ingest ${file}: ${e.message}`);
      if (e.stack) log(e.stack.split('\n').slice(0,3).join('\n'));
    }
  }

  if (opts.watch) {
    console.log('Watch mode not yet implemented.');
  }
}
