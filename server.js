

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

/* ================= DB ================= */

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
});

/* ================= HELPERS ================= */

async function query(sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0];
}

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.send("Backend Running 🚀");
});

/* ================= USERS ================= */

app.get("/users", async (req, res) => {
  try {
    const users = await query("SELECT * FROM users");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= FIND PLACEMENT ================= */

async function findPlacement(sponsor_id) {
  let queue = [sponsor_id];

  while (queue.length > 0) {
    const current = queue.shift();
    const user = await queryOne(
      "SELECT * FROM users WHERE user_id=?",
      [current]
    );

    if (!user) break;

    if (!user.left_child || !user.right_child) {
      return user;
    }

    queue.push(user.left_child);
    queue.push(user.right_child);
  }

  return null;
}

/* ================= DIRECT INCOME ================= */

async function addDirectIncome(sponsor_id, from_user, amount) {
  if (!sponsor_id) return;

  const income = amount * 0.05;

  await query(
    "INSERT INTO direct_income (user_id, from_user, amount) VALUES (?, ?, ?)",
    [sponsor_id, from_user, income]
  );

  await query(
    "UPDATE wallet SET balance = balance + ? WHERE user_id=?",
    [income, sponsor_id]
  );
}

/* ================= UPDATE COUNTS ================= */

async function updateCounts(user_id, position) {
  while (user_id) {
    if (position === "left") {
      await query(
        "UPDATE users SET left_count = left_count + 1 WHERE user_id=?",
        [user_id]
      );
    } else {
      await query(
        "UPDATE users SET right_count = right_count + 1 WHERE user_id=?",
        [user_id]
      );
    }

    const parent = await queryOne(
      "SELECT parent_id, position FROM users WHERE user_id=?",
      [user_id]
    );

    if (!parent || !parent.parent_id) break;

    position = parent.position;
    user_id = parent.parent_id;
  }
}

/* ================= MATCHING ================= */

async function checkMatchingIncome(user_id) {
  const user = await queryOne(
    "SELECT left_count, right_count FROM users WHERE user_id=?",
    [user_id]
  );

  if (!user) return;

  const pairs = Math.min(user.left_count, user.right_count);
  if (pairs <= 0) return;

  const income = pairs * 5;

  await query(
    "INSERT INTO matching_income (user_id, pairs, amount) VALUES (?, ?, ?)",
    [user_id, pairs, income]
  );

  await query(
    "UPDATE wallet SET balance = balance + ? WHERE user_id=?",
    [income, user_id]
  );

  await query(
    "UPDATE users SET left_count = left_count - ?, right_count = right_count - ? WHERE user_id=?",
    [pairs, pairs, user_id]
  );
}

/* ================= CREATE TREE ================= */

async function createTree(user_id, sponsor_id, depth) {
  if (depth <= 0) return;

  const parent = await findPlacement(sponsor_id);
  if (!parent) return;

  for (let pos of ["left", "right"]) {
    const newId = "U" + uuidv4().slice(0, 6);

    await query(
      `INSERT INTO users (user_id, sponsor_id, parent_id, position, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [newId, sponsor_id, parent.user_id, pos]
    );

    // SAFE COLUMN HANDLING
    const column = pos === "left" ? "left_child" : "right_child";

    await query(
      `UPDATE users SET ${column}=? WHERE user_id=?`,
      [newId, parent.user_id]
    );

    await addDirectIncome(sponsor_id, newId, 50);
    await updateCounts(parent.user_id, pos);
    await checkMatchingIncome(parent.user_id);

    await createTree(newId, sponsor_id, depth - 1);
  }
}

/* ================= REGISTER ================= */

app.post("/register", async (req, res) => {
  try {
    const { name, email, sponsor_id, package_amount } = req.body;

    if (!package_amount || package_amount < 50) {
      return res.json({ error: "Minimum 50 required" });
    }

    const mainId = "U" + uuidv4().slice(0, 6);

    await query(
      "INSERT INTO users (user_id, name, email, sponsor_id, status) VALUES (?, ?, ?, ?, 'active')",
      [mainId, name, email, sponsor_id]
    );

    await query(
      "INSERT INTO wallet (user_id, balance) VALUES (?, 0)",
      [mainId]
    );

    if (package_amount > 50) {
      const levels = Math.floor(package_amount / 100);
      await createTree(mainId, sponsor_id, levels);
    }

    res.json({ success: true, user_id: mainId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= WITHDRAW ================= */

app.post("/withdraw", async (req, res) => {
  try {
    const { user_id, amount } = req.body;

    await query(
      "INSERT INTO withdrawals (user_id, amount, status) VALUES (?, ?, 'pending')",
      [user_id, amount]
    );

    await query(
      "UPDATE wallet SET balance = balance - ? WHERE user_id=?",
      [amount, user_id]
    );

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= WEEKLY BONUS ================= */

app.get("/admin/weekly-bonus", async (req, res) => {
  try {
    await query("UPDATE wallet SET balance = balance + 10");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= PAYMENT ================= */

app.post("/create-payment", async (req, res) => {
  try {
    const response = await axios.post(
      "https://api.nowpayments.io/v1/invoice",
      req.body,
      {
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        },
      }
    );

    res.json(response.data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});