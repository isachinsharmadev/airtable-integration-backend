import { Router, Request, Response } from "express";
import { ScrapingService } from "../services/scraping.service";
import { RevisionHistory, CookieStore, Page } from "../models/airtable.model";

const router = Router();

const activeJobs = new Map<string, any>();

function isJobStalled(job: any): boolean {
  if (job.status === "completed" || job.status === "failed") {
    return false;
  }
  const lastActivityTime = job.lastActivityTime || job.startTime;
  const stalledTime = 30 * 60 * 1000; // 30 minutes
  return Date.now() - lastActivityTime.getTime() > stalledTime;
}

router.post("/authenticate", async (req: Request, res: Response) => {
  try {
    const { email, password, mfaCode, debugMode = false } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    const service = new ScrapingService();

    console.log(" Starting authentication...");
    console.log(`   Email: ${email}`);
    console.log(`   MFA Code: ${mfaCode ? "Provided" : "Not provided"}`);
    console.log(`   Debug Mode: ${debugMode}`);

    const cookies = await service.authenticateAndGetCookies(
      email,
      password,
      mfaCode,
      debugMode
    );

    const isValid = await service.validateCookies(cookies);

    console.log(" Authentication successful");
    console.log(`   Cookies stored: Yes`);
    console.log(`   Cookies valid: ${isValid}`);

    res.json({
      success: true,
      message: "Authentication successful",
      cookiesStored: true,
      cookiesValid: isValid,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(" Authentication error:", error.message);

    if (error.message === "MFA_CODE_REQUIRED") {
      return res.status(400).json({
        success: false,
        error: "MFA code is required",
        message: "Please provide your MFA code and try again",
        mfaRequired: true,
      });
    }

    res.status(500).json({
      success: false,
      error: "Authentication failed",
      message: error.message,
      mfaRequired: error.message.includes("MFA"),
    });
  }
});

router.get("/validate-cookies", async (req: Request, res: Response) => {
  try {
    const service = new ScrapingService();
    const cookies = await service.getStoredCookies();

    if (!cookies) {
      return res.json({
        valid: false,
        message: "No cookies found",
        requiresAuth: true,
      });
    }

    const isValid = await service.validateCookies(cookies);

    res.json({
      valid: isValid,
      message: isValid ? "Cookies are valid" : "Cookies are invalid or expired",
      requiresAuth: !isValid,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(" Cookie validation error:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to validate cookies",
      message: error.message,
    });
  }
});

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

    // Calculate cookie age
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
    console.error("Error getting cookie status:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to get cookie status",
      message: error.message,
    });
  }
});

router.delete("/cookies", async (req: Request, res: Response) => {
  try {
    await CookieStore.deleteMany({});

    console.log("🧹 Cookies cleared");

    res.json({
      success: true,
      message: "Cookies cleared successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error clearing cookies:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to clear cookies",
      message: error.message,
    });
  }
});

router.post("/fetch-all-revisions", async (req: Request, res: Response) => {
  try {
    const { batchSize = 5, force = false } = req.body;

    const existingJob = activeJobs.get("revision-fetch");

    if (existingJob) {
      if (
        existingJob.status === "completed" ||
        existingJob.status === "failed"
      ) {
        console.log("Previous job completed, starting new run");
        activeJobs.delete("revision-fetch");
      } else if (
        existingJob.status === "running" &&
        !isJobStalled(existingJob)
      ) {
        if (!force) {
          return res.status(409).json({
            success: false,
            error: "A revision history fetch is already in progress",
            message:
              "Please wait for the current job to complete or use force=true",
            jobId: "revision-fetch",
            currentJob: {
              status: existingJob.status,
              progress: {
                processed: existingJob.processed,
                total: existingJob.totalPages,
                percentage: existingJob.percentage || 0,
              },
            },
          });
        }
        console.log(" Force restarting job");
        activeJobs.delete("revision-fetch");
      } else if (isJobStalled(existingJob)) {
        console.warn("  Removing stalled job");
        activeJobs.delete("revision-fetch");
      }
    }

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

    // Get page count (limit 200 as per requirements)
    const pageCount = await Page.countDocuments();
    // const pagesToProcess = Math.min(pageCount, 200);

    console.log(" Starting revision history fetch");
    console.log(`   Total pages in DB: ${pageCount}`);
    console.log(`   Pages to process: ${pageCount}`);
    console.log(`   Batch size: ${batchSize}`);

    // Create job tracking
    const jobId = "revision-fetch";
    const jobInfo = {
      id: jobId,
      startTime: new Date(),
      lastActivityTime: new Date(),
      status: "running",
      totalPages: pageCount,
      processed: 0,
      withHistory: 0,
      withoutHistory: 0,
      errors: 0,
    };
    activeJobs.set(jobId, jobInfo);

    // Start asynchronous processing
    service
      .fetchAllRevisionHistory(batchSize, (progress) => {
        // Update job progress
        const job = activeJobs.get(jobId);
        if (job) {
          job.processed = progress.processed;
          job.withHistory = progress.withHistory;
          job.withoutHistory = progress.withoutHistory;
          job.errors = progress.errors;
          job.percentage = progress.percentage;
          job.lastActivityTime = new Date();
        }
      })
      .then(() => {
        console.log(" Revision history fetch completed");
        const job = activeJobs.get(jobId);
        if (job) {
          job.status = "completed";
          job.endTime = new Date();
          console.log(`   Processed: ${job.processed}/${job.totalPages}`);
          console.log(`   With history: ${job.withHistory}`);
          console.log(`   Without history: ${job.withoutHistory}`);
          console.log(`   Errors: ${job.errors}`);
        }
        setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
      })
      .catch((err) => {
        console.error(" Revision history fetch failed:", err.message);
        const job = activeJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.error = err.message;
          job.endTime = new Date();
        }
        // Clean up after 5 minutes
        setTimeout(() => activeJobs.delete(jobId), 5 * 60 * 1000);
      });

    res.json({
      success: true,
      message: "Revision history fetch started",
      jobId: jobId,
      totalPages: pageCount,
      batchSize: batchSize,
      note: "Check progress at GET /api/scraping/job-status/revision-fetch",
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(" Error starting revision history fetch:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to start revision history fetch",
      message: error.message,
    });
  }
});

router.get("/revision-histories", async (req: Request, res: Response) => {
  try {
    const {
      pageId,
      baseId,
      tableId,
      limit = 1000,
      includeStats = "true",
    } = req.query;

    // Build query
    const query: any = {};
    if (pageId) query.pageId = pageId;
    if (baseId) query.baseId = baseId;
    if (tableId) query.tableId = tableId;

    // Fetch histories
    const histories = await RevisionHistory.find(query)
      .sort({ updatedAt: -1 })
      .limit(Number(limit));

    console.log(`📊 Querying revision histories`);
    console.log(`   Filters: ${JSON.stringify(query)}`);
    console.log(`   Results: ${histories.length}`);

    // Calculate statistics if requested
    let stats = null;
    if (includeStats === "true") {
      const allRevisions = histories.flatMap((h) => h.revisions);
      const assigneeChanges = allRevisions.filter(
        (r) => r.columnType === "assignee"
      );
      const statusChanges = allRevisions.filter(
        (r) => r.columnType === "status"
      );
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
    console.error("Error retrieving revision histories:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve revision histories",
      message: error.message,
    });
  }
});

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

      console.log(`📥 Fetching revision history for: ${recordId}`);

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

      console.log(`✅ Found ${revisions.length} revisions`);

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
      console.error("Error fetching revision history:", error.message);

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

export default router;
