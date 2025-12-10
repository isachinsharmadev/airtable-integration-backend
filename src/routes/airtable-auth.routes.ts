/**
 * OAuth Authentication Routes - Airtable OAuth 2.0 with PKCE
 *
 * This module handles the complete OAuth 2.0 authorization flow with Airtable:
 * - Authorization URL generation with PKCE (Proof Key for Code Exchange)
 * - OAuth callback handling and token exchange
 * - Token refresh management
 * - Session management
 *
 * Security Features:
 * - PKCE flow prevents authorization code interception
 * - State parameter prevents CSRF attacks
 * - Secure token storage in MongoDB
 *
 * @module routes/airtable-auth.routes
 */

import { Router, Request, Response } from "express";
import axios from "axios";
import { OAuthToken } from "../models/airtable.model";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();
const router = Router();

// Extend Express session to include access token
declare module "express-session" {
  interface SessionData {
    accessToken?: string;
  }
}

// Environment configuration
const AIRTABLE_CLIENT_ID = process.env.AIRTABLE_CLIENT_ID || "";
const AIRTABLE_CLIENT_SECRET = process.env.AIRTABLE_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/api/auth/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:4200";

// In-memory store for PKCE code verifiers
// NOTE: In production, use Redis or similar distributed cache
const codeVerifierStore = new Map<string, string>();

/**
 * Generate PKCE code verifier and challenge
 *
 * PKCE (Proof Key for Code Exchange) adds security to OAuth flow by:
 * 1. Generating a random verifier
 * 2. Creating a SHA256 hash (challenge) of the verifier
 * 3. Sending challenge with authorization request
 * 4. Sending verifier with token exchange request
 *
 * This prevents authorization code interception attacks.
 *
 * @returns Object with verifier and challenge strings
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  return { verifier, challenge };
}

/**
 * GET /api/auth/authorize
 *
 * Generate OAuth authorization URL with PKCE
 *
 * This endpoint:
 * 1. Generates PKCE verifier and challenge
 * 2. Generates state parameter for CSRF protection
 * 3. Stores verifier temporarily (10 minute expiration)
 * 4. Builds authorization URL with all parameters
 * 5. Returns URL to frontend
 *
 * Frontend should redirect user to this URL to begin OAuth flow.
 *
 * Response:
 * {
 *   authUrl: "https://airtable.com/oauth2/v1/authorize?...",
 *   state: "random_state_value"
 * }
 */
router.get("/authorize", (req: Request, res: Response) => {
  try {
    console.log("[Authorize] Starting OAuth authorization flow");

    // Generate PKCE values
    const { verifier, challenge } = generatePKCE();

    // Generate state for CSRF protection
    const state = crypto.randomBytes(16).toString("base64url");

    // Store verifier temporarily (indexed by state)
    codeVerifierStore.set(state, verifier);

    console.log("[Authorize] Generated PKCE parameters");
    console.log(`[Authorize]   State: ${state}`);
    console.log(
      `[Authorize]   Code Challenge: ${challenge.substring(0, 20)}...`
    );

    // Clean up old verifiers after 10 minutes
    setTimeout(() => {
      codeVerifierStore.delete(state);
      console.log(
        `[Authorize] Cleaned up expired verifier for state: ${state}`
      );
    }, 10 * 60 * 1000);

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

    console.log("[Authorize] Authorization URL generated");
    console.log(`[Authorize]   Redirect URI: ${REDIRECT_URI}`);
    console.log(`[Authorize]   Scopes: ${scopes}`);

    res.json({
      authUrl: authUrl.toString(),
      state, // Send state to frontend for verification
    });
  } catch (error: any) {
    console.error(
      "[Authorize] Error generating authorization URL:",
      error.message
    );
    res.status(500).json({ error: "Failed to generate authorization URL" });
  }
});

/**
 * GET /api/auth/callback
 *
 * OAuth callback endpoint - handles redirect from Airtable
 *
 * This endpoint:
 * 1. Receives authorization code from Airtable
 * 2. Validates state parameter (CSRF protection)
 * 3. Retrieves PKCE verifier from store
 * 4. Exchanges code for access token
 * 5. Saves token to MongoDB
 * 6. Redirects user back to frontend
 *
 * Query Parameters:
 * - code: Authorization code from Airtable
 * - state: CSRF protection token
 * - error: Optional error from Airtable
 * - error_description: Optional error details
 */
router.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;

  console.log("[Callback] OAuth callback received");
  console.log("[Callback] Parameters:");
  console.log(`[Callback]   Code: ${code ? "present" : "missing"}`);
  console.log(`[Callback]   State: ${state ? "present" : "missing"}`);
  console.log(`[Callback]   Error: ${error || "none"}`);
  console.log(`[Callback]   Error Description: ${error_description || "none"}`);

  // Handle Airtable error
  if (error) {
    console.error(`[Callback] Airtable returned error: ${error}`);
    console.error(
      `[Callback] Error description: ${error_description || "none"}`
    );
    return res.redirect(
      `${FRONTEND_URL}/authentication?error=${error}&description=${
        error_description || "oauth_error"
      }`
    );
  }

  // Validate required parameters
  if (!code || !state) {
    console.error("[Callback] Missing required OAuth parameters");
    return res.redirect(
      `${FRONTEND_URL}/authentication?error=invalid_callback`
    );
  }

  // Retrieve code verifier
  const codeVerifier = codeVerifierStore.get(state as string);
  if (!codeVerifier) {
    console.error("[Callback] Invalid or expired state parameter");
    return res.redirect(`${FRONTEND_URL}/authentication?error=invalid_state`);
  }

  // Clean up used verifier
  codeVerifierStore.delete(state as string);
  console.log("[Callback] State validated and verifier retrieved");

  try {
    console.log("[Callback] Exchanging authorization code for access token...");

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

    console.log("[Callback] Token exchange successful");

    const { access_token, refresh_token, expires_in, scope } =
      tokenResponse.data;

    // Calculate expiration
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    console.log("[Callback] Token details:");
    console.log(`[Callback]   Expires in: ${expires_in} seconds`);
    console.log(`[Callback]   Expires at: ${expiresAt.toISOString()}`);
    console.log(`[Callback]   Scopes: ${scope || "default"}`);

    // Save to database
    console.log("[Callback] Saving token to database...");
    await OAuthToken.findOneAndUpdate(
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

    console.log("[Callback] Token saved to database");

    // Store in session
    if (req.session) {
      req.session.accessToken = access_token;
      console.log("[Callback] Token saved to session");
    }

    console.log("[Callback] Redirecting to frontend...");
    res.redirect(`${FRONTEND_URL}/authentication?success=true`);
  } catch (error: any) {
    console.error("[Callback] Token exchange failed");
    console.error(`[Callback] Error: ${error.response?.data || error.message}`);
    console.error(`[Callback] Status: ${error.response?.status || "unknown"}`);

    res.redirect(
      `${FRONTEND_URL}/authentication?error=token_exchange_failed&details=${encodeURIComponent(
        error.response?.data?.error || error.message
      )}`
    );
  }
});

/**
 * POST /api/auth/refresh
 *
 * Refresh an expired OAuth access token
 *
 * Uses the refresh token to obtain a new access token without
 * requiring the user to re-authenticate.
 *
 * Response:
 * {
 *   success: true,
 *   accessToken: "new_access_token"
 * }
 */
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    console.log("[Refresh] Starting token refresh...");

    const token = await OAuthToken.findOne().sort({ updatedAt: -1 });

    if (!token || !token.refreshToken) {
      console.error("[Refresh] No refresh token available");
      return res.status(401).json({ error: "No refresh token available" });
    }

    console.log("[Refresh] Requesting new access token from Airtable...");

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

    console.log("[Refresh] New token received");
    console.log(`[Refresh]   Expires in: ${expires_in} seconds`);
    console.log(`[Refresh]   Expires at: ${expiresAt.toISOString()}`);

    // Update database
    await OAuthToken.findByIdAndUpdate(token._id, {
      accessToken: access_token,
      refreshToken: refresh_token || token.refreshToken,
      expiresAt,
      updatedAt: new Date(),
    });

    console.log("[Refresh] Token updated in database");

    // Update session
    if (req.session) {
      req.session.accessToken = access_token;
      console.log("[Refresh] Token updated in session");
    }

    console.log("[Refresh] Token refresh successful");

    res.json({ success: true, accessToken: access_token });
  } catch (error: any) {
    console.error("[Refresh] Token refresh failed");
    console.error(`[Refresh] Error: ${error.response?.data || error.message}`);
    console.error(`[Refresh] Status: ${error.response?.status || "unknown"}`);
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

/**
 * GET /api/auth/status
 *
 * Get current authentication status
 *
 * Checks if user has a valid OAuth token and whether it's expired.
 *
 * Response:
 * {
 *   authenticated: true/false,
 *   expired: true/false,
 *   expiresAt: "2024-12-31T23:59:59.000Z",
 *   hasToken: true/false
 * }
 */
router.get("/status", async (req: Request, res: Response) => {
  try {
    const token = await OAuthToken.findOne().sort({ updatedAt: -1 });

    if (!token || !token.accessToken) {
      console.log("[Status] No authentication token found");
      return res.json({ authenticated: false });
    }

    const isExpired = new Date() > token.expiresAt;

    console.log("[Status] Authentication status checked");
    console.log(`[Status]   Authenticated: true`);
    console.log(`[Status]   Expired: ${isExpired}`);
    console.log(`[Status]   Expires at: ${token.expiresAt.toISOString()}`);

    res.json({
      authenticated: true,
      expired: isExpired,
      expiresAt: token.expiresAt,
      hasToken: true,
    });
  } catch (error: any) {
    console.error(
      "[Status] Error checking authentication status:",
      error.message
    );
    res.status(500).json({ error: "Failed to check auth status" });
  }
});

/**
 * POST /api/auth/logout
 *
 * Log out user and clear tokens
 *
 * Deletes OAuth tokens from database and destroys session.
 *
 * Response:
 * {
 *   success: true
 * }
 */
router.post("/logout", async (req: Request, res: Response) => {
  try {
    console.log("[Logout] Logging out user...");

    // Delete tokens from database
    await OAuthToken.deleteMany({});
    console.log("[Logout] Tokens deleted from database");

    // Destroy session
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          console.error("[Logout] Session destroy error:", err);
        } else {
          console.log("[Logout] Session destroyed");
        }
      });
    }

    console.log("[Logout] User logged out successfully");
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Logout] Logout failed:", error.message);
    res.status(500).json({ error: "Failed to logout" });
  }
});

export default router;
