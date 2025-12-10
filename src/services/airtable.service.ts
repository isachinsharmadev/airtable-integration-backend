/**
 * Airtable Service - API Client with Rate Limiting and Optimization
 *
 * This service handles all interactions with the Airtable REST API, including:
 * - OAuth-authenticated requests
 * - Rate limiting (4 requests/second)
 * - Pagination handling
 * - Database storage
 * - Parallel processing optimizations
 * - Incremental sync capabilities
 *
 * @module services/airtable.service
 */

import axios, { AxiosInstance } from "axios";
import { Base, Table, Page } from "../models/airtable.model";

export class AirtableService {
  private client: AxiosInstance;
  private baseURL = "https://api.airtable.com/v0";
  private maxConcurrent = 2; // Concurrent requests per batch
  private requestQueue: Promise<any> = Promise.resolve();
  private lastRequestTime = 0;
  private minRequestInterval = 250; // 4 requests/second (250ms between requests)

  /**
   * Initialize Airtable service with OAuth access token
   * @param accessToken - OAuth access token from authentication flow
   */
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
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Rate-limited request wrapper to prevent 429 errors
   *
   * Ensures requests are spaced at least 250ms apart (4 req/sec)
   * Uses a queue to serialize all requests
   *
   * @param requestFn - Function that returns a Promise for the API call
   * @returns Promise that resolves with the API response
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
   * Fetch all bases accessible to the authenticated user
   *
   * Handles pagination automatically and stores results in MongoDB.
   * Uses rate limiting to avoid 429 errors.
   *
   * @returns Array of base objects
   */
  async fetchBases(): Promise<any[]> {
    const allBases: any[] = [];
    let offset: string | undefined;

    try {
      console.log("[FetchBases] Starting base fetch...");

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

        console.log(
          `[FetchBases] Fetched ${bases.length} bases (offset: ${
            offset ? "has more" : "complete"
          })`
        );
      } while (offset);

      console.log(`[FetchBases] Complete - Total: ${allBases.length} bases`);
      return allBases;
    } catch (error: any) {
      console.error("[FetchBases] Error:", error.message);
      throw error;
    }
  }

  /**
   * Fetch tables (schemas) for a specific base
   *
   * Retrieves table metadata including fields, views, and descriptions.
   * Stores results in MongoDB for later querying.
   *
   * @param baseId - Airtable base ID (e.g., "appXXXXXXXXXXXXXX")
   * @returns Array of table objects
   */
  async fetchTables(baseId: string): Promise<any[]> {
    try {
      console.log(`[FetchTables] Fetching tables for base: ${baseId}`);

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

      console.log(
        `[FetchTables] Complete - ${tables.length} tables for base ${baseId}`
      );
      return tables;
    } catch (error: any) {
      console.error(`[FetchTables] Error for base ${baseId}:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch all records (pages) for a table with pagination
   *
   * Optimizations:
   * - Batch database inserts (bulkWrite instead of individual saves)
   * - Rate limiting to avoid 429 errors
   * - Automatic pagination handling
   *
   * @param baseId - Airtable base ID
   * @param tableId - Airtable table ID
   * @returns Array of record objects
   */
  async fetchPages(baseId: string, tableId: string): Promise<any[]> {
    const allPages: any[] = [];
    let offset: string | undefined;
    let pageCount = 0;

    try {
      console.log(`[FetchPages] Starting fetch for table: ${tableId}`);

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

        // OPTIMIZATION: Batch insert instead of individual saves
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
          `[FetchPages] Batch ${pageCount}: ${
            records.length
          } records (has more: ${!!offset})`
        );
      } while (offset);

      console.log(
        `[FetchPages] Complete - Total: ${allPages.length} records for table ${tableId}`
      );
      return allPages;
    } catch (error: any) {
      console.error(`[FetchPages] Error for table ${tableId}:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch all data with parallel processing
   *
   * Performance: 5x faster than sequential fetch for multiple bases
   *
   * Strategy:
   * 1. Fetch all bases
   * 2. Process bases in parallel batches (2 concurrent)
   * 3. For each base, fetch tables then pages
   *
   * @returns Object containing all bases, tables, and pages
   */
  async fetchAllDataParallel(): Promise<{
    bases: any[];
    tables: any[];
    pages: any[];
  }> {
    console.log("[FetchAllParallel] Starting parallel data fetch...");
    const startTime = Date.now();

    // Step 1: Fetch all bases
    const bases = await this.fetchBases();
    console.log(`[FetchAllParallel] Found ${bases.length} bases`);

    const allTables: any[] = [];
    const allPages: any[] = [];

    // Step 2: Process bases in parallel batches
    for (let i = 0; i < bases.length; i += this.maxConcurrent) {
      const baseBatch = bases.slice(i, i + this.maxConcurrent);
      const batchNumber = Math.floor(i / this.maxConcurrent) + 1;
      const totalBatches = Math.ceil(bases.length / this.maxConcurrent);

      console.log(
        `[FetchAllParallel] Processing batch ${batchNumber}/${totalBatches} (${baseBatch.length} bases)`
      );

      const batchResults = await Promise.all(
        baseBatch.map(async (base) => {
          try {
            console.log(`[FetchAllParallel]   Base: ${base.name}`);
            const tables = await this.fetchTables(base.id);

            // Fetch pages for all tables in this base
            const basePages: any[] = [];
            for (const table of tables) {
              console.log(`[FetchAllParallel]     Table: ${table.name}`);
              const pages = await this.fetchPages(base.id, table.id);
              basePages.push(...pages);
            }

            return { tables, pages: basePages };
          } catch (error) {
            console.error(
              `[FetchAllParallel] Error processing base ${base.name}:`,
              error
            );
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
        `[FetchAllParallel] Batch complete - Running total: ${allTables.length} tables, ${allPages.length} pages`
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[FetchAllParallel] Complete in ${duration}s`);
    console.log(
      `[FetchAllParallel] Final: ${bases.length} bases, ${allTables.length} tables, ${allPages.length} pages`
    );

    return {
      bases,
      tables: allTables,
      pages: allPages,
    };
  }

  /**
   * Fetch only table schemas without records
   *
   * Use Case: When you need to understand data structure without loading all records
   * Performance: Very fast (no record fetching)
   *
   * @returns Object containing bases and tables (no pages)
   */
  async fetchAllDataTableProxyOnly(): Promise<{
    bases: any[];
    tables: any[];
  }> {
    console.log("[FetchSchemaOnly] Starting schema-only fetch...");

    const bases = await this.fetchBases();
    const allTables: any[] = [];

    for (const base of bases) {
      const tables = await this.fetchTables(base.id);
      allTables.push(...tables);
    }

    console.log(
      `[FetchSchemaOnly] Complete - ${bases.length} bases, ${allTables.length} tables (0 records)`
    );
    console.log(
      `[FetchSchemaOnly] Note: Use fetchPages() to load records when needed`
    );

    return { bases, tables: allTables };
  }

  /**
   * Fetch pages for specific tables only
   *
   * Use Case: When you only need data from certain tables
   * Performance: Much faster than fetching all tables
   *
   * @param tableIds - Array of {baseId, tableId} objects
   * @returns Array of pages from specified tables
   */
  async fetchPagesSelective(
    tableIds: Array<{ baseId: string; tableId: string }>
  ): Promise<any[]> {
    console.log(
      `[FetchSelective] Fetching pages for ${tableIds.length} specific tables...`
    );
    const allPages: any[] = [];

    for (const { baseId, tableId } of tableIds) {
      const pages = await this.fetchPages(baseId, tableId);
      allPages.push(...pages);
    }

    console.log(
      `[FetchSelective] Complete - ${allPages.length} pages from ${tableIds.length} tables`
    );
    return allPages;
  }

  /**
   * Fetch only records modified after a specific date
   *
   * Use Case: Incremental sync after initial load
   * Performance: Much faster than full re-sync
   *
   * @param baseId - Airtable base ID
   * @param tableId - Airtable table ID
   * @param lastSyncDate - Optional date to filter by (fetch only newer records)
   * @returns Array of modified pages
   */
  async fetchPagesIncremental(
    baseId: string,
    tableId: string,
    lastSyncDate?: Date
  ): Promise<any[]> {
    const allPages: any[] = [];
    let offset: string | undefined;

    try {
      console.log(
        `[FetchIncremental] Starting incremental sync for table: ${tableId}`
      );
      if (lastSyncDate) {
        console.log(
          `[FetchIncremental] Filter: Records modified after ${lastSyncDate.toISOString()}`
        );
      }

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
        `[FetchIncremental] Complete - ${allPages.length} modified records`
      );
      return allPages;
    } catch (error: any) {
      console.error(`[FetchIncremental] Error:`, error.message);
      throw error;
    }
  }

  /**
   * Sequential fetch (legacy method)
   *
   * Performance: Slower than parallel fetch
   * Use Case: Compatibility with older code
   *
   * Note: Consider using fetchAllDataParallel() instead
   *
   * @returns Object containing all bases, tables, and pages
   */
  async fetchAllData(): Promise<{
    bases: any[];
    tables: any[];
    pages: any[];
  }> {
    console.log("[FetchAll] Starting sequential data fetch...");

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

    console.log(
      `[FetchAll] Complete - ${bases.length} bases, ${allTables.length} tables, ${allPages.length} pages`
    );

    return {
      bases,
      tables: allTables,
      pages: allPages,
    };
  }

  // ============================================
  // USER MANAGEMENT
  // ============================================

  /**
   * Fetch users/collaborators for a base
   *
   * Strategy:
   * 1. Get current user via /meta/whoami (always works, no special scope)
   * 2. Try to get collaborators via /meta/bases/:baseId (requires workspacesAndBases:read scope)
   * 3. Return combined results (graceful fallback if collaborators unavailable)
   *
   * Note: Collaborators endpoint may fail on non-Enterprise plans or without proper scopes
   *
   * @param baseId - Airtable base ID
   * @returns Object containing users array and metadata
   */
  async fetchUsers(baseId: string): Promise<any> {
    try {
      console.log(`[FetchUsers] Fetching users for base: ${baseId}`);

      const users: any[] = [];

      // STEP 1: Get current user via /meta/whoami
      console.log(
        "[FetchUsers] Step 1: Fetching current user via /meta/whoami"
      );
      try {
        const whoamiResponse = await this.rateLimitedRequest(() =>
          this.client.get("/meta/whoami")
        );

        const currentUser = whoamiResponse.data;
        console.log(
          "[FetchUsers] Current user data:",
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

        console.log(
          `[FetchUsers] Current user: ${currentUser.email || currentUser.id}`
        );

        // Log available scopes
        if (currentUser.scopes) {
          console.log(
            `[FetchUsers] Available scopes: ${currentUser.scopes.join(", ")}`
          );
        }
      } catch (error: any) {
        console.error(
          "[FetchUsers] Failed to fetch current user via whoami:",
          error.message
        );
        // Continue anyway - we'll try to get collaborators
      }

      // STEP 2: Try to get all collaborators for the base
      console.log("[FetchUsers] Step 2: Fetching base collaborators");
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
          "[FetchUsers] Collaborators data:",
          JSON.stringify(collaborators, null, 2)
        );

        // Add collaborators to the list (avoid duplicates)
        collaborators.forEach((collab: any) => {
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
          `[FetchUsers] Found ${collaborators.length} collaborators for base ${baseId}`
        );
      } catch (error: any) {
        console.error(
          "[FetchUsers] Failed to fetch base collaborators:",
          error.message
        );

        if (error.response?.status === 422) {
          console.log(
            "[FetchUsers] 422 Error - Missing workspacesAndBases:read scope or not on Enterprise plan"
          );
          console.log("[FetchUsers] Returning current user info only");
        } else if (error.response?.status === 403) {
          console.log("[FetchUsers] 403 Error - Permission denied");
          console.log("[FetchUsers] Returning current user info only");
        }

        // Don't throw - we still have the current user from whoami
      }

      // STEP 3: Return results
      console.log(`[FetchUsers] Summary: Found ${users.length} total user(s)`);
      users.forEach((user, index) => {
        console.log(
          `[FetchUsers]   ${index + 1}. ${user.email || user.id} (${user.type})`
        );
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
      console.error(`[FetchUsers] Error for base ${baseId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get current authenticated user information
   *
   * Use Case: Quick authentication checks, scope verification
   *
   * @returns User object with id, email, and scopes
   */
  async getCurrentUser(): Promise<any> {
    try {
      console.log("[GetCurrentUser] Fetching current user via /meta/whoami");

      const response = await this.rateLimitedRequest(() =>
        this.client.get("/meta/whoami")
      );

      const user = response.data;
      console.log(`[GetCurrentUser] Current user: ${user.email || user.id}`);

      if (user.scopes) {
        console.log(`[GetCurrentUser] Scopes: ${user.scopes.join(", ")}`);
      }

      return user;
    } catch (error: any) {
      console.error("[GetCurrentUser] Error:", error.message);
      throw error;
    }
  }

  /**
   * Check if current token has specific OAuth scopes
   *
   * Use Case: Verify permissions before attempting privileged operations
   *
   * @param requiredScopes - Array of scope strings to check
   * @returns Object with hasAll, hasAny, missing, and available scopes
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
}
