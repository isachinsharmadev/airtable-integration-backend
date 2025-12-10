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
   * Fetch current authenticated user information using whoami endpoint
   */
  // airtable.service.ts

  // NOTE: You need to pass the baseId into this method now.
  // CORRECTED fetchUsers method for AirtableService

  /**
   * Fetch users/collaborators for a base
   *
   * Strategy:
   * 1. First try /meta/whoami to get current user info (always works, no special scope needed)
   * 2. Then try /meta/bases/:baseId with collaborators (requires workspacesAndBases:read scope)
   * 3. If collaborators fails, return at least the current user info
   */
  async fetchUsers(baseId: string): Promise<any> {
    try {
      console.log(`🔍 Fetching users for base: ${baseId}...`);

      const users: any[] = [];

      // STEP 1: Get current user info via /meta/whoami
      // This endpoint works on ALL plans and requires NO special scopes
      console.log("👤 Step 1: Fetching current user via /meta/whoami...");
      try {
        const whoamiResponse = await this.rateLimitedRequest(() =>
          this.client.get("/meta/whoami")
        );

        const currentUser = whoamiResponse.data;
        console.log(
          "📊 Current user data:",
          JSON.stringify(currentUser, null, 2)
        );

        // Add current user to the list
        users.push({
          id: currentUser.id,
          email: currentUser.email || "Unknown",
          scopes: currentUser.scopes || [],
          type: "current_user",
          source: "whoami",
        });

        console.log(`✅ Current user: ${currentUser.email || currentUser.id}`);

        // Log available scopes
        if (currentUser.scopes) {
          console.log(`🔐 Available scopes: ${currentUser.scopes.join(", ")}`);
        }
      } catch (error: any) {
        console.error(
          "⚠️  Failed to fetch current user via whoami:",
          error.message
        );
        // Continue anyway - we'll try to get collaborators
      }

      // STEP 2: Try to get all collaborators for the base
      // This requires workspacesAndBases:read scope and Enterprise plan
      console.log("\n👥 Step 2: Fetching base collaborators...");
      try {
        const baseResponse = await this.rateLimitedRequest(() =>
          this.client.get(`/meta/bases/${baseId}`, {
            params: {
              "include[]": "collaborators",
            },
          })
        );

        const collaborators = baseResponse.data.collaborators || [];
        console.log(
          `📊 Collaborators data:`,
          JSON.stringify(collaborators, null, 2)
        );

        // Add collaborators to the list (avoid duplicates)
        collaborators.forEach((collab: any) => {
          // Check if we already have this user
          const exists = users.find((u) => u.id === collab.id);
          if (!exists) {
            users.push({
              ...collab,
              type: "collaborator",
              source: "base_metadata",
            });
          } else {
            // Update existing user with collaborator info
            Object.assign(exists, {
              ...collab,
              type: "current_user_and_collaborator",
              sources: ["whoami", "base_metadata"],
            });
          }
        });

        console.log(
          `✅ Found ${collaborators.length} collaborators for base ${baseId}`
        );
      } catch (error: any) {
        console.error("⚠️  Failed to fetch base collaborators:", error.message);

        if (error.response?.status === 422) {
          console.log(
            "💡 422 Error - Missing workspacesAndBases:read scope or not on Enterprise plan"
          );
          console.log("   Returning current user info only");
        } else if (error.response?.status === 403) {
          console.log("💡 403 Error - Permission denied");
          console.log("   Returning current user info only");
        }

        // Don't throw - we still have the current user from whoami
      }

      // STEP 3: Return results
      console.log(`\n📊 Summary: Found ${users.length} total user(s)`);
      users.forEach((user, index) => {
        console.log(`  ${index + 1}. ${user.email || user.id} (${user.type})`);
      });

      return {
        users,
        count: users.length,
        sources: {
          whoami: users.some(
            (u) => u.source === "whoami" || u.sources?.includes("whoami")
          ),
          base_metadata: users.some(
            (u) =>
              u.source === "base_metadata" ||
              u.sources?.includes("base_metadata")
          ),
        },
      };
    } catch (error: any) {
      console.error(`❌ Error in fetchUsers for ${baseId}:`, error.message);
      throw error;
    }
  }

  /**
   * Separate method to just get current user info
   * Useful for quick authentication checks
   */
  async getCurrentUser(): Promise<any> {
    try {
      console.log("👤 Fetching current user via /meta/whoami...");

      const response = await this.rateLimitedRequest(() =>
        this.client.get("/meta/whoami")
      );

      const user = response.data;
      console.log(`✅ Current user: ${user.email || user.id}`);

      if (user.scopes) {
        console.log(`🔐 Scopes: ${user.scopes.join(", ")}`);
      }

      return user;
    } catch (error: any) {
      console.error("❌ Error fetching current user:", error.message);
      throw error;
    }
  }

  /**
   * Check if current token has specific scopes
   */
  async hasScopes(requiredScopes: string[]): Promise<{
    hasAll: boolean;
    hasAny: boolean;
    missing: string[];
    available: string[];
  }> {
    try {
      const user = await this.getCurrentUser();
      const available = user.scopes || [];

      const missing = requiredScopes.filter(
        (scope) => !available.includes(scope)
      );

      return {
        hasAll: missing.length === 0,
        hasAny: requiredScopes.some((scope) => available.includes(scope)),
        missing,
        available,
      };
    } catch (error) {
      return {
        hasAll: false,
        hasAny: false,
        missing: requiredScopes,
        available: [],
      };
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
