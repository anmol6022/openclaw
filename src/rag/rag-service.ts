import * as path from "node:path";
import { type DatabaseSync } from "node:sqlite";
import {
  Document,
  VectorStoreIndex,
  MetadataMode,
  type BaseNode,
  type BaseVectorStore,
  type VectorStoreQuery,
  type VectorStoreQueryResult,
  type BaseEmbedding,
} from "llamaindex";
import { type OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureDir } from "../memory/internal.js";
import { loadSqliteVecExtension } from "../memory/sqlite-vec.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("rag");

export class SqliteVecVectorStore implements BaseVectorStore {
  storesText = true;
  isEmbeddingQuery? = true;
  private db: DatabaseSync;
  private tableName: string;
  embedModel!: BaseEmbedding;

  constructor(db: DatabaseSync, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  client(): DatabaseSync {
    return this.db;
  }

  async add(nodes: BaseNode[]): Promise<string[]> {
    if (nodes.length === 0) {
      return [];
    }

    let dims: number | undefined;
    for (const node of nodes) {
      if (node.embedding) {
        dims = node.embedding.length;
        break;
      }
    }

    if (!dims) {
      throw new Error("No embeddings provided in nodes");
    }

    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dims}],\n` +
        `  metadata TEXT,\n` +
        `  text TEXT\n` +
        `)`,
    );

    const insert = this.db.prepare(
      `INSERT INTO ${this.tableName} (id, embedding, metadata, text) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET embedding=excluded.embedding, metadata=excluded.metadata, text=excluded.text`,
    );

    this.db.exec("BEGIN");
    try {
      for (const node of nodes) {
        if (!node.embedding) {
          continue;
        }
        const embeddingJson = JSON.stringify(node.embedding);
        const metadataJson = JSON.stringify({
          ...node.metadata,
          _nodeContent: node.getContent(MetadataMode.ALL),
        });
        insert.run(node.id_, embeddingJson, metadataJson, node.getContent(MetadataMode.ALL));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return nodes.map((n) => n.id_);
  }

  async delete(refDocId: string, _deleteKwargs?: unknown): Promise<void> {
    const del = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE json_extract(metadata, '$.ref_doc_id') = ?`,
    );
    del.run(refDocId);
  }

  async query(
    query: VectorStoreQuery,
    options?: { refDocIds?: string[] },
  ): Promise<VectorStoreQueryResult> {
    if (!query.queryEmbedding) {
      throw new Error("Query embedding is required");
    }

    const similarTopK = query.similarityTopK || 5;
    const embeddingJson = JSON.stringify(query.queryEmbedding);

    // Filter to specific reference document IDs if provided
    let sql = `
      SELECT
        id,
        text,
        metadata,
        vec_distance_cosine(embedding, ?) as distance
      FROM ${this.tableName}
    `;

    // Only apply refDocIds filter if it's set and not empty
    if (options?.refDocIds && Array.isArray(options.refDocIds) && options.refDocIds.length > 0) {
      // Simple string replacement works for basic arrays
      const idsList = options.refDocIds
        .map((id: string) => "'" + id.replace(/'/g, "''") + "'")
        .join(",");
      sql += ` WHERE json_extract(metadata, '$.ref_doc_id') IN (${idsList})`;
    }

    sql += ` ORDER BY distance ASC LIMIT ?`;

    const stmt = this.db.prepare(sql);
    let rows: unknown[] = [];
    try {
      rows = stmt.all(embeddingJson, similarTopK) as unknown[];
    } catch {
      // Table probably doesn't exist yet
      return {
        similarities: [],
        nodes: [],
        ids: [],
      };
    }

    const nodes: BaseNode[] = [];
    const similarities: number[] = [];
    const ids: string[] = [];

    for (const row of rows as { id: string; metadata: string; text: string; distance?: number }[]) {
      let metadata = {};
      try {
        metadata = JSON.parse(row.metadata);
      } catch {}

      // LlamaIndex nodes usually reconstruct themselves
      nodes.push({
        id_: row.id,
        embedding: undefined,
        metadata,
        getContent: () => row.text,
        getMetadataStr: () => "",
      } as unknown as BaseNode);

      similarities.push(1.0 - (row.distance || 0)); // Cosine similarity is 1 - distance
      ids.push(row.id);
    }

    return {
      similarities,
      nodes,
      ids,
    };
  }
}

export class RagService {
  private dbMap = new Map<string, DatabaseSync>();
  private storePath: string;
  private readonly vectorDims = 1536; // OpenAI text-embedding-ada-002 / text-embedding-3-small default

  constructor(private config: OpenClawConfig) {
    // Store user vector DBs in the openclaw data directory under 'rag'
    this.storePath = resolveUserPath("~/.openclaw/rag");
  }

  private async getDatabase(accountId: string): Promise<DatabaseSync> {
    if (this.dbMap.has(accountId)) {
      return this.dbMap.get(accountId)!;
    }

    ensureDir(this.storePath);
    const dbPath = path.join(this.storePath, `${accountId}.sqlite`);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { allowExtension: true });

    const loaded = await loadSqliteVecExtension({ db });
    if (!loaded.ok) {
      log.warn("Failed to load sqlite-vec for RAG");
    }

    this.dbMap.set(accountId, db);
    return db;
  }

  async indexDocument(
    accountId: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    log.info(`Indexing document for user ${accountId}`);
    try {
      const db = await this.getDatabase(accountId);
      const vectorStore = new SqliteVecVectorStore(db, "user_docs_vec");

      const index = await VectorStoreIndex.fromVectorStore(vectorStore);
      const doc = new Document({ text, metadata });

      await index.insert(doc);
      log.info(`Successfully indexed document for ${accountId}`);
    } catch (err) {
      log.error(`Failed to index document: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async queryDocuments(accountId: string, queryStr: string, limit = 3): Promise<string> {
    try {
      const db = await this.getDatabase(accountId);

      // Check if table exists before querying
      try {
        db.prepare("SELECT 1 FROM user_docs_vec LIMIT 1").get();
      } catch {
        return "No documents indexed yet.";
      }

      const vectorStore = new SqliteVecVectorStore(db, "user_docs_vec");
      const index = await VectorStoreIndex.fromVectorStore(vectorStore);

      const retriever = index.asRetriever({ similarityTopK: limit });
      const nodes = await retriever.retrieve(queryStr);

      if (!nodes || nodes.length === 0) {
        return "No relevant information found in documents.";
      }

      const chunks = nodes.map(
        (node) =>
          `-- Document Chunk (Score: ${node.score?.toFixed(2)})\n${node.node.getContent(MetadataMode.ALL)}`,
      );

      return chunks.join("\n\n");
    } catch (err) {
      log.error(`Failed to query documents: ${err instanceof Error ? err.message : String(err)}`);
      return `Error searching documents: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async deleteDocuments(accountId: string): Promise<void> {
    try {
      const db = await this.getDatabase(accountId);
      db.exec(`DROP TABLE IF EXISTS user_docs_vec`);
      log.info(`Deleted all RAG documents for ${accountId}`);
    } catch (err) {
      log.error(`Failed to delete documents: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let instance: RagService | null = null;
export function getRagService(config: OpenClawConfig): RagService {
  if (!instance) {
    instance = new RagService(config);
  }
  return instance;
}
