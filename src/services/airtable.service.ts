import axios, { AxiosInstance } from "axios";
import Bottleneck from "bottleneck";

import Airtable from "airtable";

import { Base, Table, Page, User } from "../models/airtable.model";

export class AirtableService {
  private client: AxiosInstance;
  private baseURL = "https://api.airtable.com/v0";
  private limiter: Bottleneck;
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;

    // Axios client – only for meta endpoints
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    // Bottleneck w/ exponential backoff
    this.limiter = new Bottleneck({
      minTime: 200,
      maxConcurrent: 3,
    });

    this.limiter.on("failed", async (error, jobInfo) => {
      if (error.response?.status === 429 || error.statusCode === 429) {
        const retry = jobInfo.retryCount + 1;
        const wait = Math.min(2000 * retry, 8000);
        console.warn(`[RateLimit] 429 → retry in ${wait}ms (attempt ${retry})`);
        return wait;
      }
    });
  }

  async fetchBases() {
    const allBases = [];
    let offset: string | undefined;

    try {
      console.log("[FetchBases] Start...");

      do {
        const response = await this.limiter.schedule(() =>
          this.client.get("/meta/bases", { params: offset ? { offset } : {} })
        );

        const { bases, offset: nextOffset } = response.data;
        allBases.push(...bases);
        offset = nextOffset;

        if (bases.length) {
          await Base.bulkWrite(
            bases.map((b: any) => ({
              updateOne: {
                filter: { baseId: b.id },
                update: {
                  $set: {
                    baseId: b.id,
                    name: b.name,
                    permissionLevel: b.permissionLevel,
                    updatedAt: new Date(),
                  },
                },
                upsert: true,
              },
            }))
          );
        }

        console.log(`[FetchBases] Got ${bases.length} (more: ${!!offset})`);
      } while (offset);

      return allBases;
    } catch (err: any) {
      console.error("[FetchBases] Error:", err.message);
      throw err;
    }
  }

  async fetchTables(baseId: string) {
    try {
      const response = await this.limiter.schedule(() =>
        this.client.get(`/meta/bases/${baseId}/tables`)
      );
      const { tables } = response.data;

      if (tables.length) {
        await Table.bulkWrite(
          tables.map((t: any) => ({
            updateOne: {
              filter: { tableId: t.id },
              update: {
                $set: {
                  tableId: t.id,
                  baseId,
                  name: t.name,
                  description: t.description,
                  primaryFieldId: t.primaryFieldId,
                  fields: t.fields,
                  views: t.views,
                  updatedAt: new Date(),
                },
              },
              upsert: true,
            },
          }))
        );
      }

      console.log(`[FetchTables] Base ${baseId}: ${tables.length} tables`);
      return tables;
    } catch (err: any) {
      console.error(`[FetchTables] Error for base ${baseId}:`, err.message);
      throw err;
    }
  }
  async fetchPages(baseId: string, tableName: string): Promise<number> {
    let totalRecords = 0;

    try {
      Airtable.configure({ apiKey: this.accessToken });
      const base = Airtable.base(baseId);

      await new Promise<void>((resolve, reject) => {
        base(tableName)
          .select({})
          .eachPage(
            async (records, next) => {
              try {
                totalRecords += records.length;

                const bulkOps = records.map((r: any) => ({
                  updateOne: {
                    filter: { baseId, tableId: tableName, pageId: r.id },
                    update: {
                      $set: {
                        pageId: r.id,
                        baseId,
                        tableId: tableName,
                        fields: r.fields,
                        createdTime: r.createdTime,
                        updatedAt: new Date(),
                      },
                    },
                    upsert: true,
                  },
                }));

                if (bulkOps.length) await Page.bulkWrite(bulkOps);

                await this.limiter.schedule(async () => next());
              } catch (err) {
                reject(err);
              }
            },
            (err) => (err ? reject(err) : resolve())
          );
      });

      return totalRecords;
    } catch (err: any) {
      console.error(`[FetchPages] Error for ${tableName}:`, err.message);
      throw err;
    }
  }

  async fetchAllDataParallel() {
    console.log("[ParallelSync] Start...");
    const start = Date.now();

    const bases = await this.fetchBases();

    let allUsers: any[] = [];
    let totalTables = 0;
    let totalRecords = 0;

    await Promise.all(
      bases.map(async (base) => {
        try {
          const [tables, userResult] = await Promise.all([
            this.fetchTables(base.id),
            this.fetchUsers(base.id).catch(() => ({ users: [] })),
          ]);

          allUsers.push(...userResult.users);
          totalTables += tables.length;

          const counts = await Promise.all(
            tables.map((t: any) => this.fetchPages(base.id, t.name))
          );

          const recordSum = counts.reduce((a, b) => a + b, 0);
          totalRecords += recordSum;

          console.log(
            `[Base] ${base.name}: ${tables.length} tables, ${recordSum} records`
          );
        } catch (err) {
          console.error(`[Base] Failed ${base.name}`, err);
        }
      })
    );

    // Unique users by id
    const uniqueUsers = [...new Map(allUsers.map((u) => [u.id, u])).values()];

    return {
      stats: {
        bases: bases.length,
        tables: totalTables,
        records: totalRecords,
        users: uniqueUsers.length,
      },
      userStats: this.buildUserStats(uniqueUsers),
      durationSeconds: ((Date.now() - start) / 1000).toFixed(2),
    };
  }
  async fetchUsers(baseId: string) {
    const users: any[] = [];
    try {
      const resp = await this.limiter.schedule(() =>
        this.client.get("/meta/whoami")
      );

      users.push({
        id: resp.data.id,
        email: resp.data.email,
        scopes: resp.data.scopes,
        type: "current_user",
        source: "whoami",
      });
    } catch (err: any) {
      console.warn("[FetchUsers] whoami failed:", err.message);
    }

    try {
      const resp = await this.limiter.schedule(() =>
        this.client.get(`/meta/bases/${baseId}`, {
          params: { "include[]": "collaborators" },
        })
      );

      for (const collab of resp.data.collaborators || []) {
        const found = users.find((u) => u.id === collab.id);

        if (!found) {
          users.push({
            ...collab,
            type: "collaborator",
            source: "base_metadata",
          });
        } else {
          Object.assign(found, {
            ...collab,
            type: "current_user_and_collaborator",
            sources: ["whoami", "base_metadata"],
          });
        }
      }
    } catch (err: any) {
      if (![403, 422].includes(err.response?.status)) {
        console.warn(`[FetchUsers] collab fetch failed:`, err.message);
      }
    }

    if (users.length) {
      await User.bulkWrite(
        users.map((u) => ({
          updateOne: {
            filter: { userId: u.id },
            update: {
              $set: {
                userId: u.id,
                email: u.email,
                name: u.name,
                scopes: u.scopes,
                type: u.type,
                source: u.source,
                sources: u.sources,
                baseId,
                permissionLevel: u.permissionLevel,
              },
            },
            upsert: true,
          },
        }))
      );
    }

    return {
      users,
      count: users.length,
      sources: {
        whoami: users.some((u) => u.source === "whoami"),
        base_metadata: users.some((u) => u.source === "base_metadata"),
      },
    };
  }

  private buildUserStats(users: any[]) {
    return {
      totalUsers: users.length,
      byType: {
        current_user: users.filter((u) => u.type === "current_user").length,
        collaborator: users.filter((u) => u.type === "collaborator").length,
        current_user_and_collaborator: users.filter(
          (u) => u.type === "current_user_and_collaborator"
        ).length,
      },
    };
  }
}
