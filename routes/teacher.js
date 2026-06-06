// ============================================
// routes/teacher.js — Teacher-Specific Routes
//
// GET /api/teacher/dashboard   — teacher's stats
// GET /api/teacher/students    — students who took teacher's exams
// GET /api/teacher/results     — all results for teacher's exams
// GET /api/teacher/alerts      — cheating alerts for teacher's exams
// ============================================

const express = require("express");
const router = express.Router();
const { getDB } = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("teacher", "admin"));

// ──────────────────────────────────────────────
// GET /api/teacher/dashboard — teacher summary
// ──────────────────────────────────────────────
router.get("/dashboard", (req, res) => {
  const db = getDB();
  const teacherId = req.user.id;

  const myExams = db.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE teacher_id = ?").get(teacherId).cnt;
  const activeExams = db.prepare("SELECT COUNT(*) AS cnt FROM exams WHERE teacher_id = ? AND status = 'active'").get(teacherId).cnt;
  const myQuestions = db.prepare(`
    SELECT COUNT(*) AS cnt FROM questions q
    JOIN exams e ON q.exam_id = e.id
    WHERE e.teacher_id = ?
  `).get(teacherId).cnt;

  const totalSubmissions = db.prepare(`
    SELECT COUNT(*) AS cnt FROM exam_sessions es
    JOIN exams e ON es.exam_id = e.id
    WHERE e.teacher_id = ? AND es.status = 'submitted'
  `).get(teacherId).cnt;

  const passRate = db.prepare(`
    SELECT ROUND(100.0 * SUM(CASE WHEN es.result = 'pass' THEN 1 ELSE 0 END) / COUNT(*), 1) AS rate
    FROM exam_sessions es
    JOIN exams e ON es.exam_id = e.id
    WHERE e.teacher_id = ? AND es.status = 'submitted'
  `).get(teacherId);

  const alertCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cheating_alerts ca
    JOIN exam_sessions es ON ca.session_id = es.id
    JOIN exams e ON es.exam_id = e.id
    WHERE e.teacher_id = ?
  `).get(teacherId).cnt;

  // Recent exam performance
  const examStats = db.prepare(`
    SELECT e.title, e.exam_code, e.status,
           COUNT(es.id) AS total_students,
           SUM(CASE WHEN es.result = 'pass' THEN 1 ELSE 0 END) AS passed,
           ROUND(AVG(es.percentage), 1) AS avg_pct
    FROM exams e
    LEFT JOIN exam_sessions es ON e.id = es.exam_id AND es.status = 'submitted'
    WHERE e.teacher_id = ?
    GROUP BY e.id
    ORDER BY e.created_at DESC
    LIMIT 5
  `).all(teacherId);

  return res.json({
    success: true,
    dashboard: {
      my_exams: myExams,
      active_exams: activeExams,
      my_questions: myQuestions,
      total_submissions: totalSubmissions,
      pass_rate: passRate ? passRate.rate : 0,
      alert_count: alertCount
    },
    exam_stats: examStats
  });
});

// ──────────────────────────────────────────────
// GET /api/teacher/students — students in teacher's exams
// ──────────────────────────────────────────────
router.get("/students", (req, res) => {
  const db = getDB();

  const students = db.prepare(`
    SELECT DISTINCT u.id, u.full_name, u.username, u.email,
           COUNT(es.id) AS exams_taken,
           SUM(CASE WHEN es.result = 'pass' THEN 1 ELSE 0 END) AS exams_passed,
           ROUND(AVG(es.percentage), 1) AS avg_score
    FROM users u
    JOIN exam_sessions es ON u.id = es.student_id
    JOIN exams e ON es.exam_id = e.id
    WHERE e.teacher_id = ? AND es.status = 'submitted'
    GROUP BY u.id
    ORDER BY u.full_name
  `).all(req.user.id);

  return res.json({ success: true, students, total: students.length });
});

// ──────────────────────────────────────────────
// GET /api/teacher/results — all results for teacher's exams
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
    WHERE e.teacher_id = ? AND es.status IN ('submitted', 'flagged')
  `;
  const params = [req.user.id];

  if (exam_id) { query += " AND es.exam_id = ?"; params.push(exam_id); }
  query += " ORDER BY es.submitted_at DESC";

  const results = db.prepare(query).all(...params);
  return res.json({ success: true, results, total: results.length });
});

// ──────────────────────────────────────────────
// GET /api/teacher/alerts — cheating alerts for teacher's exams
// ──────────────────────────────────────────────
router.get("/alerts", (req, res) => {
  const db = getDB();

  const alerts = db.prepare(`
    SELECT ca.*, u.full_name AS student_name, u.username,
           e.title AS exam_title, e.subject
    FROM cheating_alerts ca
    JOIN users u ON ca.student_id = u.id
    JOIN exam_sessions es ON ca.session_id = es.id
    JOIN exams e ON es.exam_id = e.id
    WHERE e.teacher_id = ?
    ORDER BY ca.timestamp DESC
    LIMIT 100
  `).all(req.user.id);

  return res.json({ success: true, alerts, total: alerts.length });
});

module.exports = router;