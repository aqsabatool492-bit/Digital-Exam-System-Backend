// ============================================
// routes/teacher.js — Teacher Routes (PostgreSQL)
// ============================================

const express = require("express");
const router = express.Router();
const pool = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

router.use(authenticate, authorize("teacher", "admin"));

router.get("/dashboard", async (req, res) => {
  try {
    const id = req.user.id;
    const myExams      = await pool.query("SELECT COUNT(*) AS cnt FROM exams WHERE teacher_id=$1", [id]);
    const activeExams  = await pool.query("SELECT COUNT(*) AS cnt FROM exams WHERE teacher_id=$1 AND status='active'", [id]);
    const submissions  = await pool.query(`SELECT COUNT(*) AS cnt FROM exam_sessions es JOIN exams e ON es.exam_id=e.id WHERE e.teacher_id=$1 AND es.status='submitted'`, [id]);
    const alertCount   = await pool.query(`SELECT COUNT(*) AS cnt FROM cheating_alerts ca JOIN exam_sessions es ON ca.session_id=es.id JOIN exams e ON es.exam_id=e.id WHERE e.teacher_id=$1`, [id]);
    const passRate     = await pool.query(`SELECT ROUND(100.0*SUM(CASE WHEN es.result='pass' THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS rate FROM exam_sessions es JOIN exams e ON es.exam_id=e.id WHERE e.teacher_id=$1 AND es.status='submitted'`, [id]);

    return res.json({
      success: true,
      dashboard: {
        my_exams: parseInt(myExams.rows[0].cnt),
        active_exams: parseInt(activeExams.rows[0].cnt),
        total_submissions: parseInt(submissions.rows[0].cnt),
        alert_count: parseInt(alertCount.rows[0].cnt),
        pass_rate: passRate.rows[0].rate || 0
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/students", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.full_name, u.username, u.email,
             COUNT(es.id) AS exams_taken,
             SUM(CASE WHEN es.result='pass' THEN 1 ELSE 0 END) AS exams_passed,
             ROUND(AVG(es.percentage),1) AS avg_score
      FROM users u JOIN exam_sessions es ON u.id=es.student_id JOIN exams e ON es.exam_id=e.id
      WHERE e.teacher_id=$1 AND es.status='submitted'
      GROUP BY u.id ORDER BY u.full_name
    `, [req.user.id]);
    return res.json({ success: true, students: result.rows, total: result.rows.length });
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
      WHERE e.teacher_id=$1 AND es.status IN ('submitted','flagged')
    `;
    const params = [req.user.id];
    if (exam_id) { query += " AND es.exam_id=$2"; params.push(exam_id); }
    query += " ORDER BY es.submitted_at DESC";
    const result = await pool.query(query, params);
    return res.json({ success: true, results: result.rows, total: result.rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ca.*, u.full_name AS student_name, u.username, e.title AS exam_title, e.subject
      FROM cheating_alerts ca JOIN users u ON ca.student_id=u.id
      JOIN exam_sessions es ON ca.session_id=es.id JOIN exams e ON es.exam_id=e.id
      WHERE e.teacher_id=$1 ORDER BY ca.timestamp DESC LIMIT 100
    `, [req.user.id]);
    return res.json({ success: true, alerts: result.rows, total: result.rows.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
