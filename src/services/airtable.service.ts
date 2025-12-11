import axios, { AxiosInstance } from "axios";
import Bottleneck from "bottleneck";

import Airtable from "airtable";

import { Base, Table, Page, User } from "../models/airtable.model";

interface AirtableBase {
  table(tableName: string): any;
}

export class AirtableService {
  private client: AxiosInstance;
  // private airtableBase: AirtableBase;
  private baseURL = "https://api.airtable.com/v0";
  private limiter: Bottleneck;
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    this.limiter = new Bottleneck({
      minTime: 200, // 200ms spacing = 5 req/sec
      maxConcurrent: 5,
    });

    this.limiter.on("failed", async (error, jobInfo) => {
      // Check for 429 from both Axios and Airtable.js errors
      if (error.response?.status === 429 || error.statusCode === 429) {
        const waitTime = (jobInfo.retryCount + 1) * 2000;
        console.warn(
          `[RateLimit] 429 Hit. Retrying in ${waitTime}ms (Attempt ${
            jobInfo.retryCount + 1
          })`
        );
        return waitTime;
      }
    });
  }

  async fetchBases(): Promise<any[]> {
    const allBases: any[] = [];
    let offset: string | undefined;

    try {
      console.log("[FetchBases] Starting base fetch...");

      do {
        const params: any = {};
        if (offset) params.offset = offset;

        const response = await this.limiter.schedule(() =>
          this.client.get("/meta/bases", { params })
        );

        const { bases, offset: nextOffset } = response.data;
        allBases.push(...bases);
        offset = nextOffset;

        if (bases.length > 0) {
          const bulkOps = bases.map((base: any) => ({
            updateOne: {
              filter: { baseId: base.id },
              update: {
                $set: {
                  baseId: base.id,
                  name: base.name,
                  permissionLevel: base.permissionLevel,
                  updatedAt: new Date(),
                },
              },
              upsert: true,
            },
          }));

          await Base.bulkWrite(bulkOps);
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

  async fetchTables(baseId: string): Promise<any[]> {
    try {
      const response = await this.limiter.schedule(() =>
        this.client.get(`/meta/bases/${baseId}/tables`)
      );
      const { tables } = response.data;

      if (tables.length > 0) {
        const bulkOps = tables.map((table: any) => ({
          updateOne: {
            filter: { tableId: table.id },
            update: {
              $set: {
                tableId: table.id,
                baseId: baseId,
                name: table.name,
                description: table.description,
                primaryFieldId: table.primaryFieldId,
                fields: table.fields,
                views: table.views,
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        }));

        await Table.bulkWrite(bulkOps);
      }

      console.log(
        `[FetchTables] Base ${baseId}: Synced ${tables.length} tables`
      );
      return tables;
    } catch (error: any) {
      console.error(`[FetchTables] Error for base ${baseId}:`, error.message);
      throw error;
    }
  }
  async fetchPages(baseId: string, tableName: string): Promise<number> {
    let totalRecords = 0;

    try {
      const airtable = new Airtable({
        apiKey: this.accessToken,
      });
      const base = airtable.base(baseId);

      await new Promise<void>((resolve, reject) => {
        base
          .table(tableName)
          .select({})
          .eachPage(
            async (records, fetchNextPage) => {
              try {
                totalRecords += records.length;

                const bulkOps = records.map((record: any) => ({
                  updateOne: {
                    filter: { pageId: record.id },
                    update: {
                      $set: {
                        pageId: record.id,
                        baseId: baseId,
                        tableId: tableName,
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

                await this.limiter.schedule(async () => fetchNextPage());
              } catch (error) {
                console.error(
                  `[FetchPages] Error processing page for table ${tableName}:`,
                  error
                );
                reject(error);
              }
            },

            (err) => {
              if (err) {
                console.error(
                  `[FetchPages] Error fetching for table ${tableName}:`,
                  err
                );
                return reject(err);
              }
              resolve();
            }
          );
      });

      return totalRecords;
    } catch (error: any) {
      console.error(
        `[FetchPages] Error for table ${tableName}:`,
        error.message
      );
      throw error;
    }
  }

  async fetchAllDataParallel(): Promise<{
    stats: {
      bases: number;
      tables: number;
      records: number;
      users: number;
    };
    userStats: any;
    durationSeconds: string;
  }> {
    console.log("[FetchAllParallel] Starting optimized parallel sync...");
    const startTime = Date.now();

    const bases = await this.fetchBases();
    console.log(`[FetchAllParallel] Found ${bases.length} bases`);

    const allUsers: any[] = [];
    let totalTables = 0;
    let totalRecords = 0;

    const basePromises = bases.map(async (base) => {
      try {
        const [tables, userResult] = await Promise.all([
          this.fetchTables(base.id),
          this.fetchUsers(base.id).catch((e) => ({ users: [], count: 0 })),
        ]);

        if (userResult && userResult.users) {
          allUsers.push(...userResult.users);
        }
        totalTables += tables.length;

        const pageCounts = await Promise.all(
          tables.map((table: any) => this.fetchPages(base.id, table.name))
        );

        const baseRecords = pageCounts.reduce((a, b) => a + b, 0);
        totalRecords += baseRecords;

        console.log(
          `[Base Sync] ${base.name}: ${tables.length} tables, ${baseRecords} records`
        );
      } catch (err) {
        console.error(`[Base Sync] Failed base ${base.name}`, err);
      }
    });

    await Promise.all(basePromises);

    const uniqueUsers = Array.from(
      new Map(allUsers.map((u) => [u.id, u])).values()
    );

    const userStats = {
      totalUsers: uniqueUsers.length,
      byType: {
        current_user: uniqueUsers.filter((u) => u.type === "current_user")
          .length,
        collaborator: uniqueUsers.filter((u) => u.type === "collaborator")
          .length,
        current_user_and_collaborator: uniqueUsers.filter(
          (u) => u.type === "current_user_and_collaborator"
        ).length,
      },
    };

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[FetchAllParallel] Sync Complete in ${duration}s`);

    return {
      stats: {
        bases: bases.length,
        tables: totalTables,
        records: totalRecords,
        users: uniqueUsers.length,
      },
      userStats,
      durationSeconds: duration,
    };
  }

  async fetchUsers(baseId: string): Promise<{
    users: any[];
    count: number;
    sources: { whoami: boolean; base_metadata: boolean };
  }> {
    try {
      const users: any[] = [];

      try {
        const whoamiResponse = await this.limiter.schedule(() =>
          this.client.get("/meta/whoami")
        );
        const currentUser = whoamiResponse.data;

        users.push({
          id: currentUser.id,
          email: currentUser.email || "Unknown",
          scopes: currentUser.scopes || [],
          type: "current_user",
          source: "whoami",
        });
      } catch (error: any) {
        console.warn("[FetchUsers] 'whoami' check failed:", error.message);
      }

      try {
        const baseResponse = await this.limiter.schedule(() =>
          this.client.get(`/meta/bases/${baseId}`, {
            params: { "include[]": "collaborators" },
          })
        );

        const collaborators = baseResponse.data.collaborators || [];

        collaborators.forEach((collab: any) => {
          const exists = users.find((u) => u.id === collab.id);
          if (!exists) {
            users.push({
              ...collab,
              type: "collaborator",
              source: "base_metadata",
            });
          } else {
            Object.assign(exists, {
              ...collab,
              type: "current_user_and_collaborator",
              sources: ["whoami", "base_metadata"],
            });
          }
        });
      } catch (error: any) {
        if (error.response?.status !== 403 && error.response?.status !== 422) {
          console.warn(
            `[FetchUsers] Collaborator fetch failed for ${baseId}:`,
            error.message
          );
        }
      }

      if (users.length > 0) {
        const bulkOps = users.map((user) => ({
          updateOne: {
            filter: { userId: user.id },
            update: {
              $set: {
                userId: user.id,
                email: user.email,
                name: user.name,
                scopes: user.scopes,
                type: user.type,
                source: user.source,
                sources: user.sources,
                baseId: baseId,
                permissionLevel: user.permissionLevel,
              },
            },
            upsert: true,
          },
        }));
        await User.bulkWrite(bulkOps);
      }

      return {
        users,
        count: users.length,
        sources: {
          whoami: users.some((u) => u.source === "whoami"),
          base_metadata: users.some((u) => u.source === "base_metadata"),
        },
      };
    } catch (error: any) {
      console.error(`[FetchUsers] Error for base ${baseId}:`, error.message);
      throw error;
    }
  }
}
