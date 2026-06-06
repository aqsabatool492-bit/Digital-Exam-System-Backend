// ============================================
// routes/admin.js — Admin-Only Routes
//
// GET  /api/admin/stats            — live dashboard stats
// GET  /api/admin/users            — all users
// POST /api/admin/users            — create teacher/admin
// PUT  /api/admin/users/:id        — edit user
// DELETE /api/admin/users/:id      — deactivate user
// GET  /api/admin/alerts           — all cheating alerts
// GET  /api/admin/results          — all exam results
// ============================================

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { getDB } = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

// All admin routes require authentication + admin role
router.use(authenticate, authorize("admin"));

// ──────────────────────────────────────────────
// GET /api/admin/stats — live dashboard statistics
// ──────────────────────────────────────────────
router.get("/stats", (req, res) => {
  const db = getDB();

  const totalStudents = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'student' AND is_active = 1").get().cnt;
  const totalTeachers = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'teacher' AND is_active = 1").get().cnt;
  const totalExams = db.prepare("SELECT COUNT(*) AS cnt FROM exams").get().cnt;
  const activeExams = db.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE status = 'active'").get().cnt;
  const totalSessions = db.prepare("SELECT COUNT(*) AS cnt FROM exam_sessions").get().cnt;
  const ongoingSessions = db.prepare("SELECT COUNT(*) AS cnt FROM exam_sessions WHERE status = 'ongoing'").get().cnt;
  const submittedSessions = db.prepare("SELECT COUNT(*) AS cnt FROM exam_sessions WHERE status = 'submitted'").get().cnt;
  const flaggedSessions = db.prepare("SELECT COUNT(*) AS cnt FROM exam_sessions WHERE status = 'flagged'").get().cnt;
  const totalAlerts = db.prepare("SELECT COUNT(*) AS cnt FROM cheating_alerts").get().cnt;
  const highAlerts = db.prepare("SELECT COUNT(*) AS cnt FROM cheating_alerts WHERE severity = 'high'").get().cnt;
  const totalQuestions = db.prepare("SELECT COUNT(*) AS cnt FROM questions").get().cnt;

  // Pass rate
  const passRate = db.prepare(`
    SELECT
      ROUND(100.0 * SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 1) AS rate
    FROM exam_sessions WHERE status = 'submitted'
  `).get();

  // Recent alerts (last 10)
  const recentAlerts = db.prepare(`
    SELECT ca.*, u.full_name AS student_name, u.username,
           e.title AS exam_title
    FROM cheating_alerts ca
    JOIN users u ON ca.student_id = u.id
    JOIN exam_sessions es ON ca.session_id = es.id
    JOIN exams e ON es.exam_id = e.id
    ORDER BY ca.timestamp DESC LIMIT 10
  `).all();

  // Active exam list
  const activeExamList = db.prepare(`
    SELECT e.title, e.subject, e.exam_code,
           (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id AND status = 'ongoing') AS live_students,
           (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id AND status = 'submitted') AS submitted,
           u.full_name AS teacher_name
    FROM exams e
    JOIN users u ON e.teacher_id = u.id
    WHERE e.status = 'active'
  `).all();

  return res.json({
    success: true,
    stats: {
      users: { total_students: totalStudents, total_teachers: totalTeachers },
      exams: { total: totalExams, active: activeExams },
      sessions: { total: totalSessions, ongoing: ongoingSessions, submitted: submittedSessions, flagged: flaggedSessions },
      alerts: { total: totalAlerts, high_severity: highAlerts },
      questions: { total: totalQuestions },
      pass_rate: passRate ? passRate.rate : 0
    },
    recent_alerts: recentAlerts,
    active_exams: activeExamList
  });
});

// ──────────────────────────────────────────────
// GET /api/admin/users — all users with filters
// Query: ?role=student|teacher|admin&search=name
// ──────────────────────────────────────────────
router.get("/users", (req, res) => {
  const db = getDB();
  const { role, search } = req.query;

  let query = `
    SELECT id, username, email, full_name, role, is_active, created_at, last_login
    FROM users WHERE 1=1
  `;
  const params = [];

  if (role) { query += " AND role = ?"; params.push(role); }
  if (search) {
    query += " AND (full_name LIKE ? OR username LIKE ? OR email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += " ORDER BY created_at DESC";
  const users = db.prepare(query).all(...params);

  return res.json({ success: true, users, total: users.length });
});

// ──────────────────────────────────────────────
// POST /api/admin/users — create teacher or admin
// Body: { username, email, password, full_name, role }
// ──────────────────────────────────────────────
router.post("/users", (req, res) => {
  const { username, email, password, full_name, role } = req.body;

  if (!username || !email || !password || !full_name || !role) {
    return res.status(400).json({ success: false, message: "All fields required." });
  }

  if (!["student", "teacher", "admin"].includes(role)) {
    return res.status(400).json({ success: false, message: "Role must be student, teacher, or admin." });
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }

  const db = getDB();
  const existing = db.prepare("SELECT id FROM users WHERE username = ? OR email = ?").get(username, email);
  if (existing) {
    return res.status(409).json({ success: false, message: "Username or email already exists." });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (username, email, password, role, full_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(username.trim(), email.trim().toLowerCase(), hashed, role, full_name.trim());

  return res.status(201).json({
    success: true,
    message: `${role.charAt(0).toUpperCase() + role.slice(1)} account created.`,
    user_id: result.lastInsertRowid
  });
});

// ──────────────────────────────────────────────
// PUT /api/admin/users/:id — edit user
// Body: { full_name?, email?, is_active?, password? }
// ──────────────────────────────────────────────
router.put("/users/:id", (req, res) => {
  const db = getDB();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: "User not found." });

  const { full_name, email, is_active, password } = req.body;

  let newPassword = user.password;
  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }
    newPassword = bcrypt.hashSync(password, 10);
  }

  db.prepare(`
    UPDATE users SET
      full_name = COALESCE(?, full_name),
      email = COALESCE(?, email),
      is_active = COALESCE(?, is_active),
      password = ?
    WHERE id = ?
  `).run(full_name, email, is_active, newPassword, req.params.id);

  return res.json({ success: true, message: "User updated." });
});

// ──────────────────────────────────────────────
// DELETE /api/admin/users/:id — deactivate (soft delete)
// ──────────────────────────────────────────────
router.delete("/users/:id", (req, res) => {
  const db = getDB();

  // Cannot deactivate yourself
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ success: false, message: "You cannot deactivate your own account." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: "User not found." });

  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(req.params.id);
  return res.json({ success: true, message: `User '${user.username}' deactivated.` });
});

// ──────────────────────────────────────────────
// GET /api/admin/alerts — all cheating alerts
// Query: ?severity=high|medium|low
// ──────────────────────────────────────────────
router.get("/alerts", (req, res) => {
  const db = getDB();
  const { severity } = req.query;

  let query = `
    SELECT ca.*, u.full_name AS student_name, u.username,
           e.title AS exam_title, e.subject
    FROM cheating_alerts ca
    JOIN users u ON ca.student_id = u.id
    JOIN exam_sessions es ON ca.session_id = es.id
    JOIN exams e ON es.exam_id = e.id
  `;
  const params = [];

  if (severity) { query += " WHERE ca.severity = ?"; params.push(severity); }
  query += " ORDER BY ca.timestamp DESC LIMIT 100";

  const alerts = db.prepare(query).all(...params);

  return res.json({ success: true, alerts, total: alerts.length });
});

// ──────────────────────────────────────────────
// GET /api/admin/results — all submitted exam results
// Query: ?exam_id=X
// ──────────────────────────────────────────────
router.get("/results", (req, res) => {
  const db = getDB();
  const { exam_id } = req.query;

  let query = `
    SELECT es.id AS session_id, es.score, es.total_marks, es.percentage, es.result,
           es.started_at, es.submitted_at, es.status,
           u.full_name AS student_name, u.username,
           e.title AS exam_title, e.subject, e.exam_code,
           (SELECT COUNT(*) FROM cheating_alerts WHERE session_id = es.id) AS alert_count
    FROM exam_sessions es
    JOIN users u ON es.student_id = u.id
    JOIN exams e ON es.exam_id = e.id
    WHERE es.status IN ('submitted', 'flagged')
  `;
  const params = [];

  if (exam_id) { query += " AND es.exam_id = ?"; params.push(exam_id); }
  query += " ORDER BY es.submitted_at DESC";

  const results = db.prepare(query).all(...params);

  return res.json({ success: true, results, total: results.length });
});

module.exports = router;