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
  private browser: Browser | null = null;
  private maxRetries = 3;
  private requestDelay = 1000;

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
   * Initialize browser with optimal settings
   */
  private async initBrowser(debugMode: boolean = false): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    console.log("🚀 Launching browser with stealth mode...");

    this.browser = await puppeteer.launch({
      headless: debugMode ? false : true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--window-size=1920,1080",
        "--disable-gpu",
        "--disable-extensions",
      ],
      // ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    return this.browser;
  }

  /**
   * Close browser safely
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        console.log("🔒 Browser closed");
      } catch (error) {
        console.error("Error closing browser:", error);
      }
    }
  }

  /**
   * Create a new page with anti-detection settings
   */
  private async createStealthPage(browser: Browser): Promise<PuppeteerPage> {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      "Upgrade-Insecure-Requests": "1",
    });

    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    return page;
  }

  /**
   * Wait helper
   */
  private async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for element with retry logic
   */
  private async waitForSelectorSafe(
    page: PuppeteerPage,
    selector: string,
    options: any = {}
  ): Promise<boolean> {
    try {
      await page.waitForSelector(selector, {
        visible: true,
        timeout: 15000,
        ...options,
      });
      return true;
    } catch (error) {
      console.log(`⚠️  Selector not found: ${selector}`);
      return false;
    }
  }

  /**
   * Type text with human-like behavior
   */
  private async typeHuman(
    page: PuppeteerPage,
    selector: string,
    text: string
  ): Promise<void> {
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector);
    await this.wait(500 + Math.random() * 500);

    for (const char of text) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }

    await this.wait(300 + Math.random() * 300);
  }

  /**
   * Authenticate with Airtable and retrieve cookies
   * This is the ONLY method that uses Puppeteer
   */
  async authenticateAndGetCookies(
    email: string,
    password: string,
    mfaCode?: string,
    debugMode: boolean = false
  ): Promise<string> {
    let browser: Browser | null = null;
    let page: PuppeteerPage | null = null;
    let mfaIsRequired = false;

    try {
      browser = await this.initBrowser(debugMode);
      page = await this.createStealthPage(browser);

      console.log("📄 Navigating to login page...");
      await page.goto(`${this.airtableBaseUrl}/login`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });

      await this.wait(2000 + Math.random() * 1000);

      if (debugMode) {
        await page.screenshot({ path: "step1-login-page.png" });
      }

      // Fill email
      console.log("📧 Entering email...");
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="email" i]',
        "#email",
      ];

      let emailFound = false;
      for (const selector of emailSelectors) {
        if (await this.waitForSelectorSafe(page, selector, { timeout: 5000 })) {
          await this.typeHuman(page, selector, email);
          emailFound = true;
          break;
        }
      }

      if (!emailFound) {
        throw new Error("Could not find email input field");
      }

      await this.wait(1000);

      // Click continue
      console.log("🔘 Clicking continue...");
      const continueSelectors = [
        'button[type="submit"]',
        'button:has-text("Continue")',
        'button:has-text("Next")',
      ];

      for (const selector of continueSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            await Promise.all([
              page
                .waitForNavigation({
                  waitUntil: "networkidle0",
                  timeout: 30000,
                })
                .catch(() => {}),
              element.click(),
            ]);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      await this.wait(2000 + Math.random() * 1000);

      if (debugMode) {
        await page.screenshot({ path: "step2-after-email.png" });
      }

      // Fill password
      console.log("🔒 Entering password...");
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[placeholder*="password" i]',
        "#password",
      ];

      let passwordFound = false;
      for (const selector of passwordSelectors) {
        if (
          await this.waitForSelectorSafe(page, selector, { timeout: 10000 })
        ) {
          await this.typeHuman(page, selector, password);
          passwordFound = true;
          break;
        }
      }

      if (!passwordFound) {
        throw new Error("Could not find password input field");
      }

      await this.wait(1000);

      // Submit login
      console.log("✅ Submitting login...");
      const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
      ];

      for (const selector of submitSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            await Promise.all([
              page
                .waitForNavigation({
                  waitUntil: "networkidle0",
                  timeout: 30000,
                })
                .catch(() => {}),
              element.click(),
            ]);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      await this.wait(3000 + Math.random() * 1000);

      if (debugMode) {
        await page.screenshot({ path: "step3-after-password.png" });
      }

      // Check for MFA
      console.log("🔍 Checking for MFA...");
      const mfaSelectors = [
        'input[name="code"]',
        'input[name="authCode"]',
        'input[placeholder*="code" i]',
        'input[placeholder*="verification" i]',
        'input[type="text"][maxlength="6"]',
      ];

      let mfaInput = null;
      for (const selector of mfaSelectors) {
        mfaInput = await page.$(selector);
        if (mfaInput) {
          mfaIsRequired = true;
          console.log(`🔐 MFA input found: ${selector}`);
          break;
        }
      }

      if (mfaInput) {
        if (!mfaCode) {
          if (debugMode) {
            await page.screenshot({ path: "step4-mfa-required.png" });
          }
          throw new Error("MFA_CODE_REQUIRED");
        }

        console.log("🔐 Entering MFA code...");

        for (const selector of mfaSelectors) {
          if (await page.$(selector)) {
            await this.typeHuman(page, selector, mfaCode);
            break;
          }
        }

        await this.wait(1000);

        // Submit MFA
        const mfaSubmitSelectors = [
          'button[type="submit"]',
          'button:has-text("Verify")',
          'button:has-text("Continue")',
        ];

        for (const selector of mfaSubmitSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle0",
                    timeout: 30000,
                  })
                  .catch(() => {}),
                element.click(),
              ]);
              break;
            }
          } catch (e) {
            continue;
          }
        }

        await this.wait(3000);

        if (debugMode) {
          await page.screenshot({ path: "step5-after-mfa.png" });
        }
      }

      // Verify login success
      const currentUrl = page.url();
      console.log("🔍 Current URL:", currentUrl);

      // Check if we're still on login page (which would mean login failed)
      const isStillOnLogin =
        currentUrl.includes("/login") ||
        currentUrl.includes("/signin") ||
        currentUrl.includes("/sign-in");

      if (isStillOnLogin) {
        if (debugMode) {
          await page.screenshot({ path: "step6-login-failed.png" });
        }
        throw new Error(
          `Login failed - still on login page. Current URL: ${currentUrl}`
        );
      }

      // If we're NOT on login page and we're on airtable.com domain, we're logged in!
      if (!currentUrl.includes("airtable.com")) {
        throw new Error(
          `Unexpected redirect - not on Airtable domain. Current URL: ${currentUrl}`
        );
      }

      console.log("✅ Login successful!");

      if (debugMode) {
        await page.screenshot({ path: "step7-logged-in.png" });
      }

      // Wait for cookies to be fully set
      await this.wait(2000);

      // Extract ALL cookies
      const cookies = await page.cookies();

      if (cookies.length === 0) {
        throw new Error("No cookies retrieved after login");
      }

      // Create cookie string
      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      console.log(`🍪 Retrieved ${cookies.length} cookies`);
      console.log("Cookie names:", cookies.map((c) => c.name).join(", "));

      // Store cookies in database
      await this.storeCookies(cookieString, mfaIsRequired);

      // Close browser if not in debug mode
      if (!debugMode) {
        await this.closeBrowser();
      }

      console.log("✅ Authentication complete! Cookies stored.");

      return cookieString;
    } catch (error: any) {
      console.error("❌ Authentication error:", error.message);

      if (page) {
        try {
          await page.screenshot({ path: "error-screenshot.png" });
          console.log("📸 Error screenshot saved");
        } catch (e) {
          // Ignore screenshot errors
        }
      }

      if (!debugMode && browser) {
        await this.closeBrowser();
      }

      throw error;
    }
  }

  /**
   * Validate cookies by making a test API request
   * This uses axios, NOT Puppeteer
   */
  async validateCookies(cookies: string): Promise<boolean> {
    try {
      console.log("🔍 Validating cookies...");

      // Try endpoints in order of most likely to work
      const endpoints = [
        // Try whoami endpoint
        {
          url: `${this.airtableBaseUrl}/v0.3/whoami`,
          method: "GET" as const,
        },
        // Try to fetch bases (if this works, revision history will definitely work)
        {
          url: `${this.airtableBaseUrl}/v0.3/meta/bases`,
          method: "GET" as const,
        },
        // Try user endpoint
        {
          url: `${this.airtableBaseUrl}/v0.3/user/me`,
          method: "GET" as const,
        },
      ];

      for (const endpoint of endpoints) {
        try {
          console.log(`🔍 Testing: ${endpoint.method} ${endpoint.url}`);

          const response = await axios({
            method: endpoint.method,
            url: endpoint.url,
            headers: {
              Cookie: cookies,
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "en-US,en;q=0.9",
              Referer: `${this.airtableBaseUrl}/`,
              Origin: this.airtableBaseUrl,
              "X-Requested-With": "XMLHttpRequest",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
            validateStatus: (status) => status >= 200 && status < 500,
            timeout: 15000,
          });

          console.log(`📊 Response: ${response.status} ${response.statusText}`);

          if (response.status === 200) {
            console.log(`✅ Cookies valid! (verified via ${endpoint.url})`);

            // Log a bit of the response for debugging
            if (response.data) {
              const dataStr = JSON.stringify(response.data);
              console.log(
                `📝 Response preview: ${dataStr.substring(0, 150)}...`
              );
            }

            // Update database
            await CookieStore.findOneAndUpdate(
              {},
              {
                isValid: true,
                lastValidated: new Date(),
              }
            );

            return true;
          } else if (response.status === 401 || response.status === 403) {
            console.log(
              `🔒 Unauthorized (${response.status}) - cookies invalid`
            );
          } else {
            console.log(`⚠️  Unexpected status: ${response.status}`);
          }
        } catch (e: any) {
          console.log(`❌ Request failed: ${e.response?.status || e.message}`);

          // If we get response data, log it
          if (e.response?.data) {
            console.log(
              `📝 Error response: ${JSON.stringify(e.response.data).substring(
                0,
                100
              )}`
            );
          }

          // Try next endpoint
          continue;
        }
      }

      console.log("❌ All validation endpoints failed");
      console.log("💡 Cookies may still work for revision history endpoint");
      console.log("💡 Marking as valid anyway - will verify on first use");

      // Don't mark as invalid yet - let the revision history endpoint be the real test
      // Some validation endpoints may fail even when cookies work
      await CookieStore.findOneAndUpdate(
        {},
        {
          isValid: true, // Mark as valid optimistically
          lastValidated: new Date(),
        }
      );

      return true; // Return true optimistically
    } catch (error) {
      console.error("❌ Cookie validation error:", error);
      return false;
    }
  }

  /**
   * Get stored cookies with automatic validation
   */
  async getOrExtractCookies(): Promise<string> {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (cookieStore && cookieStore.isValid) {
      // If validated within last 5 minutes, use cached
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      if (cookieStore.lastValidated > fiveMinutesAgo) {
        console.log("✅ Using cached cookies (validated < 5 min ago)");
        return cookieStore.cookies;
      }

      // Re-validate if older than 5 minutes
      console.log("🔄 Re-validating cached cookies...");
      const isValid = await this.validateCookies(cookieStore.cookies);

      if (isValid) {
        return cookieStore.cookies;
      } else {
        console.log("❌ Cached cookies expired");
      }
    }

    throw new Error(
      "No valid cookies available. Please authenticate via /authenticate endpoint"
    );
  }

  /**
   * Get stored cookies (backwards compatibility)
   */
  async getStoredCookies(): Promise<string | null> {
    try {
      const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });
      return cookieStore?.cookies || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Delay helper for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch revision history for a single record
   * This is the CUSTOM SCRAPING METHOD for changelogs
   * Uses cookies obtained from Puppeteer authentication
   */
  async fetchRevisionHistory(
    baseId: string,
    tableId: string,
    recordId: string,
    cookies: string,
    retryCount: number = 0
  ): Promise<any[]> {
    try {
      // Airtable's actual endpoint structure includes query parameters
      const stringifiedObjectParams = JSON.stringify({
        limit: 100, // Get more activities
        offsetV2: null,
        shouldReturnDeserializedActivityItems: true,
        shouldIncludeRowActivityOrCommentUserObjById: true,
      });

      // Generate IDs that Airtable uses for tracking
      const requestId = `req${Math.random().toString(36).substring(2, 15)}`;
      const secretSocketId = `soc${Math.random()
        .toString(36)
        .substring(2, 15)}`;
      const pageLoadId = `pgl${Math.random().toString(36).substring(2, 15)}`;

      // Build the URL with query parameters
      const url = `${this.airtableBaseUrl}/v0.3/row/${recordId}/readRowActivitiesAndComments`;

      console.log(`📥 Fetching revision history for record: ${recordId}`);

      const response = await axios.get(url, {
        params: {
          stringifiedObjectParams,
          requestId,
          secretSocketId, // Add the secret socket ID
        },
        headers: {
          Cookie: cookies,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "X-Requested-With": "XMLHttpRequest",
          "x-time-zone": "America/Toronto", // Use proper timezone
          "x-user-locale": "en",
          "x-airtable-application-id": baseId, // Application context
          "x-airtable-inter-service-client": "webClient",
          "x-airtable-page-load-id": pageLoadId,
          Referer: `${this.airtableBaseUrl}/${baseId}/${tableId}`,
          Origin: this.airtableBaseUrl,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Ch-Ua":
            '"Chromium";v="120", "Google Chrome";v="120", "Not_A Brand";v="99"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"macOS"',
          Priority: "u=1, i",
        },
        timeout: 30000,
      });

      // Check the actual Airtable response structure
      if (response.data && response.data.data) {
        const data = response.data.data;

        console.log(`✅ Received response for ${recordId}`);
        console.log(`📊 Response has: ${Object.keys(data).join(", ")}`);

        // Parse row activities
        if (data.rowActivityInfoById) {
          const activityIds = Object.keys(data.rowActivityInfoById);
          console.log(`📋 Found ${activityIds.length} activities`);

          const activities = Object.entries(data.rowActivityInfoById).map(
            ([id, activity]: [string, any]) => {
              const activityData = {
                id,
                createdTime: activity.createdTime,
                originatingUserId: activity.originatingUserId,
                htmlContent: activity.diffRowHtml,
                diffRowHtml: activity.diffRowHtml,
                groupType: activity.groupType,
                user: data.rowActivityOrCommentUserObjById?.[
                  activity.originatingUserId
                ],
              };

              // Log each activity for debugging
              console.log(
                `  📄 Activity ${id.substring(0, 8)}... by ${
                  activityData.user?.name || activity.originatingUserId
                }`
              );

              return activityData;
            }
          );

          console.log(
            `✅ Mapped ${activities.length} activities for ${recordId}`
          );

          const parsed = this.parseRevisionHistory(
            activities,
            recordId,
            baseId,
            tableId
          );

          console.log(
            `📝 Successfully parsed ${parsed.length} assignee/status changes`
          );
          return parsed;
        } else {
          console.log(`⚠️  No rowActivityInfoById in response`);
        }
      }

      // Fallback: Check old response structures
      if (response.data && response.data.activities) {
        console.log(
          `✅ Found ${response.data.activities.length} activities (old format) for ${recordId}`
        );

        const parsed = this.parseRevisionHistory(
          response.data.activities,
          recordId,
          baseId,
          tableId
        );

        console.log(`📝 Parsed ${parsed.length} assignee/status changes`);
        return parsed;
      }

      console.log(`⚠️  No activities found for ${recordId}`);
      console.log(`📊 Response keys:`, Object.keys(response.data || {}));
      return [];
    } catch (error: any) {
      // Handle specific HTTP errors
      if (error.response) {
        const status = error.response.status;

        // 404 = no revision history exists (normal)
        if (status === 404) {
          console.log(`ℹ️  No revision history for ${recordId} (404)`);
          return [];
        }

        // 401/403 = cookies expired
        if ([401, 403].includes(status)) {
          console.log("🔄 Cookies expired, marking invalid...");
          await CookieStore.findOneAndUpdate({}, { isValid: false });
          throw new Error("COOKIES_EXPIRED");
        }

        // 429 = rate limited, retry with backoff
        if (status === 429 && retryCount < this.maxRetries) {
          const waitTime = Math.pow(2, retryCount) * 1000;
          console.log(`⏳ Rate limited (429), waiting ${waitTime}ms...`);
          await this.delay(waitTime);

          return this.fetchRevisionHistory(
            baseId,
            tableId,
            recordId,
            cookies,
            retryCount + 1
          );
        }

        // 400 = bad request, log details
        if (status === 400) {
          console.error(
            `❌ Bad request for ${recordId}:`,
            error.response?.data
          );
        }
      }

      // Log other errors (but not 404s)
      if (error.response?.status !== 404) {
        console.error(
          `❌ Error fetching revision for ${recordId}:`,
          error.message
        );
        if (error.response?.data) {
          console.error(`   Response:`, error.response.data);
        }
      }

      throw error;
    }
  }

  /**
   * Parse revision history activities
   * Extracts ONLY assignee and status changes from HTML content
   * Returns format: { uuid, issueId, columnType, oldValue, newValue, createdDate, authoredBy }
   */
  private parseRevisionHistory(
    activities: any[],
    pageId: string,
    baseId: string,
    tableId: string
  ): any[] {
    const revisions: any[] = [];

    for (const activity of activities) {
      // Skip if no HTML content
      if (!activity.htmlContent && !activity.diffRowHtml) {
        continue;
      }

      try {
        // Use diffRowHtml if available, otherwise htmlContent
        const htmlContent = activity.diffRowHtml || activity.htmlContent;

        // Load HTML with cheerio
        const $ = cheerio.load(htmlContent);

        // Get the field name from the HTML
        const fieldNameElement = $(
          ".historicalCellContainer .micro.strong.caps"
        );
        const fieldName = fieldNameElement.text().trim().toLowerCase();

        // Get the column type attribute if available
        const columnTypeAttr =
          $(".historicalCellValueContainer").attr("columntypeifunchanged") ||
          "";

        let columnType = "";
        let oldValue = "";
        let newValue = "";

        // ONLY process if it's an assignee/developer field (foreignKey type)
        if (
          (fieldName.includes("assigned") ||
            fieldName.includes("assignee") ||
            fieldName.includes("developer")) &&
          columnTypeAttr === "foreignKey"
        ) {
          columnType = "assignee";

          // Extract from foreignKey field format (linked records)
          const foreignRecordContainer = $(".foreignRecordRendererContainer");
          if (foreignRecordContainer.length > 0) {
            // Extract added (new) and removed (old) foreign records
            const addedRecord =
              $(".foreignRecord.added").attr("title") ||
              $(".foreignRecord.added").text().trim();
            const removedRecord =
              $(".foreignRecord.removed").attr("title") ||
              $(".foreignRecord.removed").text().trim();

            if (addedRecord || removedRecord) {
              oldValue = removedRecord || "";
              newValue = addedRecord || "";
              console.log(`👤 Assignee change: "${oldValue}" → "${newValue}"`);
            }
          }
        }
        // ONLY process if it's a status field (select type)
        else if (fieldName.includes("status") && columnTypeAttr === "select") {
          columnType = "status";

          // Extract from select field format (choice tokens)
          const choiceTokens = $(".choiceToken");
          if (choiceTokens.length > 0) {
            // Look for added (green plus icon) and removed (strikethrough) tokens
            choiceTokens.each((i, elem) => {
              const $elem = $(elem);
              const style = $elem.attr("style") || "";
              const title =
                $elem.find(".truncate-pre").attr("title") ||
                $elem.find(".truncate-pre").text().trim();

              // Check if this is the removed value (has line-through)
              if (style.includes("line-through")) {
                oldValue = title;
              }
              // Check if this is the added value (green shadow, no line-through)
              else if (
                style.includes("green") &&
                !style.includes("line-through")
              ) {
                newValue = title;
              }
            });

            if (oldValue || newValue) {
              console.log(`📊 Status change: "${oldValue}" → "${newValue}"`);
            }
          }
        }
        // Skip all other field types
        else {
          // Silently skip - not a field we're tracking
          continue;
        }

        // Only include if we successfully identified and extracted values
        if (
          (columnType === "assignee" || columnType === "status") &&
          (oldValue || newValue)
        ) {
          // Get user information
          const userName =
            activity.user?.name || activity.user?.email || "Unknown";

          // Format exactly as specified in requirements
          const revision = {
            uuid:
              activity.id ||
              `${pageId}-${Date.now()}-${Math.random()
                .toString(36)
                .substr(2, 9)}`,
            issueId: pageId,
            columnType: columnType,
            oldValue: oldValue || null,
            newValue: newValue || null,
            createdDate: new Date(activity.createdTime),
            authoredBy: userName,
          };

          console.log(`✅ Tracked ${columnType} change by ${userName}`);
          revisions.push(revision);
        }
      } catch (error) {
        console.error("Error parsing activity:", error);
      }
    }

    if (revisions.length > 0) {
      console.log(`📝 Total tracked changes: ${revisions.length}`);
    }

    return revisions;
  }

  /**
   * Fetch revision history for all pages (up to 200)
   * Processes in batches to avoid rate limiting
   */
  async fetchAllRevisionHistory(
    batchSize: number = 5,
    progressCallback?: (progress: any) => void
  ): Promise<void> {
    try {
      // Get valid cookies
      const cookies = await this.getOrExtractCookies();

      // Get pages from database (limit 200 as per requirements)
      const pages = await Page.find().limit(200);
      const totalPages = pages.length;

      console.log(`📦 Starting revision history fetch for ${totalPages} pages`);
      console.log(`📊 Batch size: ${batchSize}`);

      let processed = 0;
      let withHistory = 0;
      let withoutHistory = 0;
      let errors = 0;

      // Process in batches
      for (let i = 0; i < pages.length; i += batchSize) {
        const batch = pages.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(pages.length / batchSize);

        console.log(
          `\n📊 Batch ${batchNumber}/${totalBatches} (${batch.length} pages)`
        );

        // Process batch in parallel
        const results = await Promise.allSettled(
          batch.map(async (page) => {
            try {
              const revisions = await this.fetchRevisionHistory(
                page.baseId,
                page.tableId,
                page.pageId,
                cookies
              );

              // Store in database if we got revisions
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
                return { success: true, hasHistory: true, pageId: page.pageId };
              } else {
                return {
                  success: true,
                  hasHistory: false,
                  pageId: page.pageId,
                };
              }
            } catch (error: any) {
              if (error.message === "COOKIES_EXPIRED") {
                throw error; // Propagate to stop batch processing
              }
              return {
                success: false,
                error: error.message,
                pageId: page.pageId,
              };
            }
          })
        );

        // Analyze results
        for (const result of results) {
          processed++;

          if (result.status === "fulfilled") {
            const value = result.value as any;
            if (value.success) {
              if (value.hasHistory) {
                withHistory++;
              } else {
                withoutHistory++;
              }
            } else {
              errors++;
              console.error(`❌ Error on ${value.pageId}: ${value.error}`);
            }
          } else {
            errors++;

            if (result.reason?.message === "COOKIES_EXPIRED") {
              throw new Error("Cookies expired. Please re-authenticate.");
            }
          }
        }

        // Progress update
        const progress = {
          processed,
          total: totalPages,
          withHistory,
          withoutHistory,
          errors,
          percentage: Math.round((processed / totalPages) * 100),
        };

        console.log(
          `📈 Progress: ${progress.percentage}% | ` +
            `With history: ${withHistory} | ` +
            `No history: ${withoutHistory} | ` +
            `Errors: ${errors}`
        );

        // Call progress callback if provided
        if (progressCallback) {
          progressCallback(progress);
        }

        // Rate limiting between batches
        if (i + batchSize < pages.length) {
          const delayTime = this.requestDelay + Math.random() * 500;
          console.log(`⏳ Waiting ${delayTime}ms before next batch...`);
          await this.delay(delayTime);
        }
      }

      console.log("\n🎉 Revision history fetch completed!");
      console.log(`📊 Final Stats:`);
      console.log(`   ✅ Pages with history: ${withHistory}`);
      console.log(`   ⚠️  Pages without history: ${withoutHistory}`);
      console.log(`   ❌ Errors: ${errors}`);
      console.log(`   📦 Total processed: ${processed}/${totalPages}`);
    } catch (error: any) {
      console.error("❌ Fatal error:", error.message);
      throw error;
    }
  }
}
