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

// Fetch all data (bases, tables, pages)
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
