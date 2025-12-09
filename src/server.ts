import express, { Express, Request, Response } from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import MongoStore from "connect-mongo";

// Route imports
import airtableAuthRoutes from "./routes/airtable-auth.routes";
import airtableDataRoutes from "./routes/airtable-data.routes";
import scrapingRoutes from "./routes/scraping.routes";

dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:4200",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl:
        process.env.MONGODB_URI ||
        "mongodb://localhost:27017/airtable-integration",
    }),
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

// MongoDB Connection
mongoose
  .connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/airtable-integration"
  )
  .then(() => console.log("✓ MongoDB connected successfully"))
  .catch((err) => console.error("✗ MongoDB connection error:", err));

// Routes - IMPORTANT: These must come after middleware
app.use("/api/auth", airtableAuthRoutes);
app.use("/api/data", airtableDataRoutes);
app.use("/api/scraping", scrapingRoutes);

// Health check
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    routes: {
      auth: "/api/auth",
      data: "/api/data",
      scraping: "/api/scraping",
    },
  });
});

// Test route to verify server is running
app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "Airtable Integration API",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      auth: "/api/auth/*",
      data: "/api/data/*",
      scraping: "/api/scraping/*",
    },
  });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

// 404 handler - must be last
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    availableRoutes: [
      "/health",
      "/api/auth/authorize",
      "/api/auth/callback",
      "/api/auth/status",
      "/api/auth/debug-config",
      "/api/data/*",
      "/api/scraping/*",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Health check: http://localhost:${PORT}/health`);
  console.log(`✓ Auth routes: http://localhost:${PORT}/api/auth/*`);
});

export default app;
