// ============================================
// routes/admin.js — Admin Routes (PostgreSQL)
// ============================================

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("admin"));

router.get("/stats", async (req, res) => {
  try {
    const totalStudents  = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE role='student' AND is_active=1");
    const totalTeachers  = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE role='teacher' AND is_active=1");
    const totalExams     = await pool.query("SELECT COUNT(*) AS cnt FROM exams");
    const activeExams    = await pool.query("SELECT COUNT(*) AS cnt FROM exams WHERE status='active'");
    const totalSessions  = await pool.query("SELECT COUNT(*) AS cnt FROM exam_sessions");
    const ongoing        = await pool.query("SELECT COUNT(*) AS cnt FROM exam_sessions WHERE status='ongoing'");
    const submitted      = await pool.query("SELECT COUNT(*) AS cnt FROM exam_sessions WHERE status='submitted'");
    const flagged        = await pool.query("SELECT COUNT(*) AS cnt FROM exam_sessions WHERE status='flagged'");
    const totalAlerts    = await pool.query("SELECT COUNT(*) AS cnt FROM cheating_alerts");
    const highAlerts     = await pool.query("SELECT COUNT(*) AS cnt FROM cheating_alerts WHERE severity='high'");
    const passRate       = await pool.query("SELECT ROUND(100.0*SUM(CASE WHEN result='pass' THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS rate FROM exam_sessions WHERE status='submitted'");

    const recentAlerts = await pool.query(`
      SELECT ca.*, u.full_name AS student_name, u.username, e.title AS exam_title
      FROM cheating_alerts ca JOIN users u ON ca.student_id=u.id
      JOIN exam_sessions es ON ca.session_id=es.id JOIN exams e ON es.exam_id=e.id
      ORDER BY ca.timestamp DESC LIMIT 10
    `);

    const activeExamList = await pool.query(`
      SELECT e.title, e.subject, e.exam_code,
             (SELECT COUNT(*) FROM exam_sessions WHERE exam_id=e.id AND status='ongoing') AS live_students,
             (SELECT COUNT(*) FROM exam_sessions WHERE exam_id=e.id AND status='submitted') AS submitted,
             u.full_name AS teacher_name
      FROM exams e JOIN users u ON e.teacher_id=u.id WHERE e.status='active'
    `);

    return res.json({
      success: true,
      stats: {
        users: { total_students: parseInt(totalStudents.rows[0].cnt), total_teachers: parseInt(totalTeachers.rows[0].cnt) },
        exams: { total: parseInt(totalExams.rows[0].cnt), active: parseInt(activeExams.rows[0].cnt) },
        sessions: { total: parseInt(totalSessions.rows[0].cnt), ongoing: parseInt(ongoing.rows[0].cnt), submitted: parseInt(submitted.rows[0].cnt), flagged: parseInt(flagged.rows[0].cnt) },
        alerts: { total: parseInt(totalAlerts.rows[0].cnt), high_severity: parseInt(highAlerts.rows[0].cnt) },
        pass_rate: passRate.rows[0].rate || 0
      },
      recent_alerts: recentAlerts.rows,
      active_exams: activeExamList.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/users", async (req, res) => {
  try {
    const { role, search } = req.query;
    let query = "SELECT id, username, email, full_name, role, is_active, created_at, last_login FROM users WHERE 1=1";
    const params = [];
    if (role) { params.push(role); query += ` AND role=$${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (full_name ILIKE $${params.length} OR username ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    return res.json({ success: true, users: result.rows, total: result.rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/users", async (req, res) => {
  const { username, email, password, full_name, role } = req.body;
  if (!username || !email || !password || !full_name || !role)
    return res.status(400).json({ success: false, message: "All fields required." });
  if (!["student","teacher","admin"].includes(role))
    return res.status(400).json({ success: false, message: "Invalid role." });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });

  try {
    const existing = await pool.query("SELECT id FROM users WHERE username=$1 OR email=$2", [username, email]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: "Username or email exists." });
    const hashed = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, email, password, role, full_name) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [username.trim(), email.trim().toLowerCase(), hashed, role, full_name.trim()]
    );
    return res.status(201).json({ success: true, message: "User created.", user_id: result.rows[0].id });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/users/:id", async (req, res) => {
  try {
    const { full_name, email, is_active, password } = req.body;
    let newPassword = null;
    if (password) {
      if (password.length < 6) return res.status(400).json({ success: false, message: "Password too short." });
      newPassword = bcrypt.hashSync(password, 10);
    }
    await pool.query(`
      UPDATE users SET
        full_name = COALESCE($1, full_name),
        email = COALESCE($2, email),
        is_active = COALESCE($3, is_active),
        password = COALESCE($4, password)
      WHERE id=$5
    `, [full_name, email, is_active, newPassword, req.params.id]);
    return res.json({ success: true, message: "User updated." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/users/:id", async (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ success: false, message: "Cannot deactivate yourself." });
  try {
    await pool.query("UPDATE users SET is_active=0 WHERE id=$1", [req.params.id]);
    return res.json({ success: true, message: "User deactivated." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const { severity } = req.query;
    let query = `
      SELECT ca.*, u.full_name AS student_name, u.username, e.title AS exam_title, e.subject
      FROM cheating_alerts ca JOIN users u ON ca.student_id=u.id
      JOIN exam_sessions es ON ca.session_id=es.id JOIN exams e ON es.exam_id=e.id
    `;
    const params = [];
    if (severity) { params.push(severity); query += ` WHERE ca.severity=$1`; }
    query += " ORDER BY ca.timestamp DESC LIMIT 100";
    const result = await pool.query(query, params);
    return res.json({ success: true, alerts: result.rows, total: result.rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/results", async (req, res) => {
  try {
    const { exam_id } = req.query;
    let query = `
      SELECT es.id AS session_id, es.score, es.total_marks, es.percentage, es.result,
             es.started_at, es.submitted_at, es.status,
             u.full_name AS student_name, u.username,
             e.title AS exam_title, e.subject, e.exam_code,
             (SELECT COUNT(*) FROM cheating_alerts WHERE session_id=es.id) AS alert_count
      FROM exam_sessions es JOIN users u ON es.student_id=u.id JOIN exams e ON es.exam_id=e.id
      WHERE es.status IN ('submitted','flagged')
    `;
    const params = [];
    if (exam_id) { params.push(exam_id); query += ` AND es.exam_id=$1`; }
    query += " ORDER BY es.submitted_at DESC";
    const result = await pool.query(query, params);
    return res.json({ success: true, results: result.rows, total: result.rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
