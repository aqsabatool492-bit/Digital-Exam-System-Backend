// ============================================
// routes/exams.js — Exam Management (PostgreSQL)
// ============================================

const express = require("express");
const router = express.Router();
const pool = require("../db/database");
const { authenticate, authorize } = require("../middleware/auth");

// GET /api/exams
router.get("/", authenticate, async (req, res) => {
  try {
    let result;
    if (req.user.role === "student") {
      result = await pool.query(`
        SELECT e.id, e.title, e.subject, e.exam_code, e.duration_min, e.total_marks, e.pass_marks,
               e.status, e.start_time, e.end_time, u.full_name AS teacher_name,
               (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
               (SELECT id FROM exam_sessions WHERE student_id = $1 AND exam_id = e.id) AS my_session_id,
               (SELECT status FROM exam_sessions WHERE student_id = $1 AND exam_id = e.id) AS my_session_status
        FROM exams e JOIN users u ON e.teacher_id = u.id
        WHERE e.status = 'active' ORDER BY e.created_at DESC
      `, [req.user.id]);
    } else if (req.user.role === "teacher") {
      result = await pool.query(`
        SELECT e.*, u.full_name AS teacher_name,
               (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
               (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id AND status = 'submitted') AS submissions
        FROM exams e JOIN users u ON e.teacher_id = u.id
        WHERE e.teacher_id = $1 ORDER BY e.created_at DESC
      `, [req.user.id]);
    } else {
      result = await pool.query(`
        SELECT e.*, u.full_name AS teacher_name,
               (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
               (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id) AS total_sessions,
               (SELECT COUNT(*) FROM exam_sessions WHERE exam_id = e.id AND status = 'submitted') AS submissions
        FROM exams e JOIN users u ON e.teacher_id = u.id ORDER BY e.created_at DESC
      `);
    }
    return res.json({ success: true, exams: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/exams/:id
router.get("/:id", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, u.full_name AS teacher_name,
             (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count
      FROM exams e JOIN users u ON e.teacher_id = u.id WHERE e.id = $1
    `, [req.params.id]);
    const exam = result.rows[0];
    if (!exam) return res.status(404).json({ success: false, message: "Exam not found." });
    if (req.user.role === "student" && exam.status !== "active")
      return res.status(403).json({ success: false, message: "Exam not available." });
    return res.json({ success: true, exam });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/exams/:id/questions
router.get("/:id/questions", authenticate, async (req, res) => {
  try {
    if (req.user.role === "student") {
      const session = await pool.query(
        "SELECT * FROM exam_sessions WHERE student_id=$1 AND exam_id=$2 AND status='ongoing'",
        [req.user.id, req.params.id]
      );
      if (!session.rows[0])
        return res.status(403).json({ success: false, message: "Start the exam session first." });

      const qs = await pool.query(
        "SELECT id, question_text, option_a, option_b, option_c, option_d, marks FROM questions WHERE exam_id=$1",
        [req.params.id]
      );
      return res.json({ success: true, questions: qs.rows, session_id: session.rows[0].id });
    } else {
      const qs = await pool.query("SELECT * FROM questions WHERE exam_id=$1 ORDER BY id", [req.params.id]);
      return res.json({ success: true, questions: qs.rows });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/exams
router.post("/", authenticate, authorize("teacher", "admin"), async (req, res) => {
  const { title, subject, duration_min, total_marks, pass_marks, start_time, end_time } = req.body;
  if (!title || !subject)
    return res.status(400).json({ success: false, message: "Title and subject are required." });

  try {
    const code = subject.replace(/\s+/g,"").substring(0,4).toUpperCase() + "_" + Date.now().toString().slice(-6);
    const result = await pool.query(`
      INSERT INTO exams (title, subject, exam_code, teacher_id, duration_min, total_marks, pass_marks, status, start_time, end_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9) RETURNING *
    `, [title.trim(), subject.trim(), code, req.user.id, duration_min||30, total_marks||100, pass_marks||40, start_time||null, end_time||null]);

    return res.status(201).json({ success: true, message: "Exam created.", exam: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/exams/:id
router.put("/:id", authenticate, authorize("teacher", "admin"), async (req, res) => {
  try {
    const exam = await pool.query("SELECT * FROM exams WHERE id=$1", [req.params.id]);
    if (!exam.rows[0]) return res.status(404).json({ success: false, message: "Exam not found." });
    if (req.user.role === "teacher" && exam.rows[0].teacher_id !== req.user.id)
      return res.status(403).json({ success: false, message: "Access denied." });

    const { title, subject, duration_min, total_marks, pass_marks } = req.body;
    await pool.query(`
      UPDATE exams SET
        title = COALESCE($1, title), subject = COALESCE($2, subject),
        duration_min = COALESCE($3, duration_min), total_marks = COALESCE($4, total_marks),
        pass_marks = COALESCE($5, pass_marks)
      WHERE id = $6
    `, [title, subject, duration_min, total_marks, pass_marks, req.params.id]);

    const updated = await pool.query("SELECT * FROM exams WHERE id=$1", [req.params.id]);
    return res.json({ success: true, message: "Exam updated.", exam: updated.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/exams/:id/status
router.patch("/:id/status", authenticate, authorize("teacher", "admin"), async (req, res) => {
  const { status } = req.body;
  if (!["draft","active","closed"].includes(status))
    return res.status(400).json({ success: false, message: "Status must be draft, active, or closed." });

  try {
    const exam = await pool.query("SELECT * FROM exams WHERE id=$1", [req.params.id]);
    if (!exam.rows[0]) return res.status(404).json({ success: false, message: "Exam not found." });
    if (req.user.role === "teacher" && exam.rows[0].teacher_id !== req.user.id)
      return res.status(403).json({ success: false, message: "Access denied." });

    if (status === "active") {
      const qCount = await pool.query("SELECT COUNT(*) AS cnt FROM questions WHERE exam_id=$1", [req.params.id]);
      if (parseInt(qCount.rows[0].cnt) === 0)
        return res.status(400).json({ success: false, message: "Cannot activate exam with no questions." });
    }

    await pool.query("UPDATE exams SET status=$1 WHERE id=$2", [status, req.params.id]);
    return res.json({ success: true, message: `Exam status set to '${status}'.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/exams/:id
router.delete("/:id", authenticate, authorize("admin"), async (req, res) => {
  try {
    await pool.query("DELETE FROM exams WHERE id=$1", [req.params.id]);
    return res.json({ success: true, message: "Exam deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/exams/:id/questions
router.post("/:id/questions", authenticate, authorize("teacher", "admin"), async (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_ans, marks } = req.body;
  if (!question_text || !option_a || !option_b || !option_c || !option_d || correct_ans === undefined)
    return res.status(400).json({ success: false, message: "All question fields are required." });
  if (![0,1,2,3].includes(Number(correct_ans)))
    return res.status(400).json({ success: false, message: "correct_ans must be 0, 1, 2, or 3." });

  try {
    const result = await pool.query(`
      INSERT INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_ans, marks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [req.params.id, question_text.trim(), option_a.trim(), option_b.trim(), option_c.trim(), option_d.trim(), Number(correct_ans), marks||1]);

    // Update total marks
    await pool.query(
      "UPDATE exams SET total_marks = (SELECT COALESCE(SUM(marks),0) FROM questions WHERE exam_id=$1) WHERE id=$1",
      [req.params.id]
    );

    return res.status(201).json({ success: true, message: "Question added.", question_id: result.rows[0].id });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/exams/:id/questions/:qid
router.put("/:id/questions/:qid", authenticate, authorize("teacher","admin"), async (req, res) => {
  try {
    const { question_text, option_a, option_b, option_c, option_d, correct_ans, marks } = req.body;
    await pool.query(`
      UPDATE questions SET
        question_text = COALESCE($1, question_text), option_a = COALESCE($2, option_a),
        option_b = COALESCE($3, option_b), option_c = COALESCE($4, option_c),
        option_d = COALESCE($5, option_d), correct_ans = COALESCE($6, correct_ans),
        marks = COALESCE($7, marks)
      WHERE id=$8 AND exam_id=$9
    `, [question_text, option_a, option_b, option_c, option_d,
        correct_ans !== undefined ? Number(correct_ans) : null,
        marks, req.params.qid, req.params.id]);
    return res.json({ success: true, message: "Question updated." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/exams/:id/questions/:qid
router.delete("/:id/questions/:qid", authenticate, authorize("teacher","admin"), async (req, res) => {
  try {
    await pool.query("DELETE FROM questions WHERE id=$1 AND exam_id=$2", [req.params.qid, req.params.id]);
    return res.json({ success: true, message: "Question deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
