import axios from "axios";
import * as cheerio from "cheerio";
import { CookieService } from "./cookie.service";

export interface RevisionHistoryActivity {
  uuid: string;
  issueId: string;
  columnType: string;
  oldValue: string | null;
  newValue: string | null;
  createdDate: Date;
  authoredBy: string;
}

export class RevisionHistoryService {
  private cookieService: CookieService;
  private baseUrl = "https://airtable.com";

  constructor() {
    this.cookieService = new CookieService();
  }

  /**
   * Fetch revision history for a specific record
   */
  async fetchRevisionHistory(
    baseId: string,
    tableId: string,
    recordId: string,
    cookies: string
  ): Promise<RevisionHistoryActivity[]> {
    try {
      const url = `${this.baseUrl}/readRowActivitiesAndComments`;

      const response = await axios.post(
        url,
        {
          baseId: baseId,
          tableId: tableId,
          rowId: recordId,
        },
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

      if (response.data) {
        return this.parseRevisionHistory(response.data, recordId);
      }

      return [];
    } catch (error: any) {
      console.error(
        `Error fetching revision history for record ${recordId}:`,
        error.message
      );

      // Check if cookies are expired
      if (error.response?.status === 401) {
        throw new Error("COOKIES_EXPIRED");
      }

      throw error;
    }
  }

  /**
   * Parse HTML response into structured format
   */
  private parseRevisionHistory(
    htmlContent: string,
    recordId: string
  ): RevisionHistoryActivity[] {
    const activities: RevisionHistoryActivity[] = [];
    const $ = cheerio.load(htmlContent);

    // Parse activities - adjust selectors based on actual Airtable HTML structure
    $(".activity-item").each((index, element) => {
      const $element = $(element);

      const activityType = $element.find(".activity-type").text().trim();
      const timestamp = $element
        .find(".activity-timestamp")
        .attr("data-timestamp");
      const author = $element.find(".activity-author").text().trim();

      // Filter for Assignee and Status changes only
      if (
        activityType.includes("Assignee") ||
        activityType.includes("Status")
      ) {
        const oldValue = $element.find(".old-value").text().trim() || null;
        const newValue = $element.find(".new-value").text().trim() || null;

        activities.push({
          uuid: `${recordId}-${index}`,
          issueId: recordId,
          columnType: activityType.includes("Assignee") ? "Assignee" : "Status",
          oldValue: oldValue,
          newValue: newValue,
          createdDate: timestamp ? new Date(parseInt(timestamp)) : new Date(),
          authoredBy: author,
        });
      }
    });

    return activities;
  }

  /**
   * Batch process revision history for multiple records
   */
  async batchFetchRevisionHistory(
    baseId: string,
    tableId: string,
    recordIds: string[],
    cookies: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<RevisionHistoryActivity[]> {
    const allActivities: RevisionHistoryActivity[] = [];

    for (let i = 0; i < recordIds.length; i++) {
      try {
        const activities = await this.fetchRevisionHistory(
          baseId,
          tableId,
          recordIds[i],
          cookies
        );

        allActivities.push(...activities);

        if (onProgress) {
          onProgress(i + 1, recordIds.length);
        }

        // Rate limiting - avoid overwhelming Airtable
        await this.delay(500);
      } catch (error: any) {
        if (error.message === "COOKIES_EXPIRED") {
          throw error;
        }
        console.error(
          `Failed to fetch revision history for record ${recordIds[i]}:`,
          error
        );
      }
    }

    return allActivities;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
