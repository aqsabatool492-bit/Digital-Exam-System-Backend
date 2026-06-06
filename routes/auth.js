// ============================================
// routes/auth.js — Authentication Routes
// POST /api/auth/login
// POST /api/auth/register
// GET  /api/auth/me
// POST /api/auth/logout  (client-side, just confirms)
// ============================================

require("dotenv").config();
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getDB } = require("../db/database");
const { authenticate } = require("../middleware/auth");

// ──────────────────────────────────────────────
// POST /api/auth/login
// Body: { username, password }
// Works for student, teacher, admin
// ──────────────────────────────────────────────
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required." });
  }

  const db = getDB();
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND is_active = 1").get(username.trim());

  if (!user) {
    return res.status(401).json({ success: false, message: "Invalid credentials." });
  }

  const passwordMatch = bcrypt.compareSync(password, user.password);
  if (!passwordMatch) {
    return res.status(401).json({ success: false, message: "Invalid credentials." });
  }

  // Update last login
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  // Create JWT token
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );

  return res.json({
    success: true,
    message: "Login successful.",
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    }
  });
});

// ──────────────────────────────────────────────
// POST /api/auth/register
// Body: { username, email, password, full_name, role }
// Only admin can register teachers. Students can self-register.
// ──────────────────────────────────────────────
router.post("/register", (req, res) => {
  const { username, email, password, full_name, role } = req.body;

  if (!username || !email || !password || !full_name) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  // Only allow student self-registration; teacher/admin must be created via admin panel
  const allowedRole = role === "student" ? "student" : null;
  if (!allowedRole) {
    return res.status(403).json({
      success: false,
      message: "Only student self-registration is allowed. Contact admin to create teacher accounts."
    });
  }

  // Validate password strength
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }

  const db = getDB();

  // Check duplicates
  const existing = db.prepare("SELECT id FROM users WHERE username = ? OR email = ?").get(username, email);
  if (existing) {
    return res.status(409).json({ success: false, message: "Username or email already exists." });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  const result = db.prepare(`
    INSERT INTO users (username, email, password, role, full_name)
    VALUES (?, ?, ?, 'student', ?)
  `).run(username.trim(), email.trim().toLowerCase(), hashedPassword, full_name.trim());

  return res.status(201).json({
    success: true,
    message: "Registration successful! You can now log in.",
    userId: result.lastInsertRowid
  });
});

// ──────────────────────────────────────────────
// GET /api/auth/me — get current user info
// ──────────────────────────────────────────────
router.get("/me", authenticate, (req, res) => {
  const db = getDB();
  const user = db.prepare("SELECT id, username, email, role, full_name, created_at, last_login FROM users WHERE id = ?").get(req.user.id);

  if (!user) return res.status(404).json({ success: false, message: "User not found." });

  return res.json({ success: true, user });
});

// ──────────────────────────────────────────────
// POST /api/auth/logout — token is stateless (JWT)
// Client should delete token. We just confirm.
// ──────────────────────────────────────────────
router.post("/logout", authenticate, (req, res) => {
  return res.json({ success: true, message: "Logged out successfully. Please delete your token." });
});

module.exports = router;
