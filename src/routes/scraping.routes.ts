import { Router, Request, Response } from "express";
import { ScrapingService } from "../services/scraping.service";
import { RevisionHistory, CookieStore } from "../models/airtable.model";

const router = Router();

// Authenticate and get cookies
router.post("/authenticate", async (req: Request, res: Response) => {
  try {
    const { email, password, mfaCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const service = new ScrapingService();
    const cookies = await service.authenticateAndGetCookies(
      email,
      password,
      mfaCode
    );

    res.json({
      success: true,
      message: "Authentication successful",
      cookiesStored: true,
    });
  } catch (error: any) {
    console.error("Authentication error:", error.message);
    res.status(500).json({
      error: "Authentication failed",
      message: error.message,
      mfaRequired: error.message.includes("MFA"),
    });
  }
});

// Validate stored cookies
router.get("/validate-cookies", async (req: Request, res: Response) => {
  try {
    const service = new ScrapingService();
    const cookies = await service.getStoredCookies();

    if (!cookies) {
      return res.json({
        valid: false,
        message: "No cookies found or cookies are invalid",
      });
    }

    const isValid = await service.validateCookies(cookies);

    res.json({
      valid: isValid,
      message: isValid ? "Cookies are valid" : "Cookies are invalid",
    });
  } catch (error: any) {
    console.error("Cookie validation error:", error.message);
    res
      .status(500)
      .json({ error: "Failed to validate cookies", message: error.message });
  }
});

// Get cookie status
router.get("/cookie-status", async (req: Request, res: Response) => {
  try {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (!cookieStore) {
      return res.json({
        hasCookies: false,
        valid: false,
      });
    }

    res.json({
      hasCookies: true,
      valid: cookieStore.isValid,
      lastValidated: cookieStore.lastValidated,
      mfaRequired: cookieStore.mfaRequired,
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to get cookie status", message: error.message });
  }
});

// Fetch revision history for a specific page
router.post(
  "/revision-history/:baseId/:tableId/:recordId",
  async (req: Request, res: Response) => {
    try {
      const { baseId, tableId, recordId } = req.params;

      const service = new ScrapingService();
      const cookies = await service.getStoredCookies();

      if (!cookies) {
        return res.status(401).json({
          error: "No valid cookies available. Please authenticate first.",
        });
      }

      const revisions = await service.fetchRevisionHistory(
        baseId,
        tableId,
        recordId,
        cookies
      );

      // Store in database
      await RevisionHistory.findOneAndUpdate(
        { pageId: recordId },
        {
          pageId: recordId,
          baseId,
          tableId,
          revisions,
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      res.json({
        success: true,
        count: revisions.length,
        revisions,
      });
    } catch (error: any) {
      console.error("Error fetching revision history:", error.message);
      res.status(500).json({
        error: "Failed to fetch revision history",
        message: error.message,
      });
    }
  }
);

// Fetch all revision histories
router.post("/fetch-all-revisions", async (req: Request, res: Response) => {
  try {
    const { batchSize = 10 } = req.body;

    const service = new ScrapingService();

    // Start the process asynchronously
    service
      .fetchAllRevisionHistory(batchSize)
      .then(() => console.log("Revision history fetch completed"))
      .catch((err) => console.error("Revision history fetch error:", err));

    res.json({
      success: true,
      message:
        "Revision history fetch started. This will process up to 200 pages.",
      note: "Check the revision history endpoint for results",
    });
  } catch (error: any) {
    console.error("Error starting revision history fetch:", error.message);
    res.status(500).json({
      error: "Failed to start revision history fetch",
      message: error.message,
    });
  }
});

// Get stored revision histories
router.get("/revision-histories", async (req: Request, res: Response) => {
  try {
    const { pageId, baseId, tableId, limit = 200 } = req.query;
    const query: any = {};

    if (pageId) query.pageId = pageId;
    if (baseId) query.baseId = baseId;
    if (tableId) query.tableId = tableId;

    const histories = await RevisionHistory.find(query)
      .sort({ updatedAt: -1 })
      .limit(Number(limit));

    // Calculate statistics
    const stats = {
      totalPages: histories.length,
      totalRevisions: histories.reduce((sum, h) => sum + h.revisions.length, 0),
      assigneeChanges: histories.reduce(
        (sum, h) =>
          sum + h.revisions.filter((r) => r.changeType === "assignee").length,
        0
      ),
      statusChanges: histories.reduce(
        (sum, h) =>
          sum + h.revisions.filter((r) => r.changeType === "status").length,
        0
      ),
    };

    res.json({
      success: true,
      count: histories.length,
      stats,
      histories,
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to retrieve revision histories",
      message: error.message,
    });
  }
});

// Clear cookies
router.delete("/cookies", async (req: Request, res: Response) => {
  try {
    await CookieStore.deleteMany({});
    res.json({ success: true, message: "Cookies cleared" });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "Failed to clear cookies", message: error.message });
  }
});

export default router;
