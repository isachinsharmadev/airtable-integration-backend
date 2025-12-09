import axios, { AxiosInstance } from "axios";
import { Base, Table, Page } from "../models/airtable.model";

export class AirtableService {
  private client: AxiosInstance;
  private baseURL = "https://api.airtable.com/v0";

  constructor(accessToken: string) {
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  // Fetch all bases with pagination
  async fetchBases(): Promise<any[]> {
    const allBases: any[] = [];
    let offset: string | undefined;

    try {
      do {
        const params: any = {};
        if (offset) params.offset = offset;

        const response = await this.client.get("/meta/bases", { params });
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

      console.log(`Fetched ${allBases.length} bases`);
      return allBases;
    } catch (error: any) {
      console.error("Error fetching bases:", error.message);
      throw error;
    }
  }

  // Fetch tables for a specific base
  async fetchTables(baseId: string): Promise<any[]> {
    try {
      const response = await this.client.get(`/meta/bases/${baseId}/tables`);
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

      console.log(`Fetched ${tables.length} tables for base ${baseId}`);
      return tables;
    } catch (error: any) {
      console.error(`Error fetching tables for base ${baseId}:`, error.message);
      throw error;
    }
  }

  // Fetch all records (pages) for a table with pagination
  async fetchPages(baseId: string, tableId: string): Promise<any[]> {
    const allPages: any[] = [];
    let offset: string | undefined;

    try {
      do {
        const params: any = {};
        if (offset) params.offset = offset;

        const response = await this.client.get(`/${baseId}/${tableId}`, {
          params,
        });
        const { records, offset: nextOffset } = response.data;

        allPages.push(...records);
        offset = nextOffset;

        // Store in database
        for (const record of records) {
          await Page.findOneAndUpdate(
            { pageId: record.id },
            {
              pageId: record.id,
              baseId: baseId,
              tableId: tableId,
              fields: record.fields,
              createdTime: record.createdTime,
              updatedAt: new Date(),
            },
            { upsert: true, new: true }
          );
        }

        console.log(
          `Fetched ${records.length} pages (offset: ${offset ? "yes" : "no"})`
        );
      } while (offset);

      console.log(
        `Total fetched ${allPages.length} pages for table ${tableId}`
      );
      return allPages;
    } catch (error: any) {
      console.error(
        `Error fetching pages for table ${tableId}:`,
        error.message
      );
      throw error;
    }
  }

  // Fetch users
  async fetchUsers(): Promise<any[]> {
    try {
      const response = await this.client.get("/Users");
      console.log("Fetched users successfully");
      return response.data;
    } catch (error: any) {
      console.error("Error fetching users:", error.message);
      throw error;
    }
  }

  // Fetch all data (bases, tables, pages)
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
