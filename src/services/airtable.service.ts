import axios, { AxiosInstance } from "axios";
import { Base, Table, Page } from "../models/airtable.model";

export class AirtableService {
  private client: AxiosInstance;
  private baseURL = "https://api.airtable.com/v0";
  private maxConcurrent = 2; // Reduced from 5 to be safer with rate limits
  private requestQueue: Promise<any> = Promise.resolve();
  private lastRequestTime = 0;
  private minRequestInterval = 250; // 4 requests/second (250ms between requests)

  constructor(accessToken: string) {
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Delay helper for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Rate-limited request with queue to prevent 429 errors
   */
  private async rateLimitedRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue = this.requestQueue
        .then(async () => {
          const now = Date.now();
          const timeSinceLastRequest = now - this.lastRequestTime;

          if (timeSinceLastRequest < this.minRequestInterval) {
            await this.delay(this.minRequestInterval - timeSinceLastRequest);
          }

          this.lastRequestTime = Date.now();
          return requestFn();
        })
        .then(resolve)
        .catch(reject);
    });
  }

  /**
   * Fetch all bases with pagination (UNCHANGED - Already Optimal)
   */
  async fetchBases(): Promise<any[]> {
    const allBases: any[] = [];
    let offset: string | undefined;

    try {
      do {
        const params: any = {};
        if (offset) params.offset = offset;

        const response = await this.rateLimitedRequest(() =>
          this.client.get("/meta/bases", { params })
        );
        const { bases, offset: nextOffset } = response.data;

        allBases.push(...bases);
        offset = nextOffset;

        // Store in database
        for (const base of bases) {
          await Base.findOneAndUpdate(
            { baseId: base.id },
            {
              baseId: base.id,
              name: base.name,
              permissionLevel: base.permissionLevel,
              updatedAt: new Date(),
            },
            { upsert: true, new: true }
          );
        }
      } while (offset);

      console.log(`✅ Fetched ${allBases.length} bases`);
      return allBases;
    } catch (error: any) {
      console.error("❌ Error fetching bases:", error.message);
      throw error;
    }
  }

  /**
   * Fetch tables for a specific base (UNCHANGED)
   */
  async fetchTables(baseId: string): Promise<any[]> {
    try {
      const response = await this.rateLimitedRequest(() =>
        this.client.get(`/meta/bases/${baseId}/tables`)
      );
      const { tables } = response.data;

      // Store in database
      for (const table of tables) {
        await Table.findOneAndUpdate(
          { tableId: table.id },
          {
            tableId: table.id,
            baseId: baseId,
            name: table.name,
            description: table.description,
            primaryFieldId: table.primaryFieldId,
            fields: table.fields,
            views: table.views,
            updatedAt: new Date(),
          },
          { upsert: true, new: true }
        );
      }

      console.log(`✅ Fetched ${tables.length} tables for base ${baseId}`);
      return tables;
    } catch (error: any) {
      console.error(
        `❌ Error fetching tables for base ${baseId}:`,
        error.message
      );
      throw error;
    }
  }
  /**
   * Fetch all records (pages) for a table with pagination
   * OPTIMIZED: Batch database inserts + Rate limiting
   */
  async fetchPages(baseId: string, tableId: string): Promise<any[]> {
    const allPages: any[] = [];
    let offset: string | undefined;
    let pageCount = 0;

    try {
      do {
        const params: any = {};
        if (offset) params.offset = offset;

        const response = await this.rateLimitedRequest(() =>
          this.client.get(`/${baseId}/${tableId}`, { params })
        );
        const { records, offset: nextOffset } = response.data;

        allPages.push(...records);
        offset = nextOffset;
        pageCount++;

        // OPTIMIZATION: Batch insert instead of one-by-one
        const bulkOps = records.map((record: any) => ({
          updateOne: {
            filter: { pageId: record.id },
            update: {
              $set: {
                pageId: record.id,
                baseId: baseId,
                tableId: tableId,
                fields: record.fields,
                createdTime: record.createdTime,
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        }));

        if (bulkOps.length > 0) {
          await Page.bulkWrite(bulkOps);
        }

        console.log(
          `📄 Batch ${pageCount}: Fetched ${
            records.length
          } pages (has more: ${!!offset})`
        );
      } while (offset);

      console.log(
        `✅ Total fetched ${allPages.length} pages for table ${tableId}`
      );
      return allPages;
    } catch (error: any) {
      console.error(
        `❌ Error fetching pages for table ${tableId}:`,
        error.message
      );
      throw error;
    }
  }

  /**
   * OPTIMIZATION 1: Parallel Base Processing
   * Process multiple bases concurrently
   */
  async fetchAllDataParallel(): Promise<{
    bases: any[];
    tables: any[];
    pages: any[];
  }> {
    console.log("🚀 Starting parallel data fetch...");
    const startTime = Date.now();

    // Step 1: Fetch all bases
    const bases = await this.fetchBases();
    console.log(`📦 Found ${bases.length} bases`);

    const allTables: any[] = [];
    const allPages: any[] = [];

    // Step 2: Process bases in parallel (with concurrency limit)
    for (let i = 0; i < bases.length; i += this.maxConcurrent) {
      const baseBatch = bases.slice(i, i + this.maxConcurrent);

      console.log(
        `\n🔄 Processing base batch ${
          Math.floor(i / this.maxConcurrent) + 1
        }/${Math.ceil(bases.length / this.maxConcurrent)}`
      );

      const batchResults = await Promise.all(
        baseBatch.map(async (base) => {
          try {
            console.log(`  📊 Fetching tables for: ${base.name}`);
            const tables = await this.fetchTables(base.id);

            // Fetch pages for all tables in this base
            const basePages: any[] = [];
            for (const table of tables) {
              console.log(`    📄 Fetching pages for table: ${table.name}`);
              const pages = await this.fetchPages(base.id, table.id);
              basePages.push(...pages);
            }

            return { tables, pages: basePages };
          } catch (error) {
            console.error(`❌ Error processing base ${base.name}:`, error);
            return { tables: [], pages: [] };
          }
        })
      );

      // Aggregate results
      batchResults.forEach((result) => {
        allTables.push(...result.tables);
        allPages.push(...result.pages);
      });

      console.log(
        `✅ Batch complete. Total so far: ${allTables.length} tables, ${allPages.length} pages`
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 Parallel fetch complete in ${duration}s!`);
    console.log(
      `📊 Final stats: ${bases.length} bases, ${allTables.length} tables, ${allPages.length} pages`
    );

    return {
      bases,
      tables: allTables,
      pages: allPages,
    };
  }

  /**
   * OPTIMIZATION 2: Table Proxy Pattern
   * Fetch only table schemas without records
   */
  async fetchAllDataTableProxyOnly(): Promise<{
    bases: any[];
    tables: any[];
  }> {
    console.log("🚀 Starting table proxy fetch (schema only)...");

    const bases = await this.fetchBases();
    const allTables: any[] = [];

    for (const base of bases) {
      const tables = await this.fetchTables(base.id);
      allTables.push(...tables);
    }

    console.log(
      `✅ Fetched schemas: ${bases.length} bases, ${allTables.length} tables`
    );
    console.log(`💡 Use fetchPages() separately when you need actual records`);

    return { bases, tables: allTables };
  }

  /**
   * OPTIMIZATION 3: Selective Page Fetching
   * Fetch pages only for specific tables
   */
  async fetchPagesSelective(
    tableIds: Array<{ baseId: string; tableId: string }>
  ): Promise<any[]> {
    console.log(`🎯 Fetching pages for ${tableIds.length} specific tables...`);
    const allPages: any[] = [];

    for (const { baseId, tableId } of tableIds) {
      const pages = await this.fetchPages(baseId, tableId);
      allPages.push(...pages);
    }

    console.log(`✅ Fetched ${allPages.length} pages from selected tables`);
    return allPages;
  }

  /**
   * OPTIMIZATION 4: Incremental Sync
   * Only fetch records modified after last sync
   */
  async fetchPagesIncremental(
    baseId: string,
    tableId: string,
    lastSyncDate?: Date
  ): Promise<any[]> {
    const allPages: any[] = [];
    let offset: string | undefined;

    try {
      do {
        const params: any = {};
        if (offset) params.offset = offset;

        // Add filter for records modified after lastSyncDate
        if (lastSyncDate) {
          params.filterByFormula = `IS_AFTER(LAST_MODIFIED_TIME(), '${lastSyncDate.toISOString()}')`;
        }

        const response = await this.rateLimitedRequest(() =>
          this.client.get(`/${baseId}/${tableId}`, { params })
        );
        const { records, offset: nextOffset } = response.data;

        allPages.push(...records);
        offset = nextOffset;

        // Batch insert
        const bulkOps = records.map((record: any) => ({
          updateOne: {
            filter: { pageId: record.id },
            update: {
              $set: {
                pageId: record.id,
                baseId: baseId,
                tableId: tableId,
                fields: record.fields,
                createdTime: record.createdTime,
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        }));

        if (bulkOps.length > 0) {
          await Page.bulkWrite(bulkOps);
        }
      } while (offset);

      console.log(
        `✅ Incremental sync: Fetched ${allPages.length} modified pages`
      );
      return allPages;
    } catch (error: any) {
      console.error(`❌ Error in incremental sync:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch users (UNCHANGED)
   */
  async fetchUsers(): Promise<any[]> {
    try {
      const response = await this.rateLimitedRequest(() =>
        this.client.get("/Users")
      );
      console.log("✅ Fetched users successfully");
      return response.data;
    } catch (error: any) {
      console.error("❌ Error fetching users:", error.message);
      throw error;
    }
  }

  /**
   * LEGACY: Original sequential fetch (Keep for compatibility)
   */
  async fetchAllData(): Promise<{
    bases: any[];
    tables: any[];
    pages: any[];
  }> {
    const bases = await this.fetchBases();
    const allTables: any[] = [];
    const allPages: any[] = [];

    for (const base of bases) {
      const tables = await this.fetchTables(base.id);
      allTables.push(...tables);

      for (const table of tables) {
        const pages = await this.fetchPages(base.id, table.id);
        allPages.push(...pages);
      }
    }

    return {
      bases,
      tables: allTables,
      pages: allPages,
    };
  }
}
