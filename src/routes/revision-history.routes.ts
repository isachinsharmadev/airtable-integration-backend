import express, { Request, Response } from "express";
import { CookieService } from "../services/cookie.service";
import { RevisionHistoryService } from "../services/revision-history.service";
import RevisionHistory from "../models/revision-history.model";

const router = express.Router();
const cookieService = new CookieService();
const revisionHistoryService = new RevisionHistoryService();

/**
 * POST /api/cookies/retrieve
 * Retrieve cookies from Airtable with credentials
 */
router.post("/cookies/retrieve", async (req: Request, res: Response) => {
  try {
    const { email, password, mfaCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const cookies = await cookieService.retrieveCookies(
      email,
      password,
      mfaCode
    );

    res.json({
      success: true,
      cookies: cookies.cookies,
      timestamp: cookies.timestamp,
    });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to retrieve cookies",
      message: error.message,
    });
  }
});

/**
 * POST /api/cookies/validate
 * Validate existing cookies
 */
router.post("/cookies/validate", async (req: Request, res: Response) => {
  try {
    const { cookies } = req.body;

    if (!cookies) {
      return res.status(400).json({ error: "Cookies are required" });
    }

    const isValid = await cookieService.validateCookies(cookies);

    res.json({ valid: isValid });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to validate cookies",
      message: error.message,
    });
  }
});

/**
 * POST /api/revision-history/fetch
 * Fetch revision history for records
 */
router.post("/revision-history/fetch", async (req: Request, res: Response) => {
  try {
    const { baseId, tableId, recordIds, cookies } = req.body;

    if (!baseId || !tableId || !recordIds || !cookies) {
      return res.status(400).json({
        error: "baseId, tableId, recordIds, and cookies are required",
      });
    }

    // Validate cookies first
    const isValid = await cookieService.validateCookies(cookies);
    if (!isValid) {
      return res.status(401).json({
        error: "Cookies are invalid or expired",
        requiresReauth: true,
      });
    }

    const activities = await revisionHistoryService.batchFetchRevisionHistory(
      baseId,
      tableId,
      recordIds,
      cookies,
      (current, total) => {
        // Could implement WebSocket for real-time progress updates
        console.log(`Progress: ${current}/${total}`);
      }
    );

    // Save to MongoDB
    const savedActivities = [];
    for (const activity of activities) {
      const existing = await RevisionHistory.findOne({ uuid: activity.uuid });
      if (!existing) {
        const saved = await RevisionHistory.create({
          ...activity,
          baseId,
          tableId,
        });
        savedActivities.push(saved);
      }
    }

    res.json({
      success: true,
      count: savedActivities.length,
      activities: savedActivities,
    });
  } catch (error: any) {
    if (error.message === "COOKIES_EXPIRED") {
      return res.status(401).json({
        error: "Cookies expired during processing",
        requiresReauth: true,
      });
    }

    res.status(500).json({
      error: "Failed to fetch revision history",
      message: error.message,
    });
  }
});

/**
 * GET /api/revision-history/:baseId/:tableId/:recordId
 * Get stored revision history for a record
 */
router.get(
  "/revision-history/:baseId/:tableId/:recordId",
  async (req: Request, res: Response) => {
    try {
      const { baseId, tableId, recordId } = req.params;

      const history = await RevisionHistory.find({
        baseId,
        tableId,
        issueId: recordId,
      }).sort({ createdDate: -1 });

      res.json({ history });
    } catch (error: any) {
      res.status(500).json({
        error: "Failed to fetch revision history",
        message: error.message,
      });
    }
  }
);

export default router;
