// ============================================
// routes/sessions.js — Exam Session Routes
//
// POST /api/sessions/start          — student starts an exam
// POST /api/sessions/:id/submit     — student submits answers
// GET  /api/sessions/my             — student's exam history
// GET  /api/sessions/:id/result     — get result of a session
// GET  /api/sessions/exam/:examId   — teacher/admin sees all sessions for an exam
// POST /api/sessions/:id/alert      — log a cheating alert
// ============================================

const express = require("express");
const router = express.Router();
const { getDB } = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

// ──────────────────────────────────────────────
// POST /api/sessions/start
// Body: { exam_id }
// Student starts an exam session
// ──────────────────────────────────────────────
router.post("/start", authenticate, authorize("student"), (req, res) => {
  const { exam_id } = req.body;

  if (!exam_id) {
    return res.status(400).json({ success: false, message: "exam_id is required." });
  }

  const db = getDB();

  // Check exam exists and is active
  const exam = db.prepare("SELECT * FROM exams WHERE id = ? AND status = 'active'").get(exam_id);
  if (!exam) {
    return res.status(404).json({ success: false, message: "Exam not found or not currently active." });
  }

  // Check if already taken/ongoing
  const existing = db.prepare("SELECT * FROM exam_sessions WHERE student_id = ? AND exam_id = ?").get(req.user.id, exam_id);

  if (existing) {
    if (existing.status === "ongoing") {
      // Resume session — return existing session with questions
      const questions = db.prepare(`
        SELECT id, question_text, option_a, option_b, option_c, option_d, marks
        FROM questions WHERE exam_id = ?
      `).all(exam_id);

      // Fetch already-saved answers for this session
      const savedAnswers = db.prepare(`
        SELECT question_id, selected_ans FROM answers WHERE session_id = ?
      `).all(existing.id);

      return res.json({
        success: true,
        message: "Resuming your existing session.",
        session: existing,
        exam,
        questions,
        saved_answers: savedAnswers
      });
    } else {
      return res.status(409).json({
        success: false,
        message: `You have already ${existing.status} this exam. Cannot restart.`
      });
    }
  }

  // Create new session
  const result = db.prepare(`
    INSERT INTO exam_sessions (student_id, exam_id, status)
    VALUES (?, ?, 'ongoing')
  `).run(req.user.id, exam_id);

  const questions = db.prepare(`
    SELECT id, question_text, option_a, option_b, option_c, option_d, marks
    FROM questions WHERE exam_id = ? ORDER BY id
  `).all(exam_id);

  const session = db.prepare("SELECT * FROM exam_sessions WHERE id = ?").get(result.lastInsertRowid);

  return res.status(201).json({
    success: true,
    message: "Exam session started.",
    session,
    exam,
    questions,
    saved_answers: []
  });
});

// ──────────────────────────────────────────────
// POST /api/sessions/:id/submit
// Body: { answers: [ { question_id, selected_ans } ] }
// Auto-grades and saves result
// ──────────────────────────────────────────────
router.post("/:id/submit", authenticate, authorize("student"), (req, res) => {
  const { answers } = req.body;
  const sessionId = req.params.id;

  const db = getDB();

  // Verify session belongs to this student and is ongoing
  const session = db.prepare(`
    SELECT * FROM exam_sessions WHERE id = ? AND student_id = ? AND status = 'ongoing'
  `).get(sessionId, req.user.id);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found, not yours, or already submitted."
    });
  }

  // Fetch correct answers for this exam
  const questions = db.prepare("SELECT * FROM questions WHERE exam_id = ?").all(session.exam_id);
  const questionMap = {};
  questions.forEach(q => { questionMap[q.id] = q; });

  // Grade answers
  let score = 0;
  const totalMarks = questions.reduce((sum, q) => sum + q.marks, 0);

  const submitAll = db.transaction(() => {
    // Delete any previously auto-saved answers
    db.prepare("DELETE FROM answers WHERE session_id = ?").run(sessionId);

    // Insert and grade each answer
    const insertAns = db.prepare(`
      INSERT INTO answers (session_id, question_id, selected_ans, is_correct)
      VALUES (?, ?, ?, ?)
    `);

    if (answers && Array.isArray(answers)) {
      answers.forEach(ans => {
        const q = questionMap[ans.question_id];
        if (!q) return;

        const isCorrect = (ans.selected_ans !== null && ans.selected_ans !== undefined)
          ? (Number(ans.selected_ans) === q.correct_ans ? 1 : 0)
          : 0;

        if (isCorrect) score += q.marks;

        insertAns.run(sessionId, ans.question_id, ans.selected_ans ?? null, isCorrect);
      });
    }

    // For unanswered questions, record them as null
    questions.forEach(q => {
      const answered = answers && answers.find(a => a.question_id === q.id);
      if (!answered) {
        insertAns.run(sessionId, q.id, null, 0);
      }
    });

    const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(session.exam_id);
    const percentage = totalMarks > 0 ? ((score / totalMarks) * 100).toFixed(2) : 0;
    const result = score >= (exam.pass_marks || 40) ? "pass" : "fail";

    // Update session
    db.prepare(`
      UPDATE exam_sessions SET
        status = 'submitted',
        submitted_at = datetime('now'),
        score = ?,
        total_marks = ?,
        percentage = ?,
        result = ?
      WHERE id = ?
    `).run(score, totalMarks, percentage, result, sessionId);

    return { score, totalMarks, percentage, result };
  });

  const gradeResult = submitAll();
  const updatedSession = db.prepare("SELECT * FROM exam_sessions WHERE id = ?").get(sessionId);

  return res.json({
    success: true,
    message: "Exam submitted and graded!",
    result: {
      session_id: Number(sessionId),
      score: gradeResult.score,
      total_marks: gradeResult.totalMarks,
      percentage: gradeResult.percentage,
      result: gradeResult.result
    },
    session: updatedSession
  });
});

// ──────────────────────────────────────────────
// GET /api/sessions/my — student's exam history
// ──────────────────────────────────────────────
router.get("/my", authenticate, authorize("student"), (req, res) => {
  const db = getDB();
  const sessions = db.prepare(`
    SELECT es.*, e.title, e.subject, e.exam_code, e.duration_min, u.full_name AS teacher_name
    FROM exam_sessions es
    JOIN exams e ON es.exam_id = e.id
    JOIN users u ON e.teacher_id = u.id
    WHERE es.student_id = ?
    ORDER BY es.started_at DESC
  `).all(req.user.id);

  return res.json({ success: true, sessions });
});

// ──────────────────────────────────────────────
// GET /api/sessions/:id/result
// Student sees their own result; teacher/admin sees any
// ──────────────────────────────────────────────
router.get("/:id/result", authenticate, (req, res) => {
  const db = getDB();

  const session = db.prepare(`
    SELECT es.*, e.title, e.subject, e.exam_code, u.full_name AS student_name,
           s.full_name AS teacher_name_via_exam
    FROM exam_sessions es
    JOIN exams e ON es.exam_id = e.id
    JOIN users u ON es.student_id = u.id
    JOIN users s ON e.teacher_id = s.id
    WHERE es.id = ?
  `).get(req.params.id);

  if (!session) return res.status(404).json({ success: false, message: "Session not found." });

  // Student can only see their own
  if (req.user.role === "student" && session.student_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "Access denied." });
  }

  if (session.status !== "submitted") {
    return res.status(400).json({ success: false, message: "Exam not yet submitted." });
  }

  // Fetch answer breakdown
  const answerDetails = db.prepare(`
    SELECT a.question_id, a.selected_ans, a.is_correct,
           q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_ans AS correct_option, q.marks
    FROM answers a
    JOIN questions q ON a.question_id = q.id
    WHERE a.session_id = ?
    ORDER BY q.id
  `).all(req.params.id);

  // Cheating alerts for this session
  const alerts = db.prepare(`
    SELECT * FROM cheating_alerts WHERE session_id = ? ORDER BY timestamp DESC
  `).all(req.params.id);

  return res.json({
    success: true,
    session,
    answer_breakdown: answerDetails,
    cheating_alerts: alerts
  });
});

// ──────────────────────────────────────────────
// GET /api/sessions/exam/:examId
// Teacher/Admin: all sessions for an exam
// ──────────────────────────────────────────────
router.get("/exam/:examId", authenticate, authorize("teacher", "admin"), (req, res) => {
  const db = getDB();
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.examId);
  if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });

  // Teacher sees only their exam
  if (req.user.role === "teacher" && exam.teacher_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "Access denied." });
  }

  const sessions = db.prepare(`
    SELECT es.*, u.full_name AS student_name, u.username,
           (SELECT COUNT(*) FROM cheating_alerts WHERE session_id = es.id) AS alert_count
    FROM exam_sessions es
    JOIN users u ON es.student_id = u.id
    WHERE es.exam_id = ?
    ORDER BY es.started_at DESC
  `).all(req.params.examId);

  const stats = {
    total: sessions.length,
    ongoing: sessions.filter(s => s.status === "ongoing").length,
    submitted: sessions.filter(s => s.status === "submitted").length,
    flagged: sessions.filter(s => s.status === "flagged").length,
    avg_score: sessions.filter(s => s.score !== null).length > 0
      ? (sessions.reduce((sum, s) => sum + (s.score || 0), 0) / sessions.filter(s => s.score !== null).length).toFixed(1)
      : 0,
    pass_count: sessions.filter(s => s.result === "pass").length,
    fail_count: sessions.filter(s => s.result === "fail").length,
  };

  return res.json({ success: true, exam, sessions, stats });
});

// ──────────────────────────────────────────────
// POST /api/sessions/:id/alert — log cheating alert
// Body: { alert_type, description, severity }
// Called by frontend when detecting suspicious activity
// ──────────────────────────────────────────────
router.post("/:id/alert", authenticate, authorize("student"), (req, res) => {
  const { alert_type, description, severity } = req.body;

  if (!alert_type) {
    return res.status(400).json({ success: false, message: "alert_type is required." });
  }

  const db = getDB();

  const session = db.prepare(`
    SELECT * FROM exam_sessions WHERE id = ? AND student_id = ?
  `).get(req.params.id, req.user.id);

  if (!session) return res.status(404).json({ success: false, message: "Session not found." });

  db.prepare(`
    INSERT INTO cheating_alerts (session_id, student_id, alert_type, description, severity)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, req.user.id, alert_type, description || null, severity || "low");

  // Count total alerts and flag session if too many high/medium alerts
  const alertCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cheating_alerts
    WHERE session_id = ? AND severity IN ('high','medium')
  `).get(req.params.id);

  if (alertCount.cnt >= 5) {
    db.prepare("UPDATE exam_sessions SET status = 'flagged' WHERE id = ?").run(req.params.id);
  }

  return res.json({ success: true, message: "Alert logged.", total_alerts: alertCount.cnt });
});

module.exports = router;