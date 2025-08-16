import { Config } from '@google/gemini-cli-core';
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
    config?: Config;
}
export declare function retrieve(q: string, opts?: RetrieverOptions): Promise<Retrieved[]>;
export {};
