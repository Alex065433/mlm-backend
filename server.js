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

const db = mysql.createPool(process.env.MYSQL_URL);

async function query(sql, params = []) {
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0];
}

/* ================= OPERATOR ID ================= */

async function generateUniqueOperatorId() {
  let id, exists = true;
  while (exists) {
    id = "ARW-" + Math.floor(100000 + Math.random() * 900000);
    const check = await queryOne(
      "SELECT operator_id FROM users WHERE operator_id = ?",
      [id]
    );
    if (!check) exists = false;
  }
  return id;
}

/* ================= WALLET ================= */

async function addIncome(user_id, amount, type, description) {
  await query(
    "INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)",
    [user_id, amount, type, description]
  );

  await query(
    "UPDATE wallet SET balance = balance + ? WHERE user_id = ?",
    [amount, user_id]
  );
}

/* ================= REGISTER ================= */

app.post("/register", async (req, res) => {
  try {
    const { name, email, password, sponsor_id, package_amount } = req.body;

    const user_id = "U" + uuidv4().slice(0, 6);
    const operator_id = await generateUniqueOperatorId();

    await query(
      `INSERT INTO users 
      (user_id, operator_id, name, email, password, sponsor_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user_id, operator_id, name, email, password, sponsor_id, "active"]
    );

    await query("INSERT INTO wallet (user_id, balance) VALUES (?, 0)", [user_id]);

    /* ===== DIRECT REFERRAL INCOME ===== */
    if (sponsor_id) {
      await addIncome(sponsor_id, 10, "direct", "Direct Referral Bonus");
    }

    /* ===== BINARY TREE ===== */
    await placeInBinary(user_id, sponsor_id);

    res.json({ success: true, user_id, operator_id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= BINARY LOGIC ================= */

async function placeInBinary(user_id, sponsor_id) {
  if (!sponsor_id) return;

  const sponsor = await queryOne(
    "SELECT * FROM users WHERE user_id = ?",
    [sponsor_id]
  );

  if (!sponsor) return;

  if (!sponsor.left_child) {
    await query(
      "UPDATE users SET left_child = ? WHERE user_id = ?",
      [user_id, sponsor_id]
    );
    await updateCounts(sponsor_id, "left");
  } else if (!sponsor.right_child) {
    await query(
      "UPDATE users SET right_child = ? WHERE user_id = ?",
      [user_id, sponsor_id]
    );
    await updateCounts(sponsor_id, "right");
  } else {
    await placeInBinary(user_id, sponsor.left_child); // recursion
  }
}

/* ================= MATCHING ================= */

async function updateCounts(user_id, side) {
  let current = await queryOne(
    "SELECT * FROM users WHERE user_id = ?",
    [user_id]
  );

  while (current) {
    if (side === "left") {
      await query(
        "UPDATE users SET left_count = left_count + 1 WHERE user_id = ?",
        [current.user_id]
      );
    } else {
      await query(
        "UPDATE users SET right_count = right_count + 1 WHERE user_id = ?",
        [current.user_id]
      );
    }

    const updated = await queryOne(
      "SELECT left_count, right_count FROM users WHERE user_id = ?",
      [current.user_id]
    );

    const pairs = Math.min(updated.left_count, updated.right_count);

    if (pairs > 0) {
      await addIncome(current.user_id, pairs * 5, "matching", "Binary Matching");
    }

    current = await queryOne(
      "SELECT * FROM users WHERE user_id = ?",
      [current.parent_id]
    );
  }
}

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {
  const { operator_id, password } = req.body;

  const user = await queryOne(
    "SELECT * FROM users WHERE operator_id = ?",
    [operator_id]
  );

  if (!user || user.password !== password) {
    return res.json({ error: "Invalid credentials" });
  }

  res.json({ success: true, user });
});

/* ================= USERS ================= */

app.get("/users", async (req, res) => {
  const users = await query("SELECT * FROM users");
  res.json(users);
});

/* ================= WALLET ================= */

app.get("/wallet/:id", async (req, res) => {
  const wallet = await queryOne(
    "SELECT * FROM wallet WHERE user_id = ?",
    [req.params.id]
  );
  res.json(wallet);
});

/* ================= WITHDRAW ================= */

app.post("/withdraw", async (req, res) => {
  const { user_id, amount } = req.body;

  const wallet = await queryOne(
    "SELECT balance FROM wallet WHERE user_id = ?",
    [user_id]
  );

  if (wallet.balance < amount) {
    return res.json({ error: "Insufficient balance" });
  }

  await query(
    "UPDATE wallet SET balance = balance - ? WHERE user_id = ?",
    [amount, user_id]
  );

  await query(
    "INSERT INTO withdrawals (user_id, amount, status) VALUES (?, ?, 'pending')",
    [user_id, amount]
  );

  res.json({ success: true });
});

/* ================= PAYMENT (NOWPAYMENTS) ================= */

app.post("/create-payment", async (req, res) => {
  try {
    const response = await axios.post(
      "https://api.nowpayments.io/v1/invoice",
      {
        price_amount: req.body.amount,
        price_currency: "usd",
        pay_currency: "usdtbsc"
      },
      {
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/* ================= ADMIN PANEL ================= */

// Dashboard Stats
app.get("/admin/stats", async (req, res) => {
  try {
    const totalUsers = await queryOne("SELECT COUNT(*) as count FROM users");
    const activeUsers = await queryOne("SELECT COUNT(*) as count FROM users WHERE status='active'");
    const totalDeposit = await queryOne("SELECT SUM(amount) as total FROM transactions WHERE type='deposit'");
    const totalWithdraw = await queryOne("SELECT SUM(amount) as total FROM transactions WHERE type='withdraw'");

    res.json({
      totalUsers: totalUsers.count,
      activeUsers: activeUsers.count,
      totalDeposit: totalDeposit.total || 0,
      totalWithdraw: totalWithdraw.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get All Users
app.get("/admin/users", async (req, res) => {
  try {
    const users = await query(`
      SELECT u.user_id, u.operator_id, u.name, u.email, u.status, w.balance
      FROM users u
      LEFT JOIN wallet w ON u.user_id = w.user_id
    `);

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update User
app.put("/admin/user/:id", async (req, res) => {
  try {
    const { balance, status } = req.body;

    await query("UPDATE wallet SET balance=? WHERE user_id=?", [balance, req.params.id]);
    await query("UPDATE users SET status=? WHERE user_id=?", [status, req.params.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transactions
app.get("/admin/transactions", async (req, res) => {
  try {
    const data = await query("SELECT * FROM transactions ORDER BY created_at DESC");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Withdraw Action
app.post("/admin/withdraw/action", async (req, res) => {
  try {
    const { id, action } = req.body;

    const withdraw = await queryOne("SELECT * FROM withdrawals WHERE id=?", [id]);

    if (!withdraw) return res.json({ error: "Invalid request" });

    if (action === "approve") {
      await query("UPDATE withdrawals SET status='approved' WHERE id=?", [id]);
      await query("UPDATE wallet SET balance = balance - ? WHERE user_id=?", [withdraw.amount, withdraw.user_id]);
    } else {
      await query("UPDATE withdrawals SET status='rejected' WHERE id=?", [id]);
    }

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/* ================= ADMIN ================= */

app.get("/admin/users", async (req, res) => {
  const users = await query("SELECT * FROM users");
  res.json(users);
});

app.get("/admin/withdrawals", async (req, res) => {
  const data = await query("SELECT * FROM withdrawals");
  res.json(data);
});

app.post("/admin/approve-withdraw", async (req, res) => {
  const { id } = req.body;

  await query(
    "UPDATE withdrawals SET status = 'approved' WHERE id = ?",
    [id]
  );

  res.json({ success: true });
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});