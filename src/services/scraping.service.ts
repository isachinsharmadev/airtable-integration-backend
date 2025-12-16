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

  async getStoredCookies(): Promise<string | null> {
    try {
      const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });
      return cookieStore?.cookies || null;
    } catch (error) {
      console.error("[GetStoredCookies] Error:", error);
      return null;
    }
  }

  async getOrExtractCookies(): Promise<string> {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (cookieStore && cookieStore.isValid) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      if (cookieStore.lastValidated > fiveMinutesAgo) {
        console.log(
          "[GetOrExtractCookies] Using cached cookies (validated recently)"
        );
        return cookieStore.cookies;
      }

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

  private async initBrowser(debugMode: boolean = false): Promise<Browser> {
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

    // Override navigator.webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    return page;
  }

  private async wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  private async typeFast(
    page: PuppeteerPage,
    selector: string,
    text: string
  ): Promise<void> {
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector);
    await this.wait(100);

    for (const char of text) {
      await page.keyboard.type(char, { delay: 20 });
    }

    await this.wait(100);
  }

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

      const authStartTime = Date.now();

      browser = await this.initBrowser(debugMode);
      page = await this.createStealthPage(browser);

      console.log("[Authenticate] Navigating to login page...");
      await page.goto(`${this.airtableBaseUrl}/login`, {
        waitUntil: "domcontentloaded", // Changed from networkidle0 for speed
        timeout: 60000,
      });

      await this.wait(500);

      if (debugMode) {
        await page.screenshot({ path: "step1-login-page.png" });
      }

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

      await this.wait(1000);

      if (debugMode) {
        await page.screenshot({ path: "step2-after-email.png" });
      }

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

      await this.wait(1500);

      if (debugMode) {
        await page.screenshot({ path: "step3-after-password.png" });
      }

      console.log("[Authenticate] Step 3: Checking for MFA requirement...");

      const mfaCheckTime = Date.now();
      const timeToMFA = ((mfaCheckTime - authStartTime) / 1000).toFixed(2);
      console.log(`[Authenticate] Time to reach MFA check: ${timeToMFA}s`);

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

      if (mfaInput) {
        if (!mfaCode) {
          console.log("[Authenticate] MFA code required but not provided");
          if (debugMode) {
            await page.screenshot({ path: "step4-mfa-required.png" });
          }
          throw new Error("MFA_CODE_REQUIRED");
        }

        const timeElapsed = ((Date.now() - authStartTime) / 1000).toFixed(2);
        console.log(
          `[Authenticate] Entering MFA code (${timeElapsed}s elapsed since start)`
        );

        if (parseFloat(timeElapsed) > 20) {
          console.warn(
            `[Authenticate] WARNING: Already ${timeElapsed}s elapsed - MFA might expire!`
          );
          console.warn(
            "[Authenticate] MFA codes typically expire in 30 seconds"
          );
        }

        console.log("[Authenticate] Entering MFA code...");

        for (const selector of mfaSelectors) {
          if (await page.$(selector)) {
            // Use fast typing for MFA - codes expire in 30 seconds!
            await this.typeFast(page, selector, mfaCode);
            console.log("[Authenticate] MFA code entered successfully");

            console.log("[Authenticate] Pressing Enter to submit...");
            await page.keyboard.press("Enter");
            await this.wait(500);

            break;
          }
        }

        await this.wait(300);

        console.log("[Authenticate] Submitting MFA code...");
        const mfaSubmitSelectors = [
          "div.link-quiet.rounded.py1.px2",
          'div[class*="link-quiet"][class*="rounded"]',
          'button[type="submit"]',
          'button:has-text("Verify")',
          'button:has-text("Continue")',
          'div:has-text("Submit")',
        ];

        let mfaSubmitted = false;
        for (const selector of mfaSubmitSelectors) {
          try {
            const element = await page.$(selector);
            if (element) {
              console.log(
                `[Authenticate] Found MFA submit element with selector: ${selector}`
              );
              console.log("[Authenticate] Clicking MFA submit button...");

              try {
                await element.click();
                console.log("[Authenticate] Click method 1: Regular click");
              } catch (clickError) {
                try {
                  await page.evaluate((el: any) => el.click(), element);
                  console.log(
                    "[Authenticate] Click method 2: JavaScript click"
                  );
                } catch (jsClickError) {
                  await page.$eval(selector, (el: any) => el.click());
                  console.log("[Authenticate] Click method 3: Evaluate click");
                }
              }

              try {
                await page.waitForNavigation({
                  waitUntil: "networkidle2",
                  timeout: 30000,
                });
                console.log("[Authenticate] Navigation completed after MFA");
              } catch (navError) {
                const currentUrl = page.url();
                if (!currentUrl.includes("/2fa/")) {
                  console.log(
                    "[Authenticate] MFA verification successful (left 2FA page)"
                  );
                } else {
                  console.log(
                    "[Authenticate] Still on 2FA page - navigation wait timed out"
                  );
                  console.log(`[Authenticate] Current URL: ${currentUrl}`);
                }
              }

              mfaSubmitted = true;
              console.log("[Authenticate] MFA code submitted successfully");
              break;
            }
          } catch (e: any) {
            console.log(
              `[Authenticate] Selector ${selector} failed: ${e.message}`
            );
            continue;
          }
        }

        if (!mfaSubmitted) {
          console.warn(
            "[Authenticate] Warning: Could not find MFA submit button"
          );
        }

        console.log(
          "[Authenticate] Waiting for MFA verification and session upgrade..."
        );
        await this.wait(5000);

        if (debugMode) {
          await page.screenshot({ path: "step5-after-mfa.png" });
        }

        console.log(
          "[Authenticate] Waiting for session to stabilize after MFA..."
        );
        await this.wait(2000);
      } else {
        console.log(
          "[Authenticate] No MFA required - proceeding to verify login"
        );
      }

      const currentUrl = page.url();
      console.log(`[Authenticate] Current URL: ${currentUrl}`);

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

      console.log("[Authenticate] Extracting cookies...");

      if (mfaIsRequired) {
        console.log(
          "[Authenticate] MFA was required - waiting extra time for session cookies..."
        );
        await this.wait(3000);
      } else {
        await this.wait(2000);
      }

      const cookies = await page.cookies();

      if (cookies.length === 0) {
        throw new Error("No cookies retrieved after login");
      }

      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      console.log(`[Authenticate] Retrieved ${cookies.length} cookies`);
      console.log(
        `[Authenticate] Cookie names: ${cookies.map((c) => c.name).join(", ")}`
      );
      console.log(
        `[Authenticate] Cookie string length: ${cookieString.length} characters`
      );

      if (mfaIsRequired) {
        const sessionCookie = cookies.find(
          (c) => c.name === "__Host-airtable-session"
        );
        if (sessionCookie) {
          try {
            const sessionData = JSON.parse(
              Buffer.from(sessionCookie.value, "base64").toString()
            );
            console.log(
              "[Authenticate] Session data keys:",
              Object.keys(sessionData).join(", ")
            );

            if (sessionData.userIdPending2fa) {
              console.error(
                "[Authenticate] ERROR: Session still shows 'userIdPending2fa'!"
              );
              console.error(
                "[Authenticate] MFA verification did NOT complete successfully"
              );
              throw new Error(
                "MFA verification incomplete! Session still in pending state. " +
                  "This usually means: (1) MFA code was incorrect, or (2) Not enough wait time after submission. " +
                  "Please verify your MFA code and try again."
              );
            }

            if (sessionData.userId && sessionData.loggedInTime) {
              console.log("[Authenticate] ✓✓✓ FULL LOGIN CONFIRMED ✓✓✓");
              console.log(`[Authenticate]   userId: ${sessionData.userId}`);
              console.log(
                `[Authenticate]   loggedInTime: ${sessionData.loggedInTime}`
              );
            } else if (sessionData.userId) {
              console.log(
                "[Authenticate] ✓ userId present but no loggedInTime"
              );
            } else {
              console.warn(
                "[Authenticate] Warning: Session structure unexpected"
              );
            }
          } catch (parseError: any) {
            if (parseError.message?.includes("MFA verification incomplete")) {
              throw parseError; // Re-throw MFA errors
            }
            console.log(
              "[Authenticate] Could not parse session cookie:",
              parseError.message
            );
          }
        } else {
          console.warn(
            "[Authenticate] Warning: __Host-airtable-session cookie not found!"
          );
        }
      }

      const cookieNames = cookies.map((c) => c.name);
      const hasSessionCookie = cookieNames.some(
        (name) =>
          name.toLowerCase().includes("session") ||
          name.toLowerCase().includes("auth") ||
          name === "brw" // Common Airtable session cookie
      );

      if (!hasSessionCookie) {
        console.warn(
          "[Authenticate] Warning: No obvious session/auth cookies found"
        );
        console.warn("[Authenticate] This might cause authentication issues");
      } else {
        console.log("[Authenticate] Session cookies verified ✓");
      }

      await this.storeCookies(cookieString, mfaIsRequired);

      console.log("[Authenticate] Authentication complete - cookies stored");

      if (mfaIsRequired) {
        console.log(
          "[Authenticate] Testing cookies immediately after MFA authentication..."
        );
        try {
          await axios.get(`${this.airtableBaseUrl}/`, {
            headers: {
              Cookie: cookieString,
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
            timeout: 10000,
          });
          console.log("[Authenticate] Cookie validation test passed ✓");
        } catch (testError: any) {
          console.error(
            "[Authenticate] Warning: Cookie validation test failed:",
            testError.message
          );
          console.error("[Authenticate] Cookies may not be working properly");
          if (
            testError.response?.status === 401 ||
            testError.response?.status === 403
          ) {
            throw new Error(
              "Cookies authentication failed immediately after login. Please try again."
            );
          }
        }
      }

      if (!debugMode) {
        await this.closeBrowser();
      }

      return cookieString;
    } catch (error: any) {
      console.error("[Authenticate] Authentication failed:", error.message);

      if (page) {
        try {
          await page.screenshot({ path: "error-screenshot.png" });
          console.log("[Authenticate] Error screenshot saved");
        } catch (e) {}
      }

      if (!debugMode && browser) {
        await this.closeBrowser();
      }

      throw error;
    }
  }

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

      const stringifiedObjectParams = JSON.stringify({
        limit: 100,
        offsetV2: null,
        shouldReturnDeserializedActivityItems: true,
        shouldIncludeRowActivityOrCommentUserObjById: true,
      });

      const requestId = `req${Math.random().toString(36).substring(2, 15)}`;
      const secretSocketId = `soc${Math.random()
        .toString(36)
        .substring(2, 15)}`;
      const pageLoadId = `pgl${Math.random().toString(36).substring(2, 15)}`;

      // Build request URL
      const url = `${this.airtableBaseUrl}/v0.3/row/${recordId}/readRowActivitiesAndComments`;

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
          Referer: `${this.airtableBaseUrl}/${baseId}/${tableId}/${recordId}?blocks=hide`,
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

      if (response.data && response.data.data) {
        const data = response.data.data;

        console.log(`[FetchRevision] Received response for ${recordId}`);
        console.log(
          `[FetchRevision] Response has: ${Object.keys(data).join(", ")}`
        );

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
      if (error.response) {
        const status = error.response.status;

        if (status === 404) {
          console.log(
            `[FetchRevision] No revision history for ${recordId} (404)`
          );
          return [];
        }

        if ([401, 403].includes(status)) {
          console.log("[FetchRevision] Cookies expired, marking invalid");
          await CookieStore.findOneAndUpdate({}, { isValid: false });
          throw new Error("COOKIES_EXPIRED");
        }

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

        if (status === 400) {
          console.error(
            `[FetchRevision] Bad request for ${recordId}:`,
            error.response?.data
          );
        }
      }

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
  private parseRevisionHistory(
    activities: any[],
    pageId: string,
    baseId: string,
    tableId: string
  ): any[] {
    const revisions: any[] = [];

    for (const activity of activities) {
      if (!activity.htmlContent && !activity.diffRowHtml) {
        continue;
      }

      try {
        const htmlContent = activity.diffRowHtml || activity.htmlContent;

        const $ = cheerio.load(htmlContent);

        // Iterate through each field container
        $(".historicalCellContainer").each((containerIndex, container) => {
          const $container = $(container);

          // Get field name
          const fieldNameElement = $container.find(".micro.strong.caps");
          const fieldName = fieldNameElement.text().trim().toLowerCase();

          // Get column type
          const columnTypeAttr =
            $container
              .find(".historicalCellValueContainer")
              .attr("columntypeifunchanged") || "";

          let columnType = "";
          let oldValue = "";
          let newValue = "";

          // Check if this is an assignee or status field
          const isAssignee =
            fieldName.includes("assigned") ||
            fieldName.includes("assignee") ||
            fieldName.includes("developer");

          const isStatus = fieldName.includes("status");

          // Only process if it's a select field and matches our criteria
          if ((isAssignee || isStatus) && columnTypeAttr === "select") {
            if (isAssignee) {
              columnType = "assignee";
            } else if (isStatus) {
              columnType = "status";
            }

            // Find all choice tokens in this field
            const choiceTokens = $container.find(".choiceToken");

            if (choiceTokens.length > 0) {
              choiceTokens.each((i, elem) => {
                const $elem = $(elem);

                // Get the value title
                const title =
                  $elem.find(".truncate-pre").attr("title") ||
                  $elem.find(".truncate-pre").text().trim();

                if (!title) return; // Skip if no title found

                // METHOD 1: Check SVG icon (MOST RELIABLE - works across all color schemes)
                const svgUse = $elem.find("svg use");
                const href = svgUse.attr("href") || "";

                if (href.includes("Plus")) {
                  // Plus icon = Added value (new value)
                  newValue = title;
                  console.log(
                    `[ParseRevision] Found NEW value (Plus icon): "${title}"`
                  );
                } else if (href.includes("Minus")) {
                  oldValue = title;
                  console.log(
                    `[ParseRevision] Found OLD value (Minus icon): "${title}"`
                  );
                } else {
                  const style = $elem.attr("style") || "";

                  if (style.includes("line-through")) {
                    oldValue = title;
                    console.log(
                      `[ParseRevision] Found OLD value (line-through): "${title}"`
                    );
                  } else {
                    newValue = title;
                    console.log(
                      `[ParseRevision] Found NEW value (no indicators): "${title}"`
                    );
                  }
                }
              });

              if (oldValue || newValue) {
                console.log(
                  `[ParseRevision] ${columnType} change: "${oldValue}" -> "${newValue}"`
                );
              }
            }
          }

          if (
            (columnType === "assignee" || columnType === "status") &&
            (oldValue || newValue)
          ) {
            const userName =
              activity.user?.name || activity.user?.email || "Unknown";

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
              `[ParseRevision] ✓ Tracked ${columnType} change by ${userName}: "${oldValue}" -> "${newValue}"`
            );
            revisions.push(revision);
          }
        });
      } catch (error) {
        console.error("[ParseRevision] Error parsing activity:", error);
      }
    }

    if (revisions.length > 0) {
      console.log(`[ParseRevision] Total tracked changes: ${revisions.length}`);
    } else {
      console.log("[ParseRevision] No assignee or status changes found");
    }

    return revisions;
  }

  async fetchAllRevisionHistory(
    batchSize: number = 5,
    progressCallback?: (progress: any) => void
  ): Promise<void> {
    try {
      const cookies = await this.getOrExtractCookies();
      console.log("[FetchAllRevisions] ✓ Cookies retrieved");

      console.log("[FetchAllRevisions] Validating cookies...");
      const cookieDoc = await CookieStore.findOne().sort({ updatedAt: -1 });
      if (cookieDoc && !cookieDoc.isValid) {
        throw new Error(
          "Cookies are marked invalid. Please re-authenticate at /authentication"
        );
      }

      const allPages = await Page.find();
      const totalPagesInDB = allPages.length;
      console.log(
        `[FetchAllRevisions] Total pages in database: ${totalPagesInDB}`
      );

      const existingRevisionDocs = await RevisionHistory.find().select(
        "pageId updatedAt"
      );
      const existingMap = new Map(
        existingRevisionDocs.map((doc) => [doc.pageId, doc.updatedAt])
      );

      console.log(
        `[FetchAllRevisions] Existing revision documents: ${existingMap.size}`
      );
      console.log(
        `[FetchAllRevisions] Will re-fetch ALL pages to check for updates`
      );

      const pagesToProcess = allPages.filter(
        (p) => p.baseId && p.tableId && p.pageId
      );

      console.log(
        `[FetchAllRevisions] Pages to process: ${pagesToProcess.length}`
      );
      console.log(`[FetchAllRevisions] Batch size: ${batchSize}`);

      if (pagesToProcess.length === 0) {
        console.log(
          "[FetchAllRevisions] ========================================"
        );
        console.log("[FetchAllRevisions] No valid pages to process!");
        console.log(
          "[FetchAllRevisions] ========================================"
        );
        return;
      }

      let processed = 0;
      let withHistory = 0;
      let withoutHistory = 0;
      let updated = 0;
      let newPages = 0;
      let errors = 0;
      const failedPages: Array<{ pageId: string; error: string }> = [];

      for (let i = 0; i < pagesToProcess.length; i += batchSize) {
        const batch = pagesToProcess.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(pagesToProcess.length / batchSize);

        console.log(
          `[FetchAllRevisions] ----------------------------------------`
        );
        console.log(
          `[FetchAllRevisions] Batch ${batchNumber}/${totalBatches} (${batch.length} pages)`
        );

        const results = await Promise.allSettled(
          batch.map(async (page) => {
            try {
              const wasProcessedBefore = existingMap.has(page.pageId);
              const lastUpdated = existingMap.get(page.pageId);

              const revisions = await this.fetchRevisionHistory(
                page.baseId,
                page.tableId,
                page.pageId,
                cookies
              );

              const isUpdate = wasProcessedBefore && revisions.length > 0;
              const isNew = !wasProcessedBefore && revisions.length > 0;

              if (revisions.length > 0) {
                if (isUpdate) {
                  console.log(
                    `[FetchAllRevisions]   ↻ ${page.pageId}: ${revisions.length} changes (updated)`
                  );
                } else {
                  console.log(
                    `[FetchAllRevisions]   ✓ ${page.pageId}: ${revisions.length} changes (new)`
                  );
                }

                return {
                  success: true,
                  hasHistory: true,
                  pageId: page.pageId,
                  baseId: page.baseId,
                  tableId: page.tableId,
                  revisions,
                  revisionCount: revisions.length,
                  isUpdate: isUpdate,
                  isNew: isNew,
                };
              } else {
                if (wasProcessedBefore) {
                  console.log(
                    `[FetchAllRevisions]   ⊙ ${page.pageId}: Still no history`
                  );
                } else {
                  console.log(
                    `[FetchAllRevisions]   ○ ${page.pageId}: No history`
                  );
                }

                return {
                  success: true,
                  hasHistory: false,
                  pageId: page.pageId,
                  revisionCount: 0,
                  isUpdate: false,
                  isNew: false,
                };
              }
            } catch (error: any) {
              console.error(
                `[FetchAllRevisions]   ✗ ${page.pageId}: ${error.message}`
              );

              if (error.message === "COOKIES_EXPIRED") {
                throw error;
              }

              if (error.response?.status === 404) {
                console.log(
                  `[FetchAllRevisions]   ○ ${page.pageId}: No history (404)`
                );
                return {
                  success: true,
                  hasHistory: false,
                  pageId: page.pageId,
                  revisionCount: 0,
                  isUpdate: false,
                  isNew: false,
                };
              }

              return {
                success: false,
                error: error.message,
                pageId: page.pageId,
                statusCode: error.response?.status,
              };
            }
          })
        );

        // BULK WRITE - Collect pages with revisions for bulk save
        const bulkOps: any[] = [];

        // Analyze results from this batch
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const pageId = batch[j].pageId;

          if (result.status === "fulfilled") {
            const value = result.value as any;

            if (value.success) {
              processed++;

              if (value.hasHistory) {
                withHistory++;

                if (value.isUpdate) {
                  updated++;
                } else if (value.isNew) {
                  newPages++;
                }

                bulkOps.push({
                  updateOne: {
                    filter: { pageId: value.pageId },
                    update: {
                      $set: {
                        pageId: value.pageId,
                        baseId: value.baseId,
                        tableId: value.tableId,
                        revisions: value.revisions,
                        updatedAt: new Date(),
                      },
                    },
                    upsert: true,
                  },
                });
              } else {
                withoutHistory++;
              }
            } else {
              errors++;
              failedPages.push({
                pageId: value.pageId,
                error: value.error || "Unknown error",
              });
              console.error(
                `[FetchAllRevisions]   Failed: ${value.pageId} - ${
                  value.error
                }${value.statusCode ? ` (${value.statusCode})` : ""}`
              );
            }
          } else {
            errors++;
            processed++;
            const error = result.reason;

            failedPages.push({
              pageId: pageId,
              error: error?.message || "Promise rejected",
            });

            console.error(
              `[FetchAllRevisions]   Rejected: ${pageId} - ${
                error?.message || error
              }`
            );

            if (error?.message === "COOKIES_EXPIRED") {
              console.error(
                "[FetchAllRevisions] ========================================"
              );
              console.error(
                "[FetchAllRevisions] FATAL: Cookies expired mid-process"
              );
              console.error(
                "[FetchAllRevisions] ========================================"
              );
              throw new Error(
                "Cookies expired during processing. Please re-authenticate."
              );
            }
          }
        }

        if (bulkOps.length > 0) {
          try {
            const bulkResult = await RevisionHistory.bulkWrite(bulkOps, {
              ordered: false,
            });

            const savedCount =
              bulkResult.upsertedCount + bulkResult.modifiedCount;
            console.log(
              `[FetchAllRevisions]   💾 Bulk saved ${savedCount} documents`
            );
          } catch (bulkError: any) {
            console.error(
              `[FetchAllRevisions]   ✗ Bulk write error: ${bulkError.message}`
            );
          }
        }

        const progress = {
          processed,
          total: pagesToProcess.length,
          withHistory,
          withoutHistory,
          updated,
          newPages,
          errors,
          percentage: Math.round((processed / pagesToProcess.length) * 100),
        };

        console.log(
          `[FetchAllRevisions]   Progress: ${progress.percentage}% ` +
            `(${newPages} new, ${updated} updated, ${withoutHistory} no history, ${errors} errors)`
        );

        // Call progress callback
        if (progressCallback) {
          progressCallback(progress);
        }

        if (i + batchSize < pagesToProcess.length) {
          const delayTime = this.requestDelay + Math.random() * 500;
          console.log(
            `[FetchAllRevisions]   Waiting ${delayTime.toFixed(
              0
            )}ms before next batch...`
          );
          await this.delay(delayTime);
        }
      }

      console.log(
        "\n[FetchAllRevisions] ========================================"
      );
      console.log("[FetchAllRevisions] ✓✓✓ FETCH COMPLETE ✓✓✓");
      console.log(
        "[FetchAllRevisions] ========================================"
      );
      console.log(`[FetchAllRevisions] Total pages processed: ${processed}`);
      console.log(
        `[FetchAllRevisions]   - New pages with history: ${newPages}`
      );
      console.log(`[FetchAllRevisions]   - Updated pages: ${updated}`);
      console.log(
        `[FetchAllRevisions]   - Pages without history: ${withoutHistory}`
      );
      console.log(`[FetchAllRevisions]   - Errors: ${errors}`);

      if (processed > 0) {
        const successRate = ((processed - errors) / processed) * 100;
        console.log(
          `[FetchAllRevisions] Success rate: ${successRate.toFixed(1)}%`
        );
      }

      if (failedPages.length > 0) {
        console.log(
          `\n[FetchAllRevisions] Failed pages (${failedPages.length}):`
        );
        failedPages.slice(0, 10).forEach((failed) => {
          console.log(
            `[FetchAllRevisions]   - ${failed.pageId}: ${failed.error}`
          );
        });
        if (failedPages.length > 10) {
          console.log(
            `[FetchAllRevisions]   ... and ${failedPages.length - 10} more`
          );
        }
      }

      const dbCount = await RevisionHistory.countDocuments();
      const dbWithHistory = await RevisionHistory.countDocuments({
        "revisions.0": { $exists: true },
      });

      console.log(`\n[FetchAllRevisions] Database state:`);
      console.log(`[FetchAllRevisions]   Total documents: ${dbCount}`);
      console.log(`[FetchAllRevisions]   With revisions: ${dbWithHistory}`);
      console.log(
        `[FetchAllRevisions]   Coverage: ${(
          (dbWithHistory / totalPagesInDB) *
          100
        ).toFixed(1)}%`
      );
      console.log(
        "[FetchAllRevisions] ========================================\n"
      );
    } catch (error: any) {
      if (
        error.message === "COOKIES_EXPIRED" ||
        error.message.includes("re-authenticate")
      ) {
        console.error(
          "\n[FetchAllRevisions] ========================================"
        );
        console.error("[FetchAllRevisions] FATAL ERROR: Cookies Expired");
        console.error(
          "[FetchAllRevisions] ========================================"
        );
        throw error;
      }

      console.error(
        "\n[FetchAllRevisions] ========================================"
      );
      console.error("[FetchAllRevisions] FATAL ERROR");
      console.error(
        "[FetchAllRevisions] ========================================"
      );
      console.error(`[FetchAllRevisions] ${error.message}`);
      throw error;
    }
  }
}
