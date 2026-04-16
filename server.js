const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

/* ================= DB ================= */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0];
}

/* ================= ADMIN MIDDLEWARE ================= */
function adminAuth(req, res, next) {
  const key = req.headers["admin_key"];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.send("Backend Running 🚀");
});

/* ================= REFERRAL LINK ================= */

// Example: https://yourapp.com/register?ref=U12345
app.get("/ref/:user_id", async (req, res) => {
  const { user_id } = req.params;

  const user = await queryOne("SELECT user_id FROM users WHERE user_id=?", [user_id]);
  if (!user) return res.json({ error: "Invalid referral" });

  res.json({
    referral_link: ${req.protocol}://${req.get("host")}/register?ref=${user_id}
  });
});

/* ================= REGISTER ================= */

app.post("/register", async (req, res) => {
  const { name, email, sponsor_id } = req.body;

  const user_id = "U" + uuidv4().slice(0, 6);

  await query(`
    INSERT INTO users (user_id,name,email,sponsor_id,status)
    VALUES (?,?,?,?, 'inactive')
  `, [user_id, name, email, sponsor_id]);

  await query(INSERT INTO wallet (user_id,balance) VALUES (?,0), [user_id]);

  res.json({
    success: true,
    user_id,
    message: "Registered. Complete payment to activate."
  });
});

/* ================= CREATE PAYMENT ================= */

app.post("/create-payment", async (req, res) => {
  const { user_id, amount } = req.body;

  try {
    const response = await axios.post(
      "https://api.nowpayments.io/v1/payment",
      {
        price_amount: amount,
        price_currency: "usd",
        pay_currency: "usdttrc20"
      },
      {
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY
        }
      }
    );

    const p = response.data;

    await query(`
      INSERT INTO payments (user_id,amount,payment_id,status)
      VALUES (?,?,?, 'pending')
    `, [user_id, amount, p.payment_id]);

    res.json(p);

  } catch (err) {
    res.json({ error: err.message });
  }
});

/* ================= WEBHOOK ================= */

app.post("/nowpayments-webhook", async (req, res) => {
  const signature = req.headers["x-nowpayments-sig"];

  const hash = crypto
    .createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== signature) return res.sendStatus(403);

  const { payment_id, payment_status } = req.body;

  if (payment_status === "finished") {

    const payment = await queryOne(
      "SELECT * FROM payments WHERE payment_id=?",
      [payment_id]
    );

    if (!payment) return res.sendStatus(404);

    await activateUser(payment.user_id, payment.amount);

    await query(
      "UPDATE payments SET status='approved' WHERE payment_id=?",
      [payment_id]
    );
  }

  res.sendStatus(200);
});

/* ================= ACTIVATE USER (MLM ENTRY POINT) ================= */

async function activateUser(user_id, amount) {

  const totalIds = Math.floor(amount / 50);

  for (let i = 0; i < totalIds; i++) {
    const id = "U" + uuidv4().slice(0, 6);

    await query(`
      INSERT INTO users (user_id,parent_id,status)
      VALUES (?, ?, 'active')
    `, [id, user_id]);
  }

  await query(UPDATE users SET status='active' WHERE user_id=?, [user_id]);
}

/* ================= WALLET ================= */

app.get("/wallet/:user_id", async (req, res) => {
  const data = await queryOne(
    "SELECT balance FROM wallet WHERE user_id=?",
    [req.params.user_id]
  );
  res.json(data);
});

/* ================= WITHDRAW ================= */

app.post("/withdraw", async (req, res) => {
  const { user_id, amount } = req.body;

  const wallet = await queryOne(
    "SELECT balance FROM wallet WHERE user_id=?",
    [user_id]
  );

  if (!wallet || wallet.balance < amount) {
    return res.json({ error: "Insufficient balance" });
  }

  const fee = amount * 0.1;
  const final = amount - fee;

  await query(UPDATE wallet SET balance=balance-? WHERE user_id=?,
    [amount, user_id]);

  await query(`
    INSERT INTO withdrawals (user_id,amount,fee,final_amount,status)
    VALUES (?,?,?,?, 'pending')
  `, [user_id, amount, fee, final]);

  res.json({ success: true });
});

/* ================= ADMIN ================= */

app.get("/admin/users", adminAuth, async (req, res) => {
  const users = await query("SELECT * FROM users ORDER BY id DESC");
  res.json(users);
});

app.get("/admin/payments", adminAuth, async (req, res) => {
  const payments = await query("SELECT * FROM payments ORDER BY id DESC");
  res.json(payments);
});

app.get("/admin/withdrawals", adminAuth, async (req, res) => {
  const data = await query("SELECT * FROM withdrawals ORDER BY id DESC");
  res.json(data);
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});