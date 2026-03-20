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
  const PRIVATE_KEY = process.env.PRIVATE_KEY;

  // If no private key set, handle without encryption (for preview/testing)
  if (!PRIVATE_KEY) {
    console.log("⚠️  No private key found, running without encryption");
    const payload = req.body?.data || req.body;
    return handlePayload(payload, res);
  }

  try {
    // Decrypt the incoming request
    const { decryptedBody, aesKey, initialVector } = decryptRequest(
      req.body,
      PRIVATE_KEY
    );

    console.log("Decrypted body:", JSON.stringify(decryptedBody));

    const payload = decryptedBody.data || decryptedBody;

    // Build response
    const responseData = buildResponse(payload);

    if (!responseData) {
      return res.status(400).json({ error: "Unknown action" });
    }

    // Encrypt and send response
    const encryptedResponse = encryptResponse(
      responseData,
      aesKey,
      initialVector
    );

    return res.send(encryptedResponse);

  } catch (error) {
    console.error("❌ Error processing request:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Build Response Based on Action ────────────────────────
function buildResponse(payload) {
  const { action, amount, tenure } = payload;

  if (action === "calculate") {
    // Validate
    if (!amount || !tenure) {
      return null;
    }

    if (!rateMap[tenure]) {
      return null;
    }

    const calc = calculateMaturity(amount, tenure);

    return {
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
    };
  }

  if (action === "confirm") {
    return {
      version: "7.3",
      screen: "COMPLETE",
      data: {}
    };
  }

  return null;
}

// ─── Handle Payload (Unencrypted) ───────────────────────────
function handlePayload(payload, res) {
  const response = buildResponse(payload);

  if (!response) {
    return res.status(400).json({ error: "Unknown action or missing fields" });
  }

  return res.json(response);
}

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/`);
  console.log(`📍 Test endpoint: http://localhost:${PORT}/test`);
  console.log(`📍 Flow endpoint: http://localhost:${PORT}/whatsapp-flow`);
});
