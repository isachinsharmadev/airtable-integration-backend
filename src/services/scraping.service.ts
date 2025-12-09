import axios from "axios";
import * as cheerio from "cheerio";
import { CookieStore, RevisionHistory, Page } from "../models/airtable.model";

export class ScrapingService {
  private airtableBaseUrl = "https://airtable.com";

  // Authenticate and retrieve cookies
  async authenticateAndGetCookies(
    email: string,
    password: string,
    mfaCode?: string
  ): Promise<string> {
    try {
      const cookies: string[] = [];

      // Step 1: Initial login
      const loginResponse = await axios.post(
        `${this.airtableBaseUrl}/v0.3/authenticatePrimaryEmail`,
        { email, password },
        {
          headers: {
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          maxRedirects: 0,
          validateStatus: () => true,
        }
      );

      // Extract cookies from response
      const setCookies = loginResponse.headers["set-cookie"];
      if (setCookies) {
        setCookies.forEach((cookie: string) => {
          cookies.push(cookie.split(";")[0]);
        });
      }

      // Step 2: Handle MFA if required
      if (loginResponse.data.mfaRequired && mfaCode) {
        const mfaResponse = await axios.post(
          `${this.airtableBaseUrl}/v0.3/verifyMfa`,
          { code: mfaCode },
          {
            headers: {
              "Content-Type": "application/json",
              Cookie: cookies.join("; "),
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            maxRedirects: 0,
            validateStatus: () => true,
          }
        );

        const mfaSetCookies = mfaResponse.headers["set-cookie"];
        if (mfaSetCookies) {
          mfaSetCookies.forEach((cookie: string) => {
            cookies.push(cookie.split(";")[0]);
          });
        }
      }

      const cookieString = cookies.join("; ");

      // Store cookies in database
      await CookieStore.findOneAndUpdate(
        {},
        {
          cookies: cookieString,
          isValid: true,
          lastValidated: new Date(),
          mfaRequired: !!mfaCode,
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      console.log("Cookies retrieved and stored successfully");
      return cookieString;
    } catch (error: any) {
      console.error("Error authenticating:", error.message);
      throw new Error("Failed to authenticate and retrieve cookies");
    }
  }

  // Validate cookies by making a test request
  async validateCookies(cookies: string): Promise<boolean> {
    try {
      const response = await axios.get(`${this.airtableBaseUrl}/v0.3/user`, {
        headers: {
          Cookie: cookies,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        validateStatus: () => true,
      });

      const isValid = response.status === 200;

      // Update database
      await CookieStore.findOneAndUpdate(
        { cookies },
        {
          isValid,
          lastValidated: new Date(),
        }
      );

      return isValid;
    } catch (error) {
      await CookieStore.findOneAndUpdate(
        { cookies },
        { isValid: false, lastValidated: new Date() }
      );
      return false;
    }
  }

  // Get stored cookies
  async getStoredCookies(): Promise<string | null> {
    const cookieStore = await CookieStore.findOne().sort({ updatedAt: -1 });

    if (!cookieStore || !cookieStore.isValid) {
      return null;
    }

    // Validate cookies if last validated more than 1 hour ago
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (cookieStore.lastValidated < hourAgo) {
      const isValid = await this.validateCookies(cookieStore.cookies);
      if (!isValid) {
        return null;
      }
    }

    return cookieStore.cookies;
  }

  // Fetch revision history for a record
  async fetchRevisionHistory(
    baseId: string,
    tableId: string,
    recordId: string,
    cookies: string
  ): Promise<any[]> {
    try {
      const response = await axios.post(
        `${this.airtableBaseUrl}/v0.3/row/${baseId}/${tableId}/${recordId}/readRowActivitiesAndComments`,
        {},
        {
          headers: {
            Cookie: cookies,
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "X-Requested-With": "XMLHttpRequest",
          },
        }
      );

      if (response.data && response.data.activities) {
        return this.parseRevisionHistory(response.data.activities);
      }

      return [];
    } catch (error: any) {
      console.error(
        `Error fetching revision history for record ${recordId}:`,
        error.message
      );
      throw error;
    }
  }

  // Parse HTML revision history into structured format
  private parseRevisionHistory(activities: any[]): any[] {
    const revisions: any[] = [];

    for (const activity of activities) {
      try {
        const $ = cheerio.load(activity.htmlContent || "");
        const timestamp = new Date(activity.createdTime);
        const user = activity.user?.name || "Unknown";

        // Look for assignee and status changes
        const text = $.text().toLowerCase();

        let changeType = "other";
        let fieldName = "";
        let oldValue = "";
        let newValue = "";

        // Detect assignee changes
        if (text.includes("assigned") || text.includes("assignee")) {
          changeType = "assignee";
          fieldName = "assignee";

          // Extract old and new values
          const assignMatch = text.match(/from\s+(.+?)\s+to\s+(.+?)(?:\.|$)/);
          if (assignMatch) {
            oldValue = assignMatch[1].trim();
            newValue = assignMatch[2].trim();
          } else {
            newValue = text.replace(/assigned to/gi, "").trim();
          }
        }
        // Detect status changes
        else if (text.includes("status") || text.includes("changed to")) {
          changeType = "status";
          fieldName = "status";

          const statusMatch = text.match(/from\s+(.+?)\s+to\s+(.+?)(?:\.|$)/);
          if (statusMatch) {
            oldValue = statusMatch[1].trim();
            newValue = statusMatch[2].trim();
          }
        }

        // Only include assignee and status changes
        if (changeType === "assignee" || changeType === "status") {
          revisions.push({
            timestamp,
            user,
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

  // Fetch and store revision history for all pages
  async fetchAllRevisionHistory(batchSize: number = 10): Promise<void> {
    const cookies = await this.getStoredCookies();

    if (!cookies) {
      throw new Error("No valid cookies available. Please authenticate first.");
    }

    // Get all pages from database
    const pages = await Page.find().limit(200); // Limit to 200 as per requirement
    console.log(`Processing ${pages.length} pages for revision history`);

    let processed = 0;
    let errors = 0;

    // Process in batches to avoid overwhelming the server
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

            // Store in database
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
            console.log(`Processed ${processed}/${pages.length} pages`);
          } catch (error: any) {
            errors++;
            console.error(
              `Error processing page ${page.pageId}:`,
              error.message
            );
          }
        })
      );

      // Add delay between batches
      if (i + batchSize < pages.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(
      `Revision history fetch complete. Processed: ${processed}, Errors: ${errors}`
    );
  }
}
