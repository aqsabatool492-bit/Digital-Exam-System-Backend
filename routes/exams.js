// ============================================
// routes/exams.js — Exam Management Routes
//
// GET    /api/exams              — list active exams (student)
// GET    /api/exams/:id          — get exam details
// GET    /api/exams/:id/questions — get questions (when session active)
// POST   /api/exams              — create exam (teacher/admin)
// PUT    /api/exams/:id          — update exam (teacher/admin)
// DELETE /api/exams/:id          — delete exam (admin only)
// POST   /api/exams/:id/questions — add question (teacher/admin)
// PUT    /api/exams/:id/questions/:qid — edit question
// DELETE /api/exams/:id/questions/:qid — delete question
// PATCH  /api/exams/:id/status   — activate/close exam
// ============================================

const express = require("express");
const router = express.Router();
const { getDB } = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

// ──────────────────────────────────────────────
// GET /api/exams — list exams
// Students see active exams only
// Teachers see their own exams
// Admin sees all
// ──────────────────────────────────────────────
router.get("/", authenticate, (req, res) => {
  const db = getDB();
  let exams;

  if (req.user.role === "student") {
    exams = db.prepare(`
      SELECT e.id, e.title, e.subject, e.exam_code, e.duration_min, e.total_marks, e.pass_marks,
             e.status, e.start_time, e.end_time, u.full_name AS teacher_name,
             (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
             (SELECT id FROM exam_sessions WHERE student_id = ? AND exam_id = e.id) AS my_session_id,
             (SELECT status FROM exam_sessions WHERE student_id = ? AND exam_id = e.id) AS my_session_status
      FROM exams e
      JOIN users u ON e.teacher_id = u.id
      WHERE e.status = 'active'
      ORDER BY e.created_at DESC
    `).all(req.user.id, req.user.id);

  } else if (req.user.role === "teacher") {
    exams = db.prepare(`
      SELECT e.*, u.full_name AS teacher_name,
             (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
             (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id AND status = 'submitted') AS submissions
      FROM exams e
      JOIN users u ON e.teacher_id = u.id
      WHERE e.teacher_id = ?
      ORDER BY e.created_at DESC
    `).all(req.user.id);

  } else {
    // admin
    exams = db.prepare(`
      SELECT e.*, u.full_name AS teacher_name,
             (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
             (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id) AS total_sessions,
             (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id AND status = 'submitted') AS submissions
      FROM exams e
      JOIN users u ON e.teacher_id = u.id
      ORDER BY e.created_at DESC
    `).all();
  }

  return res.json({ success: true, exams });
});

// ──────────────────────────────────────────────
// GET /api/exams/:id — single exam details
// ──────────────────────────────────────────────
router.get("/:id", authenticate, (req, res) => {
  const db = getDB();
  const exam = db.prepare(`
    SELECT e.*, u.full_name AS teacher_name,
           (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count
    FROM exams e
    JOIN users u ON e.teacher_id = u.id
    WHERE e.id = ?
  `).get(req.params.id);

  if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });

  // Students can only view active exams
  if (req.user.role === "student" && exam.status !== "active") {
    return res.status(403).json({ success: false, message: "This exam is not currently available." });
  }

  return res.json({ success: true, exam });
});

// ──────────────────────────────────────────────
// GET /api/exams/:id/questions
// Students: only if they have an active session
// Teachers/Admin: always, with correct answers shown
// ──────────────────────────────────────────────
router.get("/:id/questions", authenticate, (req, res) => {
  const db = getDB();
  const examId = req.params.id;

  if (req.user.role === "student") {
    const session = db.prepare(`
      SELECT * FROM exam_sessions WHERE student_id = ? AND exam_id = ? AND status = 'ongoing'
    `).get(req.user.id, examId);

    if (!session) {
      return res.status(403).json({ success: false, message: "You must start the exam session first." });
    }

    // Return questions WITHOUT correct answer for students
    const questions = db.prepare(`
      SELECT id, question_text, option_a, option_b, option_c, option_d, marks
      FROM questions WHERE exam_id = ?
    `).all(examId);

    return res.json({ success: true, questions, session_id: session.id });

  } else {
    // Teacher/Admin sees everything including correct answer
    const questions = db.prepare(`
      SELECT * FROM questions WHERE exam_id = ? ORDER BY id
    `).all(examId);

    return res.json({ success: true, questions });
  }
});

// ──────────────────────────────────────────────
// POST /api/exams — create exam (teacher/admin)
// Body: { title, subject, duration_min, total_marks, pass_marks, start_time?, end_time? }
// ──────────────────────────────────────────────
router.post("/", authenticate, authorize("teacher", "admin"), (req, res) => {
  const { title, subject, duration_min, total_marks, pass_marks, start_time, end_time } = req.body;

  if (!title || !subject) {
    return res.status(400).json({ success: false, message: "Title and subject are required." });
  }

  const db = getDB();

  // Generate unique exam code: first 2 letters of subject + timestamp
  const code = subject.replace(/\s+/g, "").substring(0, 4).toUpperCase() + "_" + Date.now().toString().slice(-6);

  const result = db.prepare(`
    INSERT INTO exams (title, subject, exam_code, teacher_id, duration_min, total_marks, pass_marks, status, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    title.trim(),
    subject.trim(),
    code,
    req.user.id,
    duration_min || 30,
    total_marks || 100,
    pass_marks || 40,
    start_time || null,
    end_time || null
  );

  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(result.lastInsertRowid);
  return res.status(201).json({ success: true, message: "Exam created successfully.", exam });
});

// ──────────────────────────────────────────────
// PUT /api/exams/:id — update exam
// ──────────────────────────────────────────────
router.put("/:id", authenticate, authorize("teacher", "admin"), (req, res) => {
  const db = getDB();
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.id);

  if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });

  // Teacher can only edit their own exams
  if (req.user.role === "teacher" && exam.teacher_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "You can only edit your own exams." });
  }

  const { title, subject, duration_min, total_marks, pass_marks, start_time, end_time } = req.body;

  db.prepare(`
    UPDATE exams SET
      title = COALESCE(?, title),
      subject = COALESCE(?, subject),
      duration_min = COALESCE(?, duration_min),
      total_marks = COALESCE(?, total_marks),
      pass_marks = COALESCE(?, pass_marks),
      start_time = COALESCE(?, start_time),
      end_time = COALESCE(?, end_time)
    WHERE id = ?
  `).run(title, subject, duration_min, total_marks, pass_marks, start_time, end_time, req.params.id);

  return res.json({ success: true, message: "Exam updated.", exam: db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.id) });
});

// ──────────────────────────────────────────────
// PATCH /api/exams/:id/status — activate or close
// Body: { status: 'active' | 'closed' | 'draft' }
// ──────────────────────────────────────────────
router.patch("/:id/status", authenticate, authorize("teacher", "admin"), (req, res) => {
  const { status } = req.body;
  const validStatuses = ["draft", "active", "closed"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: "Status must be: draft, active, or closed." });
  }

  const db = getDB();
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });

  if (req.user.role === "teacher" && exam.teacher_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "Access denied." });
  }

  // Can't activate exam with no questions
  if (status === "active") {
    const qCount = db.prepare("SELECT COUNT(*) AS cnt FROM questions WHERE exam_id = ?").get(req.params.id);
    if (qCount.cnt === 0) {
      return res.status(400).json({ success: false, message: "Cannot activate exam with no questions." });
    }
  }

  db.prepare("UPDATE exams SET status = ? WHERE id = ?").run(status, req.params.id);
  return res.json({ success: true, message: `Exam status set to '${status}'.` });
});

// ──────────────────────────────────────────────
// DELETE /api/exams/:id — admin only
// ──────────────────────────────────────────────
router.delete("/:id", authenticate, authorize("admin"), (req, res) => {
  const db = getDB();
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });

  db.prepare("DELETE FROM exams WHERE id = ?").run(req.params.id);
  return res.json({ success: true, message: "Exam deleted." });
});

// ──────────────────────────────────────────────
// POST /api/exams/:id/questions — add question
// Body: { question_text, option_a, option_b, option_c, option_d, correct_ans (0-3), marks }
// ──────────────────────────────────────────────
router.post("/:id/questions", authenticate, authorize("teacher", "admin"), (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_ans, marks } = req.body;

  if (!question_text || !option_a || !option_b || !option_c || !option_d || correct_ans === undefined) {
    return res.status(400).json({ success: false, message: "All question fields are required." });
  }

  if (![0, 1, 2, 3].includes(Number(correct_ans))) {
    return res.status(400).json({ success: false, message: "correct_ans must be 0, 1, 2, or 3 (index of correct option)." });
  }

  const db = getDB();
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });

  if (req.user.role === "teacher" && exam.teacher_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "You can only add questions to your own exams." });
  }

  const result = db.prepare(`
    INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_ans, marks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, question_text.trim(), option_a.trim(), option_b.trim(), option_c.trim(), option_d.trim(), Number(correct_ans), marks || 1);

  // Auto-update total_marks based on question marks sum
  db.prepare(`
    UPDATE exams SET total_marks = (SELECT COALESCE(SUM(marks), 0) FROM questions WHERE exam_id = ?)
    WHERE id = ?
  `).run(req.params.id, req.params.id);

  return res.status(201).json({ success: true, message: "Question added.", question_id: result.lastInsertRowid });
});

// ──────────────────────────────────────────────
// PUT /api/exams/:id/questions/:qid — edit question
// ──────────────────────────────────────────────
router.put("/:id/questions/:qid", authenticate, authorize("teacher", "admin"), (req, res) => {
  const db = getDB();
  const q = db.prepare("SELECT * FROM questions WHERE id = ? AND exam_id = ?").get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ success: false, message: "Question not found." });

  const { question_text, option_a, option_b, option_c, option_d, correct_ans, marks } = req.body;

  db.prepare(`
    UPDATE questions SET
      question_text = COALESCE(?, question_text),
      option_a = COALESCE(?, option_a),
      option_b = COALESCE(?, option_b),
      option_c = COALESCE(?, option_c),
      option_d = COALESCE(?, option_d),
      correct_ans = COALESCE(?, correct_ans),
      marks = COALESCE(?, marks)
    WHERE id = ?
  `).run(question_text, option_a, option_b, option_c, option_d,
    correct_ans !== undefined ? Number(correct_ans) : null,
    marks, req.params.qid);

  return res.json({ success: true, message: "Question updated." });
});

// ──────────────────────────────────────────────
// DELETE /api/exams/:id/questions/:qid
// ──────────────────────────────────────────────
router.delete("/:id/questions/:qid", authenticate, authorize("teacher", "admin"), (req, res) => {
  const db = getDB();
  const q = db.prepare("SELECT * FROM questions WHERE id = ? AND exam_id = ?").get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ success: false, message: "Question not found." });

  db.prepare("DELETE FROM questions WHERE id = ?").run(req.params.qid);
  return res.json({ success: true, message: "Question deleted." });
});

module.exports = router;