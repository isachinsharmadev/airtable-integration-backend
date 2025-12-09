import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page as PuppeteerPage } from "puppeteer";
import {
  CookieStore,
  RevisionHistory,
  Page,
  OAuthToken,
} from "../models/airtable.model";

// Add stealth plugin
puppeteer.use(StealthPlugin());

export class ScrapingService {
  private airtableBaseUrl = "https://airtable.com";

  /**
   * Store cookies in database
   */
  private async storeCookies(
    cookieString: string,
    mfaRequired: boolean,
    isValid: boolean = true
  ): Promise<void> {
    await CookieStore.findOneAndUpdate(
      {},
      {
        cookies: cookieString,
        isValid: isValid,
        lastValidated: new Date(),
        mfaRequired: mfaRequired,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );
    console.log("💾 Cookies stored in database");
  }

  /**
   * Authenticate with Airtable using Puppeteer with stealth plugin
   */
  async authenticateAndGetCookies(
    email: string,
    password: string,
    mfaCode?: string,
    debugMode: boolean = false
  ): Promise<string> {
    let browser: Browser | null = null;
    let mfaIsRequired = false;

    try {
      console.log("🚀 Starting stealth browser with Puppeteer...");

      // Launch browser with stealth
      browser = await puppeteer.launch({
        headless: debugMode ? false : "new", // Use new headless mode
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
        ignoreHTTPSErrors: true,
      });

      const page = await browser.newPage();

      // Set viewport
      await page.setViewport({ width: 1920, height: 1080 });

      // Set extra headers
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      });

      // Navigate to login page
      console.log("📄 Navigating to login page...");
      await page.goto(`${this.airtableBaseUrl}/login`, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      // Wait for anti-bot checks
      await page.waitForTimeout(5000);

      // Fill email
      console.log("📧 Filling email...");
      await page.waitForSelector('input[type="email"]', {
        visible: true,
        timeout: 30000,
      });

      // Type slowly like a human
      await page.type('input[type="email"]', email, { delay: 100 });
      await page.waitForTimeout(1000);

      // Click continue
      console.log("🔘 Clicking continue...");
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
          .catch(() => {}),
        page.click('button:has-text("Continue"), button[type="button"]'),
      ]);
      await page.waitForTimeout(3000);

      // Fill password
      console.log("🔒 Filling password...");
      await page.waitForSelector('input[type="password"]', {
        visible: true,
        timeout: 15000,
      });

      await page.type('input[type="password"]', password, { delay: 100 });
      await page.waitForTimeout(1000);

      // Submit login
      console.log("✅ Submitting login...");
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
          .catch(() => {}),
        page.click('button[type="submit"]'),
      ]);
      await page.waitForTimeout(3000);

      // Check for MFA
      const mfaInput = await page.$('input[name="code"]');
      if (mfaInput) {
        mfaIsRequired = true;

        if (!mfaCode) {
          await browser.close();
          throw new Error("MFA code is required but not provided");
        }

        console.log("🔐 Entering MFA code...");
        await page.type('input[name="code"]', mfaCode, { delay: 100 });
        await page.waitForTimeout(1000);

        await Promise.all([
          page
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
            .catch(() => {}),
          page.click('button[type="submit"]'),
        ]);
        await page.waitForTimeout(3000);
      }

      // Verify login success
      const currentUrl = page.url();
      console.log("🔍 Current URL:", currentUrl);

      if (
        !currentUrl.includes("/workspace") &&
        !currentUrl.includes("/bases") &&
        !currentUrl.includes("/universe")
      ) {
        await page.screenshot({ path: "login-failed.png" });
        throw new Error("Login failed - not redirected to workspace");
      }

      console.log("✅ Login successful!");

      // Get cookies
      const cookies = await page.cookies();
      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      console.log(`🍪 Retrieved ${cookies.length} cookies`);

      // Log cookie names for debugging
      console.log("Cookie names:", cookies.map((c) => c.name).join(", "));

      await this.storeCookies(cookieString, mfaIsRequired);
      await browser.close();

      return cookieString;
    } catch (error: any) {
      if (browser) await browser.close();
      console.error("❌ Authentication error:", error.message);
      throw new Error(`Failed to authenticate: ${error.message}`);
    }
  }

  /**
   * Validate cookies by making a test request
   */
  async validateCookies(cookies: string): Promise<boolean> {
    try {
      const response = await axios.get(`${this.airtableBaseUrl}/v0.3/user`, {
        headers: {
          Cookie: cookies,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        validateStatus: (status) => status >= 200 && status < 500,
      });

      const isValid = response.status === 200;

      if (isValid) {
        await CookieStore.findOneAndUpdate(
          {},
          {
            isValid: true,
            lastValidated: new Date(),
          }
        );
      }

      return isValid;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get stored cookies with validation
   */
  async getOrExtractCookies(): Promise<string> {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (cookieStore && cookieStore.isValid) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      if (cookieStore.lastValidated > fiveMinutesAgo) {
        console.log("✅ Using cached cookies");
        return cookieStore.cookies;
      }

      const isValid = await this.validateCookies(cookieStore.cookies);
      if (isValid) {
        console.log("✅ Cached cookies still valid");
        return cookieStore.cookies;
      }
    }

    throw new Error(
      "No valid cookies. Please authenticate via /authenticate endpoint"
    );
  }

  /**
   * Backwards compatibility
   */
  async getStoredCookies(): Promise<string | null> {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });
    return cookieStore?.cookies || null;
  }

  /**
   * Fetch revision history for a single record
   */
  async fetchRevisionHistory(
    baseId: string,
    tableId: string,
    recordId: string,
    cookies: string
  ): Promise<any[]> {
    try {
      const url = `${this.airtableBaseUrl}/v0.3/row/${baseId}/${tableId}/${recordId}/readRowActivitiesAndComments`;

      const response = await axios.post(
        url,
        {},
        {
          headers: {
            Cookie: cookies,
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${this.airtableBaseUrl}/${baseId}/${tableId}`,
            Origin: this.airtableBaseUrl,
          },
        }
      );

      if (response.data && response.data.activities) {
        return this.parseRevisionHistory(
          response.data.activities,
          recordId,
          baseId,
          tableId
        );
      }

      return [];
    } catch (error: any) {
      // Don't log every 404 - many records may not have revision history
      if (error.response?.status !== 404) {
        console.error(
          `❌ Error fetching revision for ${recordId}:`,
          error.message
        );
      }

      if (error.response && [401, 403].includes(error.response.status)) {
        console.log("🔄 Cookies invalid, marking for refresh...");
        await CookieStore.findOneAndUpdate({}, { isValid: false });
      }

      throw error;
    }
  }

  /**
   * Parse HTML revision history
   */
  private parseRevisionHistory(
    activities: any[],
    pageId: string,
    baseId: string,
    tableId: string
  ): any[] {
    const revisions: any[] = [];

    for (const activity of activities) {
      if (!activity.htmlContent) continue;

      try {
        const $ = cheerio.load(activity.htmlContent);
        const text = $.text().toLowerCase();

        let changeType = "other";
        let fieldName = "";
        let oldValue = "";
        let newValue = "";

        if (text.includes("assigned") || text.includes("assignee")) {
          changeType = "assignee";
          fieldName = "assignee";

          const match = text.match(/from\s+(.+?)\s+to\s+(.+?)(?:\.|$)/);
          if (match) {
            oldValue = match[1].trim();
            newValue = match[2].trim();
          } else {
            newValue = text.replace(/assigned to\s*/gi, "").trim();
            oldValue = "Unassigned";
          }
        } else if (text.includes("status") || text.includes("changed")) {
          changeType = "status";
          fieldName = "status";

          const match = text.match(/from\s+(.+?)\s+to\s+(.+?)(?:\.|$)/);
          if (match) {
            oldValue = match[1].trim();
            newValue = match[2].trim();
          }
        }

        if (changeType === "assignee" || changeType === "status") {
          revisions.push({
            timestamp: new Date(activity.createdTime),
            user: activity.user?.name || "Unknown",
            changeType,
            fieldName,
            oldValue,
            newValue,
            rawHtml: activity.htmlContent,
          });
        }
      } catch (error) {
        console.error("Error parsing activity:", error);
      }
    }

    return revisions;
  }

  /**
   * Fetch revision history for all pages (up to 200)
   */
  async fetchAllRevisionHistory(batchSize: number = 10): Promise<void> {
    const cookies = await this.getOrExtractCookies();

    const pages = await Page.find().limit(200);
    console.log(`📦 Processing ${pages.length} pages for revision history`);

    let processed = 0;
    let errors = 0;
    let notFound = 0;

    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (page) => {
          try {
            const revisions = await this.fetchRevisionHistory(
              page.baseId,
              page.tableId,
              page.pageId,
              cookies
            );

            if (revisions.length > 0) {
              await RevisionHistory.findOneAndUpdate(
                { pageId: page.pageId },
                {
                  pageId: page.pageId,
                  baseId: page.baseId,
                  tableId: page.tableId,
                  revisions,
                  updatedAt: new Date(),
                },
                { upsert: true, new: true }
              );
              processed++;
            } else {
              notFound++;
            }

            if ((processed + notFound) % 10 === 0) {
              console.log(
                `Progress: ${processed} with data, ${notFound} without, ${errors} errors`
              );
            }
          } catch (error: any) {
            if (error.response?.status === 404) {
              notFound++;
            } else {
              errors++;
              console.error(`❌ Error on page ${page.pageId}:`, error.message);
            }
          }
        })
      );

      if (i + batchSize < pages.length) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    console.log(
      `🎉 Complete! Processed: ${processed}, No history: ${notFound}, Errors: ${errors}`
    );
  }
}
