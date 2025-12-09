import { Router, Request, Response } from "express";
import { AirtableService } from "../services/airtable.service";
import { OAuthToken, Base, Table, Page } from "../models/airtable.model";

const router = Router();

// Middleware to get access token
async function getAccessToken(): Promise<string | null> {
  const token = await OAuthToken.findOne().sort({ updatedAt: -1 });

  if (!token || !token.accessToken) {
    return null;
  }

  // Check if token is expired
  if (new Date() > token.expiresAt) {
    return null;
  }

  return token.accessToken;
}

// Fetch all bases
router.post("/fetch-bases", async (req: Request, res: Response) => {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const bases = await service.fetchBases();

    res.json({
      success: true,
      count: bases.length,
      bases,
    });
  } catch (error: any) {
    console.error("Error fetching bases:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch bases", message: error.message });
  }
});

// Fetch tables for a base
router.post("/fetch-tables/:baseId", async (req: Request, res: Response) => {
  try {
    const { baseId } = req.params;
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const tables = await service.fetchTables(baseId);

    res.json({
      success: true,
      count: tables.length,
      tables,
    });
  } catch (error: any) {
    console.error("Error fetching tables:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch tables", message: error.message });
  }
});

// Fetch pages for a table
router.post(
  "/fetch-pages/:baseId/:tableId",
  async (req: Request, res: Response) => {
    try {
      const { baseId, tableId } = req.params;
      const accessToken = await getAccessToken();

      if (!accessToken) {
        return res
          .status(401)
          .json({ error: "Not authenticated or token expired" });
      }

      const service = new AirtableService(accessToken);
      const pages = await service.fetchPages(baseId, tableId);

      res.json({
        success: true,
        count: pages.length,
        pages,
      });
    } catch (error: any) {
      console.error("Error fetching pages:", error.message);
      res
        .status(500)
        .json({ error: "Failed to fetch pages", message: error.message });
    }
  }
);

// ORIGINAL: Fetch all data (sequential - SLOW for many bases)
router.post("/fetch-all", async (req: Request, res: Response) => {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const data = await service.fetchAllData();

    res.json({
      success: true,
      summary: {
        bases: data.bases.length,
        tables: data.tables.length,
        pages: data.pages.length,
      },
      data,
    });
  } catch (error: any) {
    console.error("Error fetching all data:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch all data", message: error.message });
  }
});

// NEW: Fetch all data with parallel processing (FAST)
router.post("/fetch-all-parallel", async (req: Request, res: Response) => {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const data = await service.fetchAllDataParallel();

    res.json({
      success: true,
      summary: {
        bases: data.bases.length,
        tables: data.tables.length,
        pages: data.pages.length,
      },
      data,
    });
  } catch (error: any) {
    console.error("Error fetching all data (parallel):", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch all data", message: error.message });
  }
});

// NEW: Table Proxy - Fetch only schemas (no records)
router.post("/fetch-schemas-only", async (req: Request, res: Response) => {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const data = await service.fetchAllDataTableProxyOnly();

    res.json({
      success: true,
      summary: {
        bases: data.bases.length,
        tables: data.tables.length,
        pages: 0, // No pages fetched
      },
      message: "Fetched table schemas only. Use /fetch-pages to get records.",
      data,
    });
  } catch (error: any) {
    console.error("Error fetching schemas:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch schemas", message: error.message });
  }
});

// NEW: Selective page fetching
router.post("/fetch-pages-selective", async (req: Request, res: Response) => {
  try {
    const { tableIds } = req.body;

    if (!tableIds || !Array.isArray(tableIds)) {
      return res.status(400).json({
        error: "tableIds array is required",
        example: { tableIds: [{ baseId: "appXXX", tableId: "tblXXX" }] },
      });
    }

    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const pages = await service.fetchPagesSelective(tableIds);

    res.json({
      success: true,
      count: pages.length,
      pages,
    });
  } catch (error: any) {
    console.error("Error in selective fetch:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch pages", message: error.message });
  }
});

// NEW: Incremental sync - fetch only modified records
router.post(
  "/fetch-pages-incremental/:baseId/:tableId",
  async (req: Request, res: Response) => {
    try {
      const { baseId, tableId } = req.params;
      const { lastSyncDate } = req.body;

      const accessToken = await getAccessToken();

      if (!accessToken) {
        return res
          .status(401)
          .json({ error: "Not authenticated or token expired" });
      }

      const service = new AirtableService(accessToken);
      const pages = await service.fetchPagesIncremental(
        baseId,
        tableId,
        lastSyncDate ? new Date(lastSyncDate) : undefined
      );

      res.json({
        success: true,
        count: pages.length,
        lastSyncDate: lastSyncDate || null,
        pages,
      });
    } catch (error: any) {
      console.error("Error in incremental sync:", error.message);
      res
        .status(500)
        .json({ error: "Failed to sync pages", message: error.message });
    }
  }
);

// Get stored bases
router.get("/bases", async (req: Request, res: Response) => {
  try {
    const bases = await Base.find().sort({ updatedAt: -1 });
    res.json({ success: true, count: bases.length, bases });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to retrieve bases", message: error.message });
  }
});

// Get stored tables
router.get("/tables", async (req: Request, res: Response) => {
  try {
    const { baseId } = req.query;
    const query = baseId ? { baseId } : {};
    const tables = await Table.find(query).sort({ updatedAt: -1 });
    res.json({ success: true, count: tables.length, tables });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to retrieve tables", message: error.message });
  }
});

// Get stored pages
router.get("/pages", async (req: Request, res: Response) => {
  try {
    const { baseId, tableId, limit = 200 } = req.query;
    const query: any = {};

    if (baseId) query.baseId = baseId;
    if (tableId) query.tableId = tableId;

    const pages = await Page.find(query)
      .sort({ updatedAt: -1 })
      .limit(Number(limit));

    res.json({ success: true, count: pages.length, pages });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to retrieve pages", message: error.message });
  }
});

// Get statistics
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const [basesCount, tablesCount, pagesCount] = await Promise.all([
      Base.countDocuments(),
      Table.countDocuments(),
      Page.countDocuments(),
    ]);

    res.json({
      success: true,
      stats: {
        bases: basesCount,
        tables: tablesCount,
        pages: pagesCount,
      },
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to retrieve stats", message: error.message });
  }
});

export default router;
