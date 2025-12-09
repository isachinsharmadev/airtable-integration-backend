import { Router, Request, Response } from "express";
import { ScrapingService } from "../services/scraping.service";
import { RevisionHistory, CookieStore, Page } from "../models/airtable.model";

const router = Router();
const scrapingService = new ScrapingService();

router.post("/authenticate", async (req: Request, res: Response) => {
  try {
    const { email, password, mfaCode, debugMode } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    console.log("🔐 Starting authentication...");

    const cookies = await scrapingService.authenticateAndGetCookies(
      email,
      password,
      mfaCode,
      debugMode || false
    );

    return res.json({
      success: true,
      message: "Authentication successful",
      cookiesRetrieved: true,
      cookieCount: cookies.split(";").length,
    });
  } catch (error: any) {
    console.error("Authentication error:", error.message);

    // Handle MFA required
    if (error.message === "MFA_CODE_REQUIRED") {
      return res.status(200).json({
        success: false,
        mfaRequired: true,
        message: "MFA code required. Please provide the 6-digit code.",
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message || "Authentication failed",
    });
  }
});

/**
 * Validate stored cookies
 * GET /api/scraping/validate-cookies
 */
router.get("/validate-cookies", async (req: Request, res: Response) => {
  try {
    const cookies = await scrapingService.getStoredCookies();

    if (!cookies) {
      return res.status(404).json({
        success: false,
        valid: false,
        message: "No cookies found. Please authenticate first.",
      });
    }

    const isValid = await scrapingService.validateCookies(cookies);

    return res.json({
      success: true,
      valid: isValid,
      message: isValid ? "Cookies are valid" : "Cookies have expired",
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/scraping/cookie-status
 * Get detailed cookie status
 */
router.get("/cookie-status", async (req: Request, res: Response) => {
  try {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (!cookieStore) {
      return res.json({
        hasCookies: false,
        valid: false,
        requiresAuth: true,
        message: "No cookies stored. Please authenticate first.",
      });
    }

    // Check cookie age
    const now = new Date();
    const cookieAge = now.getTime() - cookieStore.updatedAt.getTime();
    const cookieAgeMinutes = Math.floor(cookieAge / 1000 / 60);
    const lastValidatedMinutes = Math.floor(
      (now.getTime() - cookieStore.lastValidated.getTime()) / 1000 / 60
    );

    res.json({
      hasCookies: true,
      valid: cookieStore.isValid,
      mfaRequired: cookieStore.mfaRequired,
      cookieAge: `${cookieAgeMinutes} minutes`,
      lastValidated: `${lastValidatedMinutes} minutes ago`,
      lastValidatedDate: cookieStore.lastValidated,
      updatedAt: cookieStore.updatedAt,
      requiresAuth: !cookieStore.isValid,
    });
  } catch (error: any) {
    console.error("❌ Error getting cookie status:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to get cookie status",
      message: error.message,
    });
  }
});

/**
 * POST /api/scraping/revision-history/:baseId/:tableId/:recordId
 * Fetch revision history for a specific record
 */
router.post(
  "/revision-history/:baseId/:tableId/:recordId",
  async (req: Request, res: Response) => {
    try {
      const { baseId, tableId, recordId } = req.params;

      const service = new ScrapingService();
      const cookies = await service.getStoredCookies();

      if (!cookies) {
        return res.status(401).json({
          success: false,
          error: "No valid cookies available",
          message: "Please authenticate first",
          requiresAuth: true,
        });
      }

      console.log(`📥 Fetching revision history for record: ${recordId}`);
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
        recordId,
        baseId,
        tableId,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("❌ Error fetching revision history:", error.message);

      if (error.message === "COOKIES_EXPIRED") {
        return res.status(401).json({
          success: false,
          error: "Cookies expired",
          message: "Please re-authenticate",
          requiresAuth: true,
        });
      }

      res.status(500).json({
        success: false,
        error: "Failed to fetch revision history",
        message: error.message,
      });
    }
  }
);

/**
 * POST /api/scraping/fetch-all-revisions
 * Fetch revision history for all pages (up to 200)
 */
router.post("/fetch-all-revisions", async (req: Request, res: Response) => {
  try {
    const { batchSize = 5 } = req.body;

    // Check if there's already an active job
    if (activeJobs.has("revision-fetch")) {
      return res.status(409).json({
        success: false,
        error: "A revision history fetch is already in progress",
        message: "Please wait for the current job to complete",
        jobId: "revision-fetch",
      });
    }

    // Verify cookies before starting
    const service = new ScrapingService();
    try {
      await service.getOrExtractCookies();
    } catch (error: any) {
      return res.status(401).json({
        success: false,
        error: "No valid cookies available",
        message: "Please authenticate first",
        requiresAuth: true,
      });
    }

    // Get page count
    const pageCount = await Page.countDocuments();
    const pagesToProcess = Math.min(pageCount, 200);

    // Create job tracking
    const jobId = "revision-fetch";
    const jobInfo = {
      id: jobId,
      startTime: new Date(),
      status: "running",
      totalPages: pagesToProcess,
      processed: 0,
      withHistory: 0,
      withoutHistory: 0,
      errors: 0,
    };
    activeJobs.set(jobId, jobInfo);

    // Start the process asynchronously
    service
      .fetchAllRevisionHistory(batchSize, (progress) => {
        // Update job info
        const job = activeJobs.get(jobId);
        if (job) {
          job.processed = progress.processed;
          job.withHistory = progress.withHistory;
          job.withoutHistory = progress.withoutHistory;
          job.errors = progress.errors;
          job.percentage = progress.percentage;
        }
      })
      .then(() => {
        console.log("✅ Revision history fetch completed successfully");
        const job = activeJobs.get(jobId);
        if (job) {
          job.status = "completed";
          job.endTime = new Date();
        }
        // Remove job after 5 minutes
        setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
      })
      .catch((err) => {
        console.error("❌ Revision history fetch error:", err.message);
        const job = activeJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.error = err.message;
          job.endTime = new Date();
        }
        // Remove job after 5 minutes
        setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
      });

    res.json({
      success: true,
      message: "Revision history fetch started",
      jobId: jobId,
      totalPages: pagesToProcess,
      batchSize: batchSize,
      note: "Use GET /api/scraping/job-status/:jobId to check progress",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("❌ Error starting revision history fetch:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to start revision history fetch",
      message: error.message,
    });
  }
});

/**
 * GET /api/scraping/job-status/:jobId
 * Get status of a scraping job
 */
router.get("/job-status/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    const job = activeJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
        message: "The specified job does not exist or has expired",
      });
    }

    // Calculate duration
    const duration = job.endTime
      ? job.endTime.getTime() - job.startTime.getTime()
      : new Date().getTime() - job.startTime.getTime();

    res.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        startTime: job.startTime,
        endTime: job.endTime || null,
        duration: `${Math.round(duration / 1000)}s`,
        progress: {
          total: job.totalPages,
          processed: job.processed,
          withHistory: job.withHistory,
          withoutHistory: job.withoutHistory,
          errors: job.errors,
          percentage: job.percentage || 0,
        },
        error: job.error || null,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: "Failed to get job status",
      message: error.message,
    });
  }
});

/**
 * GET /api/scraping/revision-histories
 * Get stored revision histories with filtering and stats
 */
router.get("/revision-histories", async (req: Request, res: Response) => {
  try {
    const {
      pageId,
      baseId,
      tableId,
      limit = 200,
      includeStats = "true",
    } = req.query;

    const query: any = {};

    if (pageId) query.pageId = pageId;
    if (baseId) query.baseId = baseId;
    if (tableId) query.tableId = tableId;

    const histories = await RevisionHistory.find(query)
      .sort({ updatedAt: -1 })
      .limit(Number(limit));

    let stats = null;
    if (includeStats === "true") {
      // Calculate detailed statistics
      const allRevisions = histories.flatMap((h) => h.revisions);

      const assigneeChanges = allRevisions.filter(
        (r) => r.columnType === "assignee"
      );
      const statusChanges = allRevisions.filter(
        (r) => r.columnType === "status"
      );

      // Get unique users
      const uniqueUsers = new Set(allRevisions.map((r) => r.authoredBy));

      // Get date range
      const timestamps = allRevisions.map((r) =>
        new Date(r.createdDate).getTime()
      );
      const oldestChange =
        timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null;
      const newestChange =
        timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;

      stats = {
        totalPages: histories.length,
        totalRevisions: allRevisions.length,
        assigneeChanges: assigneeChanges.length,
        statusChanges: statusChanges.length,
        uniqueUsers: uniqueUsers.size,
        dateRange: {
          oldest: oldestChange,
          newest: newestChange,
        },
        averageRevisionsPerPage:
          histories.length > 0
            ? (allRevisions.length / histories.length).toFixed(2)
            : 0,
      };
    }

    res.json({
      success: true,
      count: histories.length,
      stats: stats,
      histories: histories,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("❌ Error retrieving revision histories:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve revision histories",
      message: error.message,
    });
  }
});

/**
 * GET /api/scraping/revision-histories/summary
 * Get a summary of all revision histories
 */
router.get(
  "/revision-histories/summary",
  async (req: Request, res: Response) => {
    try {
      const totalPages = await RevisionHistory.countDocuments();

      // Get aggregated stats
      const allHistories = await RevisionHistory.find();
      const allRevisions = allHistories.flatMap((h) => h.revisions);

      const assigneeChanges = allRevisions.filter(
        (r) => r.columnType === "assignee"
      );
      const statusChanges = allRevisions.filter(
        (r) => r.columnType === "status"
      );

      // Group by base and table
      const baseStats = new Map<string, any>();
      for (const history of allHistories) {
        const key = `${history.baseId}/${history.tableId}`;
        if (!baseStats.has(key)) {
          baseStats.set(key, {
            baseId: history.baseId,
            tableId: history.tableId,
            pageCount: 0,
            revisionCount: 0,
          });
        }
        const stats = baseStats.get(key);
        stats.pageCount++;
        stats.revisionCount += history.revisions.length;
      }

      res.json({
        success: true,
        summary: {
          totalPages: totalPages,
          totalRevisions: allRevisions.length,
          assigneeChanges: assigneeChanges.length,
          statusChanges: statusChanges.length,
          averageRevisionsPerPage:
            totalPages > 0 ? (allRevisions.length / totalPages).toFixed(2) : 0,
          byBaseAndTable: Array.from(baseStats.values()),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("❌ Error getting summary:", error.message);
      res.status(500).json({
        success: false,
        error: "Failed to get summary",
        message: error.message,
      });
    }
  }
);

/**
 * DELETE /api/scraping/cookies
 * Clear stored cookies
 */
router.delete("/cookies", async (req: Request, res: Response) => {
  try {
    await CookieStore.deleteMany({});
    res.json({
      success: true,
      message: "Cookies cleared successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("❌ Error clearing cookies:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to clear cookies",
      message: error.message,
    });
  }
});

/**
 * DELETE /api/scraping/revision-histories
 * Clear all stored revision histories
 */
router.delete("/revision-histories", async (req: Request, res: Response) => {
  try {
    const result = await RevisionHistory.deleteMany({});
    res.json({
      success: true,
      message: "Revision histories cleared",
      deletedCount: result.deletedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("❌ Error clearing revision histories:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to clear revision histories",
      message: error.message,
    });
  }
});

/**
 * Test single record revision history
 * POST /api/scraping/test-single
 * Body: { baseId, tableId, recordId }
 */
router.post("/test-single", async (req: Request, res: Response) => {
  try {
    const { baseId, tableId, recordId } = req.body;

    if (!baseId || !tableId || !recordId) {
      return res.status(400).json({
        success: false,
        error: "baseId, tableId, and recordId are required",
      });
    }

    const cookies = await scrapingService.getOrExtractCookies();

    const revisions = await scrapingService.fetchRevisionHistory(
      baseId,
      tableId,
      recordId,
      cookies
    );

    return res.json({
      success: true,
      recordId,
      revisionCount: revisions.length,
      revisions,
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Fetch all revision histories
 * POST /api/scraping/fetch-all-revisions
 * Body: { batchSize? }
 */
router.post("/fetch-all-revisions", async (req: Request, res: Response) => {
  try {
    const { batchSize = 10 } = req.body;

    console.log(`🚀 Starting batch fetch with size: ${batchSize}`);

    await scrapingService.fetchAllRevisionHistory(batchSize);

    return res.json({
      success: true,
      message: "Revision history fetch completed successfully",
    });
  } catch (error: any) {
    console.error("Fetch error:", error.message);

    if (error.message === "COOKIES_EXPIRED") {
      return res.status(401).json({
        success: false,
        error: "Cookies expired. Please re-authenticate.",
        requiresAuth: true,
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
