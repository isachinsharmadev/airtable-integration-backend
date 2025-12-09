import puppeteer, { Browser, Page } from "puppeteer";
import axios from "axios";

export interface AirtableCookies {
  cookies: string;
  timestamp: Date;
  isValid: boolean;
}

export class CookieService {
  private browser: Browser | null = null;
  private storedCookies: AirtableCookies | null = null;

  async initializeBrowser(): Promise<void> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: false, // Set to true in production
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Retrieve cookies from Airtable using email/password and MFA code
   */
  async retrieveCookies(
    email: string,
    password: string,
    mfaCode?: string
  ): Promise<AirtableCookies> {
    try {
      await this.initializeBrowser();

      const page = await this.browser!.newPage();

      // Navigate to Airtable login
      await page.goto("https://airtable.com/login", {
        waitUntil: "networkidle2",
      });

      // Fill in email
      await page.waitForSelector('input[type="email"]');
      await page.type('input[type="email"]', email);
      await page.click('button[type="submit"]');

      // Fill in password
      await page.waitForSelector('input[type="password"]');
      await page.type('input[type="password"]', password);
      await page.click('button[type="submit"]');

      // Handle MFA if required
      if (mfaCode) {
        await page
          .waitForSelector('input[name="authCode"]', { timeout: 5000 })
          .catch(() => console.log("No MFA required or already handled"));

        if (await page.$('input[name="authCode"]')) {
          await page.type('input[name="authCode"]', mfaCode);
          await page.click('button[type="submit"]');
        }
      }

      // Wait for successful login
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Extract cookies
      const cookies = await page.cookies();
      const cookieString = cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");

      this.storedCookies = {
        cookies: cookieString,
        timestamp: new Date(),
        isValid: true,
      };

      await page.close();

      return this.storedCookies;
    } catch (error) {
      console.error("Error retrieving cookies:", error);
      throw new Error("Failed to retrieve cookies from Airtable");
    }
  }

  /**
   * Validate if stored cookies are still valid
   */
  async validateCookies(cookies: string): Promise<boolean> {
    try {
      const response = await axios.get(
        "https://api.airtable.com/v0/meta/bases",
        {
          headers: {
            Cookie: cookies,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        }
      );

      return response.status === 200;
    } catch (error: any) {
      if (error.response?.status === 401) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get stored cookies or retrieve new ones if invalid
   */
  async getCookies(
    email?: string,
    password?: string,
    mfaCode?: string
  ): Promise<string> {
    // Check if we have valid stored cookies
    if (this.storedCookies && this.storedCookies.isValid) {
      const isValid = await this.validateCookies(this.storedCookies.cookies);

      if (isValid) {
        return this.storedCookies.cookies;
      } else {
        this.storedCookies.isValid = false;
      }
    }

    // Retrieve new cookies if none exist or invalid
    if (!email || !password) {
      throw new Error("Credentials required to retrieve new cookies");
    }

    const newCookies = await this.retrieveCookies(email, password, mfaCode);
    return newCookies.cookies;
  }
}
