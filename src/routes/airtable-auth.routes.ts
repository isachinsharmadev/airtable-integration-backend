import { Router, Request, Response } from "express";
import axios from "axios";
import { OAuthToken } from "../models/airtable.model";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();
const router = Router();
declare module "express-session" {
  interface SessionData {
    accessToken?: string;
  }
}
const AIRTABLE_CLIENT_ID = process.env.AIRTABLE_CLIENT_ID || "";
const AIRTABLE_CLIENT_SECRET = process.env.AIRTABLE_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/api/auth/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:4200";

// Store for PKCE code verifiers (in production, use Redis)
const codeVerifierStore = new Map<string, string>();

// Generate PKCE code verifier and challenge
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  return { verifier, challenge };
}

// OAuth authorization URL with PKCE
router.get("/authorize", (req: Request, res: Response) => {
  try {
    // Generate PKCE values
    const { verifier, challenge } = generatePKCE();

    // Generate state for CSRF protection
    const state = crypto.randomBytes(16).toString("base64url");

    // Store verifier temporarily (indexed by state)
    codeVerifierStore.set(state, verifier);

    // Clean up old verifiers after 10 minutes
    setTimeout(() => codeVerifierStore.delete(state), 10 * 60 * 1000);

    // Build authorization URL using official Airtable OAuth format
    const authUrl = new URL("https://airtable.com/oauth2/v1/authorize");
    authUrl.searchParams.set("client_id", AIRTABLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    // Scopes - space separated as per OAuth 2.0 spec
    const scopes = [
      "data.records:read",
      "data.recordComments:read",
      "schema.bases:read",
    ].join(" ");
    authUrl.searchParams.set("scope", scopes);

    console.log("✓ Generated authorization URL");
    console.log("  State:", state);
    console.log("  Code Challenge:", challenge.substring(0, 20) + "...");
    console.log("  Redirect URI:", REDIRECT_URI);

    res.json({
      authUrl: authUrl.toString(),
      state, // Send state to frontend for verification
    });
  } catch (error: any) {
    console.error("Error generating auth URL:", error);
    res.status(500).json({ error: "Failed to generate authorization URL" });
  }
});

// OAuth callback - handles redirect from Airtable
router.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;

  console.log("\n========== OAuth Callback ==========");
  console.log("Received parameters:");
  console.log("  - code:", code ? "✓ present" : "✗ missing");
  console.log("  - state:", state ? "✓ present" : "✗ missing");
  console.log("  - error:", error || "none");
  console.log("  - error_description:", error_description || "none");
  console.log("====================================\n");

  // Handle Airtable error
  if (error) {
    console.error("❌ Airtable returned error:", error, error_description);
    return res.redirect(
      `${FRONTEND_URL}/authentication?error=${error}&description=${
        error_description || "oauth_error"
      }`
    );
  }

  // Validate required parameters
  if (!code || !state) {
    console.error("❌ Missing required OAuth parameters");
    return res.redirect(
      `${FRONTEND_URL}/authentication?error=invalid_callback`
    );
  }

  // Retrieve code verifier
  const codeVerifier = codeVerifierStore.get(state as string);
  if (!codeVerifier) {
    console.error("❌ Invalid or expired state parameter");
    return res.redirect(`${FRONTEND_URL}/authentication?error=invalid_state`);
  }

  // Clean up used verifier
  codeVerifierStore.delete(state as string);

  try {
    console.log("🔄 Exchanging authorization code for access token...");

    // Exchange code for token with PKCE
    const tokenResponse = await axios.post(
      "https://airtable.com/oauth2/v1/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: REDIRECT_URI,
        client_id: AIRTABLE_CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(AIRTABLE_CLIENT_SECRET && {
            Authorization: `Basic ${Buffer.from(
              `${AIRTABLE_CLIENT_ID}:${AIRTABLE_CLIENT_SECRET}`
            ).toString("base64")}`,
          }),
        },
      }
    );

    console.log("✅ Token exchange successful!");

    const { access_token, refresh_token, expires_in, scope } =
      tokenResponse.data;

    // Calculate expiration
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    console.log("💾 Saving token to database...");
    console.log("  - Expires in:", expires_in, "seconds");
    console.log("  - Expires at:", expiresAt.toISOString());

    // Save to database
    const savedToken = await OAuthToken.findOneAndUpdate(
      {},
      {
        accessToken: access_token,
        refreshToken: refresh_token || "",
        expiresAt,
        scope:
          scope ||
          "data.records:read data.recordComments:read schema.bases:read",
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log("✅ Token saved to database");

    // Store in session
    if (req.session) {
      req.session.accessToken = access_token;
      console.log("✅ Token saved to session");
    }

    console.log("🔄 Redirecting to frontend...");
    res.redirect(`${FRONTEND_URL}/authentication?success=true`);
  } catch (error: any) {
    console.error("❌ Token exchange failed:");
    console.error("  Error:", error.response?.data || error.message);
    console.error("  Status:", error.response?.status);

    res.redirect(
      `${FRONTEND_URL}/authentication?error=token_exchange_failed&details=${encodeURIComponent(
        error.response?.data?.error || error.message
      )}`
    );
  }
});

// Refresh token
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const token = await OAuthToken.findOne().sort({ updatedAt: -1 });

    if (!token || !token.refreshToken) {
      return res.status(401).json({ error: "No refresh token available" });
    }

    console.log("🔄 Refreshing access token...");

    const tokenResponse = await axios.post(
      "https://airtable.com/oauth2/v1/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: AIRTABLE_CLIENT_ID,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(AIRTABLE_CLIENT_SECRET && {
            Authorization: `Basic ${Buffer.from(
              `${AIRTABLE_CLIENT_ID}:${AIRTABLE_CLIENT_SECRET}`
            ).toString("base64")}`,
          }),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await OAuthToken.findByIdAndUpdate(token._id, {
      accessToken: access_token,
      refreshToken: refresh_token || token.refreshToken,
      expiresAt,
      updatedAt: new Date(),
    });

    if (req.session) {
      req.session.accessToken = access_token;
    }

    console.log("✅ Token refreshed successfully");

    res.json({ success: true, accessToken: access_token });
  } catch (error: any) {
    console.error(
      "❌ Token refresh failed:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

// Get current token status
router.get("/status", async (req: Request, res: Response) => {
  try {
    const token = await OAuthToken.findOne().sort({ updatedAt: -1 });

    if (!token || !token.accessToken) {
      return res.json({ authenticated: false });
    }

    const isExpired = new Date() > token.expiresAt;

    res.json({
      authenticated: true,
      expired: isExpired,
      expiresAt: token.expiresAt,
      hasToken: true,
    });
  } catch (error: any) {
    console.error("Error checking auth status:", error.message);
    res.status(500).json({ error: "Failed to check auth status" });
  }
});

// Logout
router.post("/logout", async (req: Request, res: Response) => {
  try {
    await OAuthToken.deleteMany({});
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
        }
      });
    }
    console.log("✅ User logged out");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to logout" });
  }
});

// Debug endpoint
router.get("/debug-config", (req: Request, res: Response) => {
  res.json({
    message: "OAuth Configuration",
    clientIdSet: !!AIRTABLE_CLIENT_ID,
    clientIdLength: AIRTABLE_CLIENT_ID.length,
    clientIdPrefix: AIRTABLE_CLIENT_ID.substring(0, 8) + "...",
    clientSecretSet: !!AIRTABLE_CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    frontendUrl: FRONTEND_URL,
    usingPKCE: true,
    note: "Using PKCE (Proof Key for Code Exchange) for enhanced security",
  });
});

// DEV ONLY: Set Personal Access Token
router.post("/set-personal-token", async (req: Request, res: Response) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    await OAuthToken.findOneAndUpdate(
      {},
      {
        accessToken: token,
        refreshToken: "",
        expiresAt,
        scope: "personal_access_token",
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log("✅ Personal access token saved");

    res.json({
      success: true,
      message: "Personal access token saved successfully",
      expiresAt,
    });
  } catch (error: any) {
    console.error("Error saving token:", error);
    res.status(500).json({ error: "Failed to save token" });
  }
});

export default router;
