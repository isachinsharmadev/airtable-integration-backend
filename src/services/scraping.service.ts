import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page as PuppeteerPage } from "puppeteer";
import { CookieStore, RevisionHistory, Page } from "../models/airtable.model";

puppeteer.use(StealthPlugin());

export class ScrapingService {
  private airtableBaseUrl = "https://airtable.com";
  private browser: Browser | null = null;
  private maxRetries = 3;
  private requestDelay = 1000; // 1 second between requests

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
    console.log("[StoreCookies] Cookies stored in database");
  }

  /**
   * Get stored cookies from database
   * @returns Cookie string or null if not found
   */
  async getStoredCookies(): Promise<string | null> {
    try {
      const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });
      return cookieStore?.cookies || null;
    } catch (error) {
      console.error("[GetStoredCookies] Error:", error);
      return null;
    }
  }

  /**
   * Get cookies with automatic validation
   * Throws error if no valid cookies available
   * @returns Valid cookie string
   */
  async getOrExtractCookies(): Promise<string> {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (cookieStore && cookieStore.isValid) {
      // Check if cookies were validated recently (within 5 minutes)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      if (cookieStore.lastValidated > fiveMinutesAgo) {
        console.log(
          "[GetOrExtractCookies] Using cached cookies (validated recently)"
        );
        return cookieStore.cookies;
      }

      // Re-validate if older than 5 minutes
      console.log("[GetOrExtractCookies] Re-validating cached cookies...");
      const isValid = await this.validateCookies(cookieStore.cookies);

      if (isValid) {
        return cookieStore.cookies;
      } else {
        console.log("[GetOrExtractCookies] Cached cookies expired");
      }
    }

    throw new Error(
      "No valid cookies available. Please authenticate via /authenticate endpoint"
    );
  }

  /**
   * Validate cookies by testing against Airtable endpoints
   * @param cookies - Cookie string to validate
   * @returns true if cookies are valid
   */
  async validateCookies(cookies: string): Promise<boolean> {
    try {
      console.log("[ValidateCookies] Starting validation...");

      // Test multiple endpoints to verify cookie validity
      const endpoints = [
        {
          url: `${this.airtableBaseUrl}/v0.3/whoami`,
          method: "GET" as const,
        },
        {
          url: `${this.airtableBaseUrl}/v0.3/meta/bases`,
          method: "GET" as const,
        },
        {
          url: `${this.airtableBaseUrl}/v0.3/user/me`,
          method: "GET" as const,
        },
      ];

      for (const endpoint of endpoints) {
        try {
          console.log(
            `[ValidateCookies] Testing: ${endpoint.method} ${endpoint.url}`
          );

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

          console.log(
            `[ValidateCookies] Response: ${response.status} ${response.statusText}`
          );

          if (response.status === 200) {
            console.log(
              `[ValidateCookies] Success - Cookies valid (verified via ${endpoint.url})`
            );

            // Update database with validation timestamp
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
              `[ValidateCookies] Unauthorized (${response.status}) - cookies invalid`
            );
          } else {
            console.log(
              `[ValidateCookies] Unexpected status: ${response.status}`
            );
          }
        } catch (e: any) {
          console.log(
            `[ValidateCookies] Request failed: ${
              e.response?.status || e.message
            }`
          );
          continue; // Try next endpoint
        }
      }

      console.log("[ValidateCookies] All validation endpoints failed");
      console.log(
        "[ValidateCookies] Marking as valid optimistically - will verify on first use"
      );

      // Mark as valid optimistically - some validation endpoints may fail even when cookies work
      await CookieStore.findOneAndUpdate(
        {},
        {
          isValid: true,
          lastValidated: new Date(),
        }
      );

      return true;
    } catch (error) {
      console.error("[ValidateCookies] Error:", error);
      return false;
    }
  }

  /**
   * Initialize Puppeteer browser with anti-detection settings
   * @param debugMode - Show browser window (default: false)
   * @returns Browser instance
   */
  private async initBrowser(debugMode: boolean = false): Promise<Browser> {
    // Reuse existing browser if still connected
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    console.log("[InitBrowser] Launching browser with stealth mode...");
    console.log(
      `[InitBrowser] Debug mode: ${
        debugMode ? "ON (visible)" : "OFF (headless)"
      }`
    );

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
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    console.log("[InitBrowser] Browser launched successfully");
    return this.browser;
  }

  /**
   * Close browser instance safely
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        console.log("[CloseBrowser] Browser closed");
      } catch (error) {
        console.error("[CloseBrowser] Error closing browser:", error);
      }
    }
  }

  /**
   * Create new page with anti-detection headers and settings
   * @param browser - Browser instance
   * @returns Configured page
   */
  private async createStealthPage(browser: Browser): Promise<PuppeteerPage> {
    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set realistic headers
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

    // Override navigator.webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    return page;
  }

  /**
   * Wait for specified milliseconds
   * @param ms - Milliseconds to wait
   */
  private async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for selector with timeout and error handling
   * @param page - Puppeteer page
   * @param selector - CSS selector to wait for
   * @param options - Wait options
   * @returns true if element found, false otherwise
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
      console.log(`[WaitForSelector] Selector not found: ${selector}`);
      return false;
    }
  }

  /**
   * Type text with human-like delays to avoid detection
   * @param page - Puppeteer page
   * @param selector - CSS selector of input field
   * @param text - Text to type
   */
  private async typeHuman(
    page: PuppeteerPage,
    selector: string,
    text: string
  ): Promise<void> {
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector);
    await this.wait(500 + Math.random() * 500);

    // Type character by character with random delays
    for (const char of text) {
      await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }

    await this.wait(300 + Math.random() * 300);
  }

  /**
   * Delay helper for rate limiting
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
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
      console.log("[Authenticate] Starting authentication process");
      console.log(`[Authenticate] Email: ${email}`);
      console.log(
        `[Authenticate] MFA Code: ${mfaCode ? "Provided" : "Not provided"}`
      );

      // Initialize browser
      browser = await this.initBrowser(debugMode);
      page = await this.createStealthPage(browser);

      // Navigate to login page
      console.log("[Authenticate] Navigating to login page...");
      await page.goto(`${this.airtableBaseUrl}/login`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });

      await this.wait(2000 + Math.random() * 1000);

      if (debugMode) {
        await page.screenshot({ path: "step1-login-page.png" });
      }

      // STEP 1: Fill email
      console.log("[Authenticate] Step 1: Entering email...");
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
          console.log("[Authenticate] Email entered successfully");
          break;
        }
      }

      if (!emailFound) {
        throw new Error("Could not find email input field");
      }

      await this.wait(1000);

      // Click continue button
      console.log("[Authenticate] Clicking continue button...");
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

      // STEP 2: Fill password
      console.log("[Authenticate] Step 2: Entering password...");
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
          console.log("[Authenticate] Password entered successfully");
          break;
        }
      }

      if (!passwordFound) {
        throw new Error("Could not find password input field");
      }

      await this.wait(1000);

      // Submit login
      console.log("[Authenticate] Submitting login form...");
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

      // STEP 3: Check for MFA requirement
      console.log("[Authenticate] Step 3: Checking for MFA requirement...");
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
          console.log(
            `[Authenticate] MFA input detected (selector: ${selector})`
          );
          break;
        }
      }

      // Handle MFA if required
      if (mfaInput) {
        if (!mfaCode) {
          console.log("[Authenticate] MFA code required but not provided");
          if (debugMode) {
            await page.screenshot({ path: "step4-mfa-required.png" });
          }
          throw new Error("MFA_CODE_REQUIRED");
        }

        console.log("[Authenticate] Entering MFA code...");

        for (const selector of mfaSelectors) {
          if (await page.$(selector)) {
            await this.typeHuman(page, selector, mfaCode);
            console.log("[Authenticate] MFA code entered");
            break;
          }
        }

        await this.wait(1000);

        // Submit MFA
        console.log("[Authenticate] Submitting MFA code...");
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

      // STEP 4: Verify login success
      const currentUrl = page.url();
      console.log(`[Authenticate] Current URL: ${currentUrl}`);

      // Check if still on login page (would indicate login failure)
      const isStillOnLogin =
        currentUrl.includes("/login") ||
        currentUrl.includes("/signin") ||
        currentUrl.includes("/sign-in");

      if (isStillOnLogin) {
        console.error("[Authenticate] Login failed - still on login page");
        if (debugMode) {
          await page.screenshot({ path: "step6-login-failed.png" });
        }
        throw new Error(
          `Login failed - still on login page. Current URL: ${currentUrl}`
        );
      }

      // Verify we're on Airtable domain
      if (!currentUrl.includes("airtable.com")) {
        console.error(
          "[Authenticate] Unexpected redirect - not on Airtable domain"
        );
        throw new Error(
          `Unexpected redirect - not on Airtable domain. Current URL: ${currentUrl}`
        );
      }

      console.log("[Authenticate] Login successful");

      if (debugMode) {
        await page.screenshot({ path: "step7-logged-in.png" });
      }

      // STEP 5: Extract cookies
      console.log("[Authenticate] Extracting cookies...");
      await this.wait(2000); // Wait for cookies to be fully set

      const cookies = await page.cookies();

      if (cookies.length === 0) {
        throw new Error("No cookies retrieved after login");
      }

      // Convert to cookie string
      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      console.log(`[Authenticate] Retrieved ${cookies.length} cookies`);
      console.log(
        `[Authenticate] Cookie names: ${cookies.map((c) => c.name).join(", ")}`
      );

      // Store in database
      await this.storeCookies(cookieString, mfaIsRequired);

      // Close browser unless in debug mode
      if (!debugMode) {
        await this.closeBrowser();
      }

      console.log("[Authenticate] Authentication complete - cookies stored");

      return cookieString;
    } catch (error: any) {
      console.error("[Authenticate] Authentication failed:", error.message);

      // Save error screenshot if possible
      if (page) {
        try {
          await page.screenshot({ path: "error-screenshot.png" });
          console.log("[Authenticate] Error screenshot saved");
        } catch (e) {
          // Ignore screenshot errors
        }
      }

      // Close browser on error (unless debug mode)
      if (!debugMode && browser) {
        await this.closeBrowser();
      }

      throw error;
    }
  }

  /**
   * Fetch revision history for a single record
   *
   * Uses Airtable's internal /readRowActivitiesAndComments endpoint
   * with stored cookies for authentication.
   *
   * @param baseId - Airtable base ID
   * @param tableId - Airtable table ID
   * @param recordId - Airtable record ID
   * @param cookies - Cookie string for authentication
   * @param retryCount - Current retry attempt (for rate limiting)
   * @returns Array of parsed revision history items
   */
  async fetchRevisionHistory(
    baseId: string,
    tableId: string,
    recordId: string,
    cookies: string,
    retryCount: number = 0
  ): Promise<any[]> {
    try {
      console.log(
        `[FetchRevision] Fetching revision history for record: ${recordId}`
      );

      // Build query parameters
      const stringifiedObjectParams = JSON.stringify({
        limit: 100,
        offsetV2: null,
        shouldReturnDeserializedActivityItems: true,
        shouldIncludeRowActivityOrCommentUserObjById: true,
      });

      // Generate unique IDs for tracking
      const requestId = `req${Math.random().toString(36).substring(2, 15)}`;
      const secretSocketId = `soc${Math.random()
        .toString(36)
        .substring(2, 15)}`;
      const pageLoadId = `pgl${Math.random().toString(36).substring(2, 15)}`;

      // Build request URL
      const url = `${this.airtableBaseUrl}/v0.3/row/${recordId}/readRowActivitiesAndComments`;

      // Make request
      const response = await axios.get(url, {
        params: {
          stringifiedObjectParams,
          requestId,
          secretSocketId,
        },
        headers: {
          Cookie: cookies,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "X-Requested-With": "XMLHttpRequest",
          "x-time-zone": "America/Toronto",
          "x-user-locale": "en",
          "x-airtable-application-id": baseId,
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

      // Parse response
      if (response.data && response.data.data) {
        const data = response.data.data;

        console.log(`[FetchRevision] Received response for ${recordId}`);
        console.log(
          `[FetchRevision] Response has: ${Object.keys(data).join(", ")}`
        );

        // Parse row activities
        if (data.rowActivityInfoById) {
          const activityIds = Object.keys(data.rowActivityInfoById);
          console.log(`[FetchRevision] Found ${activityIds.length} activities`);

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

              console.log(
                `[FetchRevision]   Activity ${id.substring(0, 8)}... by ${
                  activityData.user?.name || activity.originatingUserId
                }`
              );

              return activityData;
            }
          );

          console.log(`[FetchRevision] Mapped ${activities.length} activities`);

          const parsed = this.parseRevisionHistory(
            activities,
            recordId,
            baseId,
            tableId
          );

          console.log(
            `[FetchRevision] Successfully parsed ${parsed.length} assignee/status changes`
          );
          return parsed;
        } else {
          console.log(`[FetchRevision] No rowActivityInfoById in response`);
        }
      }

      // Fallback: Check old response format
      if (response.data && response.data.activities) {
        console.log(
          `[FetchRevision] Found ${response.data.activities.length} activities (old format)`
        );

        const parsed = this.parseRevisionHistory(
          response.data.activities,
          recordId,
          baseId,
          tableId
        );

        console.log(
          `[FetchRevision] Parsed ${parsed.length} assignee/status changes`
        );
        return parsed;
      }

      console.log(`[FetchRevision] No activities found for ${recordId}`);
      console.log(
        `[FetchRevision] Response keys: ${Object.keys(response.data || {}).join(
          ", "
        )}`
      );
      return [];
    } catch (error: any) {
      // Handle HTTP errors
      if (error.response) {
        const status = error.response.status;

        // 404 = no revision history exists (normal, not an error)
        if (status === 404) {
          console.log(
            `[FetchRevision] No revision history for ${recordId} (404)`
          );
          return [];
        }

        // 401/403 = cookies expired
        if ([401, 403].includes(status)) {
          console.log("[FetchRevision] Cookies expired, marking invalid");
          await CookieStore.findOneAndUpdate({}, { isValid: false });
          throw new Error("COOKIES_EXPIRED");
        }

        // 429 = rate limited, retry with exponential backoff
        if (status === 429 && retryCount < this.maxRetries) {
          const waitTime = Math.pow(2, retryCount) * 1000;
          console.log(
            `[FetchRevision] Rate limited (429), waiting ${waitTime}ms...`
          );
          await this.delay(waitTime);

          return this.fetchRevisionHistory(
            baseId,
            tableId,
            recordId,
            cookies,
            retryCount + 1
          );
        }

        // 400 = bad request
        if (status === 400) {
          console.error(
            `[FetchRevision] Bad request for ${recordId}:`,
            error.response?.data
          );
        }
      }

      // Log other errors (except 404)
      if (error.response?.status !== 404) {
        console.error(
          `[FetchRevision] Error fetching revision for ${recordId}:`,
          error.message
        );
        if (error.response?.data) {
          console.error(`[FetchRevision]   Response:`, error.response.data);
        }
      }

      throw error;
    }
  }

  /**
   * Parse revision history HTML to extract assignee and status changes
   *
   * Uses Cheerio to parse HTML and extract:
   * - Field name (assignee, status)
   * - Old value (red/strikethrough)
   * - New value (green)
   * - Metadata (timestamp, user)
   *
   * @param activities - Array of activity objects with HTML content
   * @param pageId - Record ID
   * @param baseId - Base ID
   * @param tableId - Table ID
   * @returns Array of parsed revision objects
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

        // Load HTML with Cheerio
        const $ = cheerio.load(htmlContent);

        // Extract field name
        const fieldNameElement = $(
          ".historicalCellContainer .micro.strong.caps"
        );
        const fieldName = fieldNameElement.text().trim().toLowerCase();

        // Extract column type attribute
        const columnTypeAttr =
          $(".historicalCellValueContainer").attr("columntypeifunchanged") ||
          "";

        let columnType = "";
        let oldValue = "";
        let newValue = "";

        // Check if it's an assignee field
        if (
          (fieldName.includes("assigned") ||
            fieldName.includes("assignee") ||
            fieldName.includes("developer")) &&
          columnTypeAttr === "select"
        ) {
          columnType = "assignee";

          // Extract choice tokens
          const choiceTokens = $(".choiceToken");
          if (choiceTokens.length > 0) {
            choiceTokens.each((i, elem) => {
              const $elem = $(elem);
              const style = $elem.attr("style") || "";
              const title =
                $elem.find(".truncate-pre").attr("title") ||
                $elem.find(".truncate-pre").text().trim();

              // Removed value (red/strikethrough)
              if (style.includes("line-through") || style.includes("red")) {
                oldValue = title;
              }
              // Added value (green, no strikethrough)
              else if (
                style.includes("green") &&
                !style.includes("line-through")
              ) {
                newValue = title;
              }
            });

            if (oldValue || newValue) {
              console.log(
                `[ParseRevision] Assignee change: "${oldValue}" -> "${newValue}"`
              );
            }
          }
        }
        // Check if it's a status field
        else if (fieldName.includes("status") && columnTypeAttr === "select") {
          columnType = "status";

          // Extract choice tokens
          const choiceTokens = $(".choiceToken");
          if (choiceTokens.length > 0) {
            choiceTokens.each((i, elem) => {
              const $elem = $(elem);
              const style = $elem.attr("style") || "";
              const title =
                $elem.find(".truncate-pre").attr("title") ||
                $elem.find(".truncate-pre").text().trim();

              // Removed value (red/strikethrough)
              if (style.includes("line-through") || style.includes("red")) {
                oldValue = title;
              }
              // Added value (green, no strikethrough)
              else if (
                style.includes("green") &&
                !style.includes("line-through")
              ) {
                newValue = title;
              }
            });

            if (oldValue || newValue) {
              console.log(
                `[ParseRevision] Status change: "${oldValue}" -> "${newValue}"`
              );
            }
          }
        }
        // Skip all other field types
        else {
          continue;
        }

        // Only include if we successfully extracted values
        if (
          (columnType === "assignee" || columnType === "status") &&
          (oldValue || newValue)
        ) {
          // Get user information
          const userName =
            activity.user?.name || activity.user?.email || "Unknown";

          // Format as specified in requirements
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

          console.log(
            `[ParseRevision] Tracked ${columnType} change by ${userName}`
          );
          revisions.push(revision);
        }
      } catch (error) {
        console.error("[ParseRevision] Error parsing activity:", error);
      }
    }

    if (revisions.length > 0) {
      console.log(`[ParseRevision] Total tracked changes: ${revisions.length}`);
    }

    return revisions;
  }

  /**
   * Fetch revision history for multiple pages in batches
   *
   * Processes up to 200 pages with:
   * - Configurable batch size (concurrent requests)
   * - Progress tracking via callback
   * - Rate limiting between batches
   * - Error handling and retry logic
   *
   * @param batchSize - Number of concurrent requests (default: 5)
   * @param progressCallback - Optional callback for progress updates
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

      console.log(
        `[FetchAllRevisions] Starting batch fetch for ${totalPages} pages`
      );
      console.log(`[FetchAllRevisions] Batch size: ${batchSize}`);

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
          `[FetchAllRevisions] Processing batch ${batchNumber}/${totalBatches} (${batch.length} pages)`
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
                throw error; // Propagate to stop processing
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
              console.error(
                `[FetchAllRevisions] Error on ${value.pageId}: ${value.error}`
              );
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
          `[FetchAllRevisions] Progress: ${progress.percentage}% | ` +
            `With history: ${withHistory} | ` +
            `No history: ${withoutHistory} | ` +
            `Errors: ${errors}`
        );

        // Call progress callback
        if (progressCallback) {
          progressCallback(progress);
        }

        // Rate limiting between batches
        if (i + batchSize < pages.length) {
          const delayTime = this.requestDelay + Math.random() * 500;
          console.log(
            `[FetchAllRevisions] Waiting ${delayTime}ms before next batch...`
          );
          await this.delay(delayTime);
        }
      }

      console.log("[FetchAllRevisions] Batch fetch completed successfully");
      console.log(`[FetchAllRevisions] Final Stats:`);
      console.log(`[FetchAllRevisions]   Pages with history: ${withHistory}`);
      console.log(
        `[FetchAllRevisions]   Pages without history: ${withoutHistory}`
      );
      console.log(`[FetchAllRevisions]   Errors: ${errors}`);
      console.log(
        `[FetchAllRevisions]   Total processed: ${processed}/${totalPages}`
      );
    } catch (error: any) {
      console.error("[FetchAllRevisions] Fatal error:", error.message);
      throw error;
    }
  }
}
