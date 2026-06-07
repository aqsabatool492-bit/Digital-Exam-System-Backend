// ============================================
// routes/sessions.js — Exam Sessions (PostgreSQL)
// ============================================

const express = require("express");
const router = express.Router();
const pool = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

// POST /api/sessions/start
router.post("/start", authenticate, authorize("student"), async (req, res) => {
  const { exam_id } = req.body;
  if (!exam_id) return res.status(400).json({ success: false, message: "exam_id is required." });

  try {
    const examResult = await pool.query("SELECT * FROM exams WHERE id=$1 AND status='active'", [exam_id]);
    const exam = examResult.rows[0];
    if (!exam) return res.status(404).json({ success: false, message: "Exam not found or not active." });

    const existing = await pool.query(
      "SELECT * FROM exam_sessions WHERE student_id=$1 AND exam_id=$2", [req.user.id, exam_id]
    );

    if (existing.rows[0]) {
      if (existing.rows[0].status === "ongoing") {
        const questions = await pool.query(
          "SELECT id, question_text, option_a, option_b, option_c, option_d, marks FROM questions WHERE exam_id=$1",
          [exam_id]
        );
        const savedAnswers = await pool.query(
          "SELECT question_id, selected_ans FROM answers WHERE session_id=$1", [existing.rows[0].id]
        );
        return res.json({ success: true, message: "Resuming session.", session: existing.rows[0], exam, questions: questions.rows, saved_answers: savedAnswers.rows });
      }
      return res.status(409).json({ success: false, message: `You have already ${existing.rows[0].status} this exam.` });
    }

    const sessionResult = await pool.query(
      "INSERT INTO exam_sessions (student_id, exam_id, status) VALUES ($1,$2,'ongoing') RETURNING *",
      [req.user.id, exam_id]
    );
    const questions = await pool.query(
      "SELECT id, question_text, option_a, option_b, option_c, option_d, marks FROM questions WHERE exam_id=$1 ORDER BY id",
      [exam_id]
    );

    return res.status(201).json({ success: true, message: "Exam started.", session: sessionResult.rows[0], exam, questions: questions.rows, saved_answers: [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/sessions/:id/submit
router.post("/:id/submit", authenticate, authorize("student"), async (req, res) => {
  const { answers } = req.body;
  const sessionId = req.params.id;

  try {
    const sessionResult = await pool.query(
      "SELECT * FROM exam_sessions WHERE id=$1 AND student_id=$2 AND status='ongoing'",
      [sessionId, req.user.id]
    );
    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ success: false, message: "Session not found or already submitted." });

    const questions = await pool.query("SELECT * FROM questions WHERE exam_id=$1", [session.exam_id]);
    const questionMap = {};
    questions.rows.forEach(q => { questionMap[q.id] = q; });

    let score = 0;
    const totalMarks = questions.rows.reduce((sum, q) => sum + q.marks, 0);

    // Delete old answers
    await pool.query("DELETE FROM answers WHERE session_id=$1", [sessionId]);

    // Insert and grade answers
    for (const q of questions.rows) {
      const ans = answers && answers.find(a => a.question_id === q.id);
      const selectedAns = ans ? ans.selected_ans : null;
      const isCorrect = selectedAns !== null && selectedAns !== undefined && Number(selectedAns) === q.correct_ans ? 1 : 0;
      if (isCorrect) score += q.marks;

      await pool.query(
        "INSERT INTO answers (session_id, question_id, selected_ans, is_correct) VALUES ($1,$2,$3,$4)",
        [sessionId, q.id, selectedAns, isCorrect]
      );
    }

    const examResult = await pool.query("SELECT * FROM exams WHERE id=$1", [session.exam_id]);
    const exam = examResult.rows[0];
    const percentage = totalMarks > 0 ? ((score / totalMarks) * 100).toFixed(2) : 0;
    const result = score >= (exam.pass_marks || 40) ? "pass" : "fail";

    await pool.query(`
      UPDATE exam_sessions SET status='submitted', submitted_at=NOW(), score=$1, total_marks=$2, percentage=$3, result=$4
      WHERE id=$5
    `, [score, totalMarks, percentage, result, sessionId]);

    return res.json({
      success: true, message: "Exam submitted!",
      result: { session_id: Number(sessionId), score, total_marks: totalMarks, percentage, result }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/sessions/my
router.get("/my", authenticate, authorize("student"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT es.*, e.title, e.subject, e.exam_code, e.duration_min, u.full_name AS teacher_name
      FROM exam_sessions es
      JOIN exams e ON es.exam_id = e.id
      JOIN users u ON e.teacher_id = u.id
      WHERE es.student_id = $1 ORDER BY es.started_at DESC
    `, [req.user.id]);
    return res.json({ success: true, sessions: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/sessions/:id/result
router.get("/:id/result", authenticate, async (req, res) => {
  try {
    const sessionResult = await pool.query(`
      SELECT es.*, e.title, e.subject, e.exam_code, u.full_name AS student_name
      FROM exam_sessions es
      JOIN exams e ON es.exam_id = e.id
      JOIN users u ON es.student_id = u.id
      WHERE es.id = $1
    `, [req.params.id]);

    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ success: false, message: "Session not found." });
    if (req.user.role === "student" && session.student_id !== req.user.id)
      return res.status(403).json({ success: false, message: "Access denied." });
    if (session.status !== "submitted")
      return res.status(400).json({ success: false, message: "Exam not yet submitted." });

    const answerDetails = await pool.query(`
      SELECT a.question_id, a.selected_ans, a.is_correct,
             q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
             q.correct_ans AS correct_option, q.marks
      FROM answers a JOIN questions q ON a.question_id = q.id
      WHERE a.session_id = $1 ORDER BY q.id
    `, [req.params.id]);

    const alerts = await pool.query(
      "SELECT * FROM cheating_alerts WHERE session_id=$1 ORDER BY timestamp DESC", [req.params.id]
    );

    return res.json({ success: true, session, answer_breakdown: answerDetails.rows, cheating_alerts: alerts.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/sessions/exam/:examId
router.get("/exam/:examId", authenticate, authorize("teacher", "admin"), async (req, res) => {
  try {
    const exam = await pool.query("SELECT * FROM exams WHERE id=$1", [req.params.examId]);
    if (!exam.rows[0]) return res.status(404).json({ success: false, message: "Exam not found." });
    if (req.user.role === "teacher" && exam.rows[0].teacher_id !== req.user.id)
      return res.status(403).json({ success: false, message: "Access denied." });

    const sessions = await pool.query(`
      SELECT es.*, u.full_name AS student_name, u.username,
             (SELECT COUNT(*) FROM cheating_alerts WHERE session_id = es.id) AS alert_count
      FROM exam_sessions es JOIN users u ON es.student_id = u.id
      WHERE es.exam_id = $1 ORDER BY es.started_at DESC
    `, [req.params.examId]);

    const rows = sessions.rows;
    const stats = {
      total: rows.length,
      ongoing: rows.filter(s => s.status === "ongoing").length,
      submitted: rows.filter(s => s.status === "submitted").length,
      flagged: rows.filter(s => s.status === "flagged").length,
      pass_count: rows.filter(s => s.result === "pass").length,
      fail_count: rows.filter(s => s.result === "fail").length,
    };

    return res.json({ success: true, exam: exam.rows[0], sessions: rows, stats });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/sessions/:id/alert
router.post("/:id/alert", authenticate, authorize("student"), async (req, res) => {
  const { alert_type, description, severity } = req.body;
  if (!alert_type) return res.status(400).json({ success: false, message: "alert_type is required." });

  try {
    const session = await pool.query(
      "SELECT * FROM exam_sessions WHERE id=$1 AND student_id=$2", [req.params.id, req.user.id]
    );
    if (!session.rows[0]) return res.status(404).json({ success: false, message: "Session not found." });

    await pool.query(
      "INSERT INTO cheating_alerts (session_id, student_id, alert_type, description, severity) VALUES ($1,$2,$3,$4,$5)",
      [req.params.id, req.user.id, alert_type, description||null, severity||"low"]
    );

    const alertCount = await pool.query(
      "SELECT COUNT(*) AS cnt FROM cheating_alerts WHERE session_id=$1 AND severity IN ('high','medium')",
      [req.params.id]
    );

    if (parseInt(alertCount.rows[0].cnt) >= 5) {
      await pool.query("UPDATE exam_sessions SET status='flagged' WHERE id=$1", [req.params.id]);
    }

    return res.json({ success: true, message: "Alert logged.", total_alerts: parseInt(alertCount.rows[0].cnt) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
