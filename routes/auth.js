require("dotenv").config();
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/database");
const { authenticate } = require("../middleware/auth");

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: "Username and password are required." });
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1 ", [username.trim()]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    await pool.query("UPDATE users SET last_login = NOW() WHERE id = $1", [user.id]);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, full_name: user.full_name }, process.env.JWT_SECRET, { expiresIn: "8h" });
    return res.json({ success: true, message: "Login successful.", token, user: { id: user.id, username: user.username, full_name: user.full_name, email: user.email, role: user.role } });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

router.post("/register", async (req, res) => {
  const { username, email, password, full_name } = req.body;
  if (!username || !email || !password || !full_name)
    return res.status(400).json({ success: false, message: "All fields are required." });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  try {
    const existing = await pool.query("SELECT id FROM users WHERE username = $1 OR email = $2", [username, email]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: "Username or email already exists." });
    const hashed = bcrypt.hashSync(password, 10);
    const result = await pool.query("INSERT INTO users (username, email, password, role, full_name) VALUES ($1,$2,$3,'student',$4) RETURNING id", [username.trim(), email.trim().toLowerCase(), hashed, full_name.trim()]);
    return res.status(201).json({ success: true, message: "Registration successful!", userId: result.rows[0].id });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

router.get("/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, email, role, full_name, created_at, last_login FROM users WHERE id = $1", [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "User not found." });
    return res.json({ success: true, user: result.rows[0] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

router.post("/logout", authenticate, (req, res) => {
  return res.json({ success: true, message: "Logged out. Please delete your token." });
});

module.exports = router;