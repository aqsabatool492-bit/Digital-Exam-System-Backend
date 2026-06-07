// ============================================
// server.js — Main Server (PostgreSQL Version)
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
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { success: false, message: "Too many attempts. Try again in 15 minutes." } });

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "🎓 Digital Exam Control & Monitoring System API",
    version: "2.0.0",
    database: "PostgreSQL ✅",
    status: "running",
    timestamp: new Date().toISOString(),
    endpoints: { auth: "/api/auth", exams: "/api/exams", sessions: "/api/sessions", teacher: "/api/teacher", admin: "/api/admin" }
  });
});

app.use("/api/auth",     loginLimiter, authRoutes);
app.use("/api/exams",    examRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/teacher",  teacherRoutes);
app.use("/api/admin",    adminRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` }));
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.message);
  res.status(500).json({ success: false, message: "Internal server error.", error: process.env.NODE_ENV === "development" ? err.message : undefined });
});

app.listen(PORT, () => {
  console.log("\n══════════════════════════════════════════════");
  console.log("  🎓 Digital Exam System — PostgreSQL Backend");
  console.log("══════════════════════════════════════════════");
  console.log(`  ✅ Server running on: http://localhost:${PORT}`);
  console.log(`  🗄️  Database: PostgreSQL (Railway)`);
  console.log("══════════════════════════════════════════════\n");
});

module.exports = app;
