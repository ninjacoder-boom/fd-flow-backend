const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// ─── Rate Map ───────────────────────────────────────────────
const rateMap = {
  months12: { rate: 6.0,  months: 12 },
  months24: { rate: 6.5,  months: 24 },
  months36: { rate: 7.0,  months: 36 },
  months48: { rate: 7.5,  months: 48 }
};

// ─── Helper: Calculate Maturity ─────────────────────────────
function calculateMaturity(amount, tenureKey) {
  const principal = parseFloat(amount);
  const { rate, months } = rateMap[tenureKey];
  const years = months / 12;

  // Simple Interest: SI = (P × R × T) / 100
  const interest = (principal * rate * years) / 100;
  const maturityAmount = principal + interest;

  // Maturity Date
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  const day   = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year  = date.getFullYear();
  const maturityDate = `${day}-${month}-${year}`;

  return {
    principal,
    rate,
    months,
    interest: Math.round(interest),
    maturityAmount: Math.round(maturityAmount),
    maturityDate
  };
}

// ─── Helper: Format Indian Currency ─────────────────────────
function formatINR(amount) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

// ─── Decrypt Request from WhatsApp ──────────────────────────
function decryptRequest(body, privateKeyPem) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  // Decrypt AES key using RSA private key
  const decryptedAesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(encrypted_aes_key, "base64")
  );

  // Decrypt flow data using AES key
  const iv = Buffer.from(initial_vector, "base64");
  const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);

  const encryptedData = Buffer.from(encrypted_flow_data, "base64");
  const TAG_LENGTH = 16;
  const encryptedBody = encryptedData.slice(0, -TAG_LENGTH);
  const authTag = encryptedData.slice(-TAG_LENGTH);

  decipher.setAuthTag(authTag);

  const decrypted =
    decipher.update(encryptedBody, undefined, "utf8") +
    decipher.final("utf8");

  return {
    decryptedBody: JSON.parse(decrypted),
    aesKey: decryptedAesKey,
    initialVector: iv
  };
}

// ─── Encrypt Response to WhatsApp ───────────────────────────
function encryptResponse(response, aesKey, initialVector) {
  // Flip IV as required by Meta
  const flippedIv = initialVector.map((byte) => ~byte & 0xff);

  const cipher = crypto.createCipheriv(
    "aes-128-gcm",
    aesKey,
    Buffer.from(flippedIv)
  );

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(response), "utf8"),
    cipher.final(),
    cipher.getAuthTag()
  ]);

  return encrypted.toString("base64");
}

// ─── Health Check ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ FD Flow Backend is Running!",
    routes: {
      health: "GET /",
      flow: "POST /whatsapp-flow",
      test: "POST /test"
    }
  });
});

// ─── Test Endpoint (No Encryption - For Testing Only) ───────
app.post("/test", (req, res) => {
  const payload = req.body;
  console.log("Test payload received:", JSON.stringify(payload));

  if (payload.action === "calculate") {
    const { amount, tenure } = payload;

    // Validate inputs
    if (!amount || !tenure) {
      return res.status(400).json({
        error: "Missing required fields: amount and tenure"
      });
    }

    if (!rateMap[tenure]) {
      return res.status(400).json({
        error: `Invalid tenure. Valid values: ${Object.keys(rateMap).join(", ")}`
      });
    }

    const calc = calculateMaturity(amount, tenure);

    return res.json({
      version: "7.3",
      screen: "FD_SUMMARY",
      data: {
        amount: calc.principal.toLocaleString("en-IN"),
        roi_tenure: `${calc.rate}% for ${calc.months} months`,
        interest_payout: "Payout for Maturity",
        maturity_amount: formatINR(calc.maturityAmount),
        maturity_instruction: "Reinvest",
        maturity_date: calc.maturityDate,
        debited_from: "xxxxxx6719",
        current_balance: "1,10,2221"
      }
    });
  }

  if (payload.action === "confirm") {
    return res.json({
      version: "7.3",
      screen: "COMPLETE",
      data: {}
    });
  }

  return res.status(400).json({ error: "Unknown action" });
});

// ─── Main WhatsApp Flow Endpoint (With Encryption) ──────────
app.post("/whatsapp-flow", (req, res) => {
  try {
    console.log("Incoming body:", JSON.stringify(req.body));

    // 🔐 Load private key correctly
    const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/\\n/g, "\n");

    // =========================
    // 🔒 ENCRYPTED FLOW REQUEST
    // =========================
    if (PRIVATE_KEY && req.body.encrypted_aes_key) {
      const { encrypted_aes_key, encrypted_flow_data, initial_vector } = req.body;

      // 1. Decrypt AES key
      const aesKey = crypto.privateDecrypt(
        {
          key: PRIVATE_KEY,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        Buffer.from(encrypted_aes_key, "base64")
      );

      // 2. Decrypt flow data
      const iv = Buffer.from(initial_vector, "base64");
      const encryptedData = Buffer.from(encrypted_flow_data, "base64");

      const TAG_LENGTH = 16;
      const encryptedText = encryptedData.slice(0, -TAG_LENGTH);
      const authTag = encryptedData.slice(-TAG_LENGTH);

      const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
      decipher.setAuthTag(authTag);

      const decrypted =
        decipher.update(encryptedText, null, "utf8") +
        decipher.final("utf8");

      const body = JSON.parse(decrypted);
      console.log("Decrypted body:", body);

      const payload = body.data || body;

      // 🔥 HANDLE INIT (VERY IMPORTANT)
      let response;
      if (payload.action === "INIT") {
        response = {
          version: "7.3",
          screen: "FD_HOME",
          data: {}
        };
      } else {
        response = buildResponse(payload);
      }

      if (!response) {
        return res.status(400).json({ error: "Invalid request" });
      }

      // 3. Encrypt response
      const flippedIv = Buffer.from(iv.map(b => ~b & 0xff));

      const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);

      const encryptedResponse = Buffer.concat([
        cipher.update(JSON.stringify(response), "utf8"),
        cipher.final(),
        cipher.getAuthTag()
      ]);

      res.set("Content-Type", "text/plain");
      return res.send(encryptedResponse.toString("base64"));
    }

    // =========================
    // 🧪 UNENCRYPTED (TEST MODE)
    // =========================
    const payload = req.body.data || req.body;

    console.log("Unencrypted payload:", payload);

    let response;
    if (payload.action === "INIT") {
      response = {
        version: "7.3",
        screen: "FD_HOME",
        data: {}
      };
    } else {
      response = buildResponse(payload);
    }

    if (!response) {
      return res.status(400).json({ error: "Invalid request" });
    }

    return res.json(response);

  } catch (err) {
    console.error("Flow Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/`);
  console.log(`📍 Test endpoint: http://localhost:${PORT}/test`);
  console.log(`📍 Flow endpoint: http://localhost:${PORT}/whatsapp-flow`);
});
