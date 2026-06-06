// ============================================
// server.js — Main Entry Point
// Digital Exam Control & Monitoring System
// ============================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const authRoutes    = require("./routes/auth");
const examRoutes    = require("./routes/exams");
const sessionRoutes = require("./routes/sessions");
const adminRoutes   = require("./routes/admin");
const teacherRoutes = require("./routes/teacher");

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────

// CORS — allow frontend to connect
// In production, replace '*' with your actual frontend URL
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter — prevents brute force attacks
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 login attempts per IP per 15 min
  message: { success: false, message: "Too many login attempts. Try again in 15 minutes." }
});

// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "🎓 Digital Exam Control & Monitoring System API",
    version: "1.0.0",
    status: "running",
    timestamp: new Date().toISOString(),
    endpoints: {
      auth:    "/api/auth",
      exams:   "/api/exams",
      sessions:"/api/sessions",
      teacher: "/api/teacher",
      admin:   "/api/admin"
    }
  });
});

app.use("/api/auth",     loginLimiter, authRoutes);
app.use("/api/exams",    examRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/teacher",  teacherRoutes);
app.use("/api/admin",    adminRoutes);

// ──────────────────────────────────────────────
// 404 HANDLER
// ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` });
});

// ──────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.message);
  res.status(500).json({
    success: false,
    message: "Internal server error.",
    error: process.env.NODE_ENV === "development" ? err.message : undefined
  });
});

// ──────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("\n══════════════════════════════════════════════");
  console.log("  🎓 Digital Exam System — Backend Server");
  console.log("══════════════════════════════════════════════");
  console.log(`  ✅ Server running on: http://localhost:${PORT}`);
  console.log(`  📡 API Base URL:      http://localhost:${PORT}/api`);
  console.log("══════════════════════════════════════════════\n");
});

module.exports = app;
