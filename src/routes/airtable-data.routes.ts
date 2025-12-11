import { Router, Request, Response } from "express";
import { AirtableService } from "../services/airtable.service";
import { OAuthToken, Base, Table, Page, User } from "../models/airtable.model";

const router = Router();

async function getAccessToken(): Promise<string | null> {
  const token = await OAuthToken.findOne().sort({ updatedAt: -1 });

  if (!token || !token.accessToken) {
    return null;
  }

  if (new Date() > token.expiresAt) {
    return null;
  }

  return token.accessToken;
}

router.post("/fetch-bases", async (req: Request, res: Response) => {
  try {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      return res
        .status(401)
        .json({ error: "Not authenticated or token expired" });
    }

    const service = new AirtableService(accessToken);
    const bases = await service.fetchBases(); // Returns Array<Base>

    res.json({
      success: true,
      count: bases.length,
      bases,
      message: `Successfully synced ${bases.length} bases to MongoDB.`,
    });
  } catch (error: any) {
    console.error("Error fetching bases:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch bases", message: error.message });
  }
});

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
    const tables = await service.fetchTables(baseId); // Returns Array<Table>

    res.json({
      success: true,
      count: tables.length,
      tables,
      message: `Successfully synced ${tables.length} tables for base ${baseId} to MongoDB.`,
    });
  } catch (error: any) {
    console.error("Error fetching tables:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch tables", message: error.message });
  }
});

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

      const recordCount = await service.fetchPages(baseId, tableId);

      res.json({
        success: true,
        count: recordCount,
        message: `Successfully synced ${recordCount} records for table ${tableId} to MongoDB. Data not returned in response to prevent memory issues.`,
      });
    } catch (error: any) {
      console.error("Error fetching pages:", error.message);
      res
        .status(500)
        .json({ error: "Failed to fetch pages", message: error.message });
    }
  }
);

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
      message: `Full sync complete in ${data.durationSeconds} seconds.`,
      stats: data.stats,
      userStats: data.userStats,
    });
  } catch (error: any) {
    console.error("Error fetching all data (parallel):", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch all data", message: error.message });
  }
});

router.get("/whoami/:baseId", async (req: Request, res: Response) => {
  try {
    const accessToken = await getAccessToken();
    const { baseId } = req.params;

    if (!accessToken) {
      return res.status(401).json({
        error: "Not authenticated or token expired",
      });
    }

    const service = new AirtableService(accessToken);

    const userResult = await service.fetchUsers(baseId);

    res.json({
      success: true,
      count: userResult.count,
      users: userResult.users,
      sources: userResult.sources,
    });
  } catch (error: any) {
    console.error("Error fetching current user:", error.message);
    res.status(500).json({
      error: "Failed to fetch current user",
      message: error.message,
    });
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
    const [basesCount, tablesCount, pagesCount, usersCount] = await Promise.all(
      [
        Base.countDocuments(),
        Table.countDocuments(),
        Page.countDocuments(),
        User.countDocuments(),
      ]
    );

    res.json({
      success: true,
      stats: {
        bases: basesCount,
        tables: tablesCount,
        records: pagesCount,
        uniqueUsers: usersCount,
      },
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to retrieve stats", message: error.message });
  }
});

export default router;
